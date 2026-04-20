import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
import { killStaleTeamroomContainers } from "../container/kill-stale.js";
import { SystemClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
import { reconcile } from "./reconcile.js";
import { Orchestrator } from "./orchestrator.js";
import { AgentSubscriptionIndex, type SubscriptionIndex } from "./subscriptions.js";
import { LocalModelProxy } from "../model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../model-proxy/token-registry.js";
import type { ProviderAdapter } from "../model-proxy/adapters/adapter.js";
import { LmStudioAdapter } from "../model-proxy/adapters/lm-studio-adapter.js";
import { AnthropicAdapter } from "../model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../model-proxy/adapters/anthropic-oauth-cache.js";
import type { Provider } from "../types.js";

/**
 * Anthropic credentials. OAuth is preferred; API key is the fallback. `null` in
 * {@link DaemonOptions} means the Anthropic adapter is not configured — turns for
 * `provider: anthropic` agents will be refused (see Task 18).
 */
export type AnthropicCreds =
  | { mode: "api-key"; apiKey: string }
  | { mode: "oauth"; oauthToken: string };

export interface DaemonOptions {
  dataDir: string;   // e.g. <repo>/data
  agentsDir: string; // e.g. <repo>/agents
  lmStudio: {
    upstreamUrl: string; // container-side URL, e.g. http://host.docker.internal:1234
    realKey: string;     // bearer token for the upstream LM Studio endpoint
  };
  anthropic: AnthropicCreds | null;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
  subscriptionIndex: SubscriptionIndex;
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "bus"), { recursive: true });
  mkdirSync(join(opts.dataDir, "logs"), { recursive: true });

  const clock = new SystemClock();
  const dateStr = clock.nowIso().slice(0, 10);
  const logFile = join(opts.dataDir, "logs", `teamroom-${dateStr}.jsonl`);
  const logSink = (line: string) => {
    process.stdout.write(line + "\n");
    appendFileSync(logFile, line + "\n");
  };
  const rootLogger = new JsonLinesLogger(clock, logSink, { component: "daemon" });
  installSafetyNets(rootLogger);

  // PID file
  const pidFile = join(opts.dataDir, "teamroom.pid");
  writeFileSync(pidFile, String(process.pid));

  // Kill any stale teamroom-agent containers left behind by a prior daemon.
  // Per-agent container state isn't resumable across a daemon restart (mail
  // persistence is in the DB); clean slate keeps the session map honest.
  const killed = await killStaleTeamroomContainers({ logger: rootLogger });
  if (killed.length > 0) {
    rootLogger.info("stale containers killed", { count: killed.length, ids: killed });
  }

  const db = createDatabase(join(opts.dataDir, "teamroom.db"));
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const bus = new FileNotifyBus(join(opts.dataDir, "bus"));

  // Discover and register each agent folder under agentsDir.
  const agentConfigs = new Map<string, AgentConfig>();
  if (existsSync(opts.agentsDir)) {
    for (const entry of readdirSync(opts.agentsDir)) {
      const full = join(opts.agentsDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const cfg = loadAgentConfig(full);
      agentConfigs.set(cfg.name, cfg);
      if (!agentRepo.findById(cfg.name)) {
        agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });
      }
      rootLogger.info("agent registered", { agentName: cfg.name });
    }
  }

  const subscriptionIndex: SubscriptionIndex = new AgentSubscriptionIndex(agentConfigs);
  const totalSubs = [...agentConfigs.values()].reduce((n, c) => n + c.subscriptions.length, 0);
  rootLogger.info("subscription index built", { agents: agentConfigs.size, entries: totalSubs });

  // --- Build the model proxy ---
  const registry = new TokenRegistry();
  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    "lm-studio": new LmStudioAdapter({
      upstreamUrl: opts.lmStudio.upstreamUrl,
      realKey: opts.lmStudio.realKey,
    }),
  };
  const anthropicAdapterPresent = opts.anthropic !== null;
  if (opts.anthropic) {
    adapters.anthropic = buildAnthropicAdapter(opts.anthropic);
  }
  const modelProxy = new LocalModelProxy({
    registry,
    // Cast: LocalModelProxy expects a full Record<Provider, ProviderAdapter>
    // but handles missing adapters via a `no_adapter` rejection at request
    // time. We only populate the providers we have credentials for.
    adapters: adapters as Record<Provider, ProviderAdapter>,
    logger: rootLogger,
  });
  const proxyInfo = await modelProxy.start();
  const modelBaseUrl = `http://host.docker.internal:${proxyInfo.port}`;
  rootLogger.info("model proxy started", { port: proxyInfo.port, anthropicAdapterPresent });

  const genId = () => randomUUID();

  const maxTurnsPerConversation = (() => {
    const raw = process.env.TEAMROOM_MAX_TURNS_PER_CONVERSATION;
    if (raw == null || raw.trim() === "") return 10;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `TEAMROOM_MAX_TURNS_PER_CONVERSATION must be a non-negative integer (got '${raw}')`,
      );
    }
    return n;
  })();

  const codebasePath = (() => {
    const raw = process.env.TEAMROOM_CODEBASE_PATH;
    if (raw == null || raw.trim() === "") {
      const defaultPath = join(opts.dataDir, "..", "codebase");
      return existsSync(defaultPath) ? defaultPath : null;
    }
    if (!existsSync(raw)) {
      throw new Error(`TEAMROOM_CODEBASE_PATH does not exist: ${raw}`);
    }
    return raw;
  })();
  rootLogger.info("codebase mount", { path: codebasePath ?? "(none)" });

  await reconcile({ turnRepo, bus, logger: rootLogger, clock, genId });

  const runner = new DockerRunner();
  const orchestrator = new Orchestrator({
    messageRepo, turnRepo, bus, logger: rootLogger, clock, runner,
    agentConfigs,
    modelProxy,
    modelBaseUrl,
    anthropicAdapterPresent,
    subscriptionIndex,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    maxTurnsPerConversation,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
    codebasePath,
  });

  // Fire-and-forget loop. Errors inside the loop are logged; the loop itself never throws.
  const loopPromise = orchestrator.runLoop().catch((err) => {
    rootLogger.fatal("orchestrator loop exited abnormally (daemon does not exit)", { error: String(err) });
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    orchestrator.stop();
    await loopPromise;
    await modelProxy.stop();
    await bus.close();
    db.close();
    try { unlinkSync(pidFile); } catch { /* swallow — best-effort cleanup on the way out */ }
  };

  return { db, stop, orchestrator, subscriptionIndex };
}

