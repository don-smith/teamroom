import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { EventBus } from "../bus/event-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
import { killStaleTeamroomContainers } from "../container/kill-stale.js";
import { SystemClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
import { reconcile } from "./reconcile.js";
import { Orchestrator } from "./orchestrator.js";
import { LocalModelProxy } from "../model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../model-proxy/token-registry.js";
import type { ProviderAdapter } from "../model-proxy/adapters/adapter.js";
import { LmStudioAdapter } from "../model-proxy/adapters/lm-studio-adapter.js";
import { AnthropicAdapter } from "../model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../model-proxy/adapters/anthropic-oauth-cache.js";
import { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import { MailingListRegistry } from "../mailing-lists/registry.js";
import { MailingListTriggerListener } from "../mailing-lists/trigger-listener.js";
import { loadListsYaml } from "../mailing-lists/loader.js";
import { CliChannelAdapter } from "../channels/cli.js";
import { MailMcpTools } from "../mail-mcp/tools.js";
import { MailMcpServer } from "../mail-mcp/server.js";
import type { Provider } from "../types.js";

/**
 * Anthropic credentials. OAuth is preferred; API key is the fallback. `null` in
 * {@link DaemonOptions} means the Anthropic adapter is not configured — turns for
 * `provider: anthropic` agents will be refused.
 */
export type AnthropicCreds =
  | { mode: "api-key"; apiKey: string }
  | { mode: "oauth"; oauthToken: string };

export interface DaemonOptions {
  dataDir: string;   // e.g. <repo>/data
  agentsDir: string; // e.g. <repo>/agents
  /** Path to `lists.yaml`. Defaults to <repoRoot>/lists.yaml (siblinging agentsDir). */
  listsYamlPath?: string;
  lmStudio: {
    upstreamUrl: string; // container-side URL, e.g. http://host.docker.internal:1234
    realKey: string;     // bearer token for the upstream LM Studio endpoint
  };
  anthropic: AnthropicCreds | null;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Port to bind the mail MCP + /cli/send HTTP server. 0 = ephemeral. */
  mailPort?: number;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
  dispatcher: MailDispatcher;
  eventBus: EventBus;
  mailMcpServer: MailMcpServer;
  mailingListRegistry: MailingListRegistry;
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
  const notifyBus = new FileNotifyBus(join(opts.dataDir, "bus"));

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

  // --- M4 mail substrate ---
  const eventBus = new EventBus(rootLogger);
  const listsPath = opts.listsYamlPath ?? join(opts.agentsDir, "..", "lists.yaml");
  const listDefs = existsSync(listsPath) ? loadListsYaml(listsPath) : [];
  const mailingListRegistry = new MailingListRegistry(listDefs, [...agentConfigs.values()]);
  rootLogger.info("mailing-list registry built", {
    lists: listDefs.length,
    triggers: mailingListRegistry.allTriggers(),
  });

  const maxMailsPerThread = readNonNegativeIntEnv("TEAMROOM_MAX_MAILS_PER_THREAD", 10);

  const genId = () => randomUUID();

  const dispatcher = new MailDispatcher({
    messageRepo,
    bus: eventBus,
    clock,
    genId,
    knownAgents: (n) => agentConfigs.has(n),
    knownLists: (n) => mailingListRegistry.has(n),
    listSubscribers: (n) => mailingListRegistry.subscribers(n),
    maxMailsPerThread,
  });

  new MailingListTriggerListener({
    bus: eventBus,
    registry: mailingListRegistry,
    dispatcher,
    formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
  });

  const cliAdapter = new CliChannelAdapter({ dispatcher });

  // The MCP server's tokenResolver will be wired up when the session
  // manager is in place (future work); for now resolve to null, which
  // makes MCP auth reject every request. /cli/send still works since it
  // has its own localhost-only trust boundary.
  const mailMcpTools = new MailMcpTools({
    messageRepo,
    dispatcher,
    bus: eventBus,
    clock,
  });
  const mailMcpServer = new MailMcpServer({
    tools: mailMcpTools,
    tokenResolver: () => null,
    cliAdapter,
    port: opts.mailPort ?? 0,
    logger: rootLogger,
  });
  await mailMcpServer.start();
  const { port: mailPort } = mailMcpServer.address();
  writeFileSync(join(opts.dataDir, "teamroom-mail.port"), String(mailPort));
  rootLogger.info("mail mcp server started", { port: mailPort });

  // --- Model proxy (M2 carryover for live LLM calls) ---
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
    adapters: adapters as Record<Provider, ProviderAdapter>,
    logger: rootLogger,
  });
  const proxyInfo = await modelProxy.start();
  const modelBaseUrl = `http://host.docker.internal:${proxyInfo.port}`;
  rootLogger.info("model proxy started", { port: proxyInfo.port, anthropicAdapterPresent });

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

  await reconcile({ turnRepo, bus: notifyBus, logger: rootLogger, clock, genId });

  const runner = new DockerRunner();
  // The orchestrator poll loop still runs for legacy CLI `channel='cli'
  // direction='in'` turns. M4 mail rows (channel='mail') are handled out
  // of band by the dispatcher/bus/session-manager chain — findPendingInbound
  // filters to `channel='cli'` explicitly so there's no double-processing.
  const orchestrator = new Orchestrator({
    messageRepo, turnRepo, bus: notifyBus, logger: rootLogger, clock, runner,
    agentConfigs,
    modelProxy,
    modelBaseUrl,
    anthropicAdapterPresent,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
    codebasePath,
  });

  const loopPromise = orchestrator.runLoop().catch((err) => {
    rootLogger.fatal("orchestrator loop exited abnormally (daemon does not exit)", { error: String(err) });
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    orchestrator.stop();
    await loopPromise;
    await mailMcpServer.stop();
    await modelProxy.stop();
    await notifyBus.close();
    db.close();
    try {
      unlinkSync(join(opts.dataDir, "teamroom-mail.port"));
    } catch {
      /* best-effort */
    }
    try { unlinkSync(pidFile); } catch { /* swallow — best-effort cleanup on the way out */ }
  };

  return { db, stop, orchestrator, dispatcher, eventBus, mailMcpServer, mailingListRegistry };
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got '${raw}')`);
  }
  return n;
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
 * See the M2 as-built / M3 as-built for background on why we skip the
 * exchange: Anthropic gates the programmatic exchange endpoint with 403
 * for `claude setup-token` issued tokens, but those tokens are themselves
 * long-lived API tokens accepted directly via `x-api-key` on `/v1/messages`.
 */
function directOAuthPassthrough(oauthToken: string): Promise<{ tempKey: string; expiresAt: number }> {
  return Promise.resolve({
    tempKey: oauthToken,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
  });
}
