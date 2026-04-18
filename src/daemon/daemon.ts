import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
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

  await reconcile({ turnRepo, bus, logger: rootLogger, clock, genId });

  const runner = new DockerRunner();
  const orchestrator = new Orchestrator({
    messageRepo, turnRepo, bus, logger: rootLogger, clock, runner,
    agentConfigs,
    modelProxy,
    modelBaseUrl,
    anthropicAdapterPresent,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
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

  return { db, stop, orchestrator };
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
      exchange: exchangeOAuthForTempKey,
    },
  });
}

/**
 * Trade a long-lived OAuth token for a short-lived temp key via Anthropic's
 * token exchange endpoint. The exact response shape for `expires_at` isn't
 * 100% confirmed (see M2 spec §11 risk #2) — we defensively parse number,
 * numeric-string, ISO-date, and fall back to `now + 1h` if nothing matches.
 */
function exchangeOAuthForTempKey(oauthToken: string): Promise<{ tempKey: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ grant_type: "oauth_token", token: oauthToken });
    const req = httpsRequest(
      {
        protocol: "https:",
        host: "api.anthropic.com",
        path: "/oauth/token",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            reject(new Error(`oauth exchange failed: status=${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const tempKey =
              (typeof parsed.temp_key === "string" && parsed.temp_key) ||
              (typeof parsed.access_token === "string" && parsed.access_token) ||
              (typeof parsed.token === "string" && parsed.token);
            if (!tempKey) {
              reject(new Error("oauth exchange: no temp key in response"));
              return;
            }
            const expiresAt = parseExpiresAt(parsed);
            resolve({ tempKey, expiresAt });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseExpiresAt(parsed: Record<string, unknown>): number {
  const raw = parsed.expires_at ?? parsed.expiresAt ?? parsed.expires_in;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: if it's a small number (<= ~10 years in seconds), treat as
    // "seconds from now" (expires_in semantics). Otherwise, epoch ms or
    // epoch s — assume seconds if it looks like seconds.
    if (raw < 10 * 365 * 24 * 60 * 60) return Date.now() + raw * 1000;
    if (raw < 1e12) return raw * 1000; // epoch seconds
    return raw; // epoch ms
  }
  if (typeof raw === "string") {
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) {
      if (asNum < 10 * 365 * 24 * 60 * 60) return Date.now() + asNum * 1000;
      if (asNum < 1e12) return asNum * 1000;
      return asNum;
    }
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) return asDate;
  }
  return Date.now() + 60 * 60 * 1000; // fallback: 1h
}