function buildAnthropicAdapter(creds: AnthropicCreds): AnthropicAdapter {
  if (creds.mode === "api-key") {
    return new AnthropicAdapter({ auth: { mode: "api-key", apiKey: creds.apiKey } });
  }
  const cache = new AnthropicOAuthCache();
  return new AnthropicAdapter({
    auth: {
      mode: "oauth",
      oauthToken: creds.oauthToken,
      cache,
      exchange: directOAuthPassthrough,
    },
  });
}

/**
 * "Exchange" function that returns the OAuth token directly as the temp key.
 *
 * Background: the M2 spec (§6.2) originally described a server-to-server
 * exchange against `POST api.anthropic.com/api/oauth/claude_cli/create_api_key`
 * to trade a long-lived OAuth token for a short-lived temp API key. Reality
 * (verified via real smoke run, 2026-04): Anthropic gates that endpoint with
 * 403 for tokens issued via `claude setup-token` — see spec §6.4 and
 * docs/tabled.md "Anthropic OAuth-gating risk." However, those `sk-ant-oat01-`
 * tokens are themselves long-lived API tokens that Anthropic accepts directly
 * via `x-api-key` on `/v1/messages`. So the pragmatic resolution is: skip the
 * exchange, use the OAuth token directly. The cache then holds a single entry
 * with effectively infinite TTL (no real expiry information available; we use
 * 1 year, which is the documented validity of `claude setup-token` outputs).
 *
 * The exchange-with-cache infrastructure is preserved as-is — it remains the
 * right shape if Anthropic ever opens up a working programmatic exchange, and
 * the unit/integration tests still cover that path against fake upstreams.
 */
function directOAuthPassthrough(oauthToken: string): Promise<{ tempKey: string; expiresAt: number }> {
  return Promise.resolve({
    tempKey: oauthToken,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
  });
}

