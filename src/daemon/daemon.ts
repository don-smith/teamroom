import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
import type { DockerRunSpec } from "../container/docker-command.js";
import { killStaleTeamroomContainers } from "../container/kill-stale.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
import { reconcile } from "./reconcile.js";
import { Orchestrator } from "./orchestrator.js";
import { buildSpec } from "../agent-spec/build-spec.js";
import { writePortFile, deletePortFile } from "../cli/ports.js";
import { MailMcpServer } from "../mail-mcp/server.js";
import { realTimerFactory } from "../session-manager/session-manager.js";
import { loadListsYaml } from "../mailing-lists/loader.js";
import { composeObservability } from "../modules/observability/observability.js";
import { composeStorage } from "../modules/storage/storage.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeMcpMail } from "../modules/mcp-mail/mcp-mail.js";
import { composeModelProxy } from "../modules/model-proxy/model-proxy.js";
import { composeSessionManagement } from "../modules/session-management/session-management.js";
import { composeChannels } from "../modules/channels/channels.js";
import { composeMail } from "../modules/mail/mail.js";
import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import type { EventBus } from "../bus/event-bus.js";
import type { MailingListRegistry } from "../mailing-lists/registry.js";
import type { SessionTimerManager } from "../session-manager/session-manager.js";
import type { Storage } from "../modules/storage/storage.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../logger/logger.js";
import type { Db } from "../db/database.js";

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
  /** Path to `lists.yaml`. Defaults to <agentsDir>/../lists.yaml. */
  listsYamlPath?: string;
  lmStudio: {
    upstreamUrl: string; // container-side URL, e.g. http://host.docker.internal:1234
    realKey: string;     // bearer token for the upstream LM Studio endpoint
  };
  anthropic: AnthropicCreds | null;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Port to bind the mail MCP HTTP server. 0 = ephemeral. */
  mailPort?: number;
  /**
   * Minutes of inactivity before the session manager closes an agent
   * container's stdin (prompting clean exit). 0 disables the timer.
   * Also reads TEAMROOM_SESSION_IDLE_MINUTES if unset.
   */
  sessionIdleMinutes?: number;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
  dispatcher: MailDispatcher;
  eventBus: EventBus;
  mailMcpServer: MailMcpServer;
  mailingListRegistry: MailingListRegistry;
  sessionManager: SessionTimerManager;
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  // --- 1. FS setup + PID file ---
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "bus"), { recursive: true }); // FileNotifyBus — removed in Plan Task 33
  const pidFile = join(opts.dataDir, "teamroom.pid");
  writeFileSync(pidFile, String(process.pid));

  // --- 2. Observability (clock, logger) ---
  const obs = composeObservability({ dataDir: opts.dataDir });
  installSafetyNets(obs.rootLogger);

  // --- 3. Stale-container cleanup ---
  const killed = await killStaleTeamroomContainers({ logger: obs.rootLogger });
  if (killed.length > 0) {
    obs.rootLogger.info("stale containers killed", { count: killed.length, ids: killed });
  }

  // --- 4. Storage + agent discovery ---
  const storage = composeStorage({ dataDir: opts.dataDir });
  const agentConfigs = discoverAgentConfigs(opts.agentsDir, storage, obs.rootLogger, obs.clock);

  // --- 5. Messaging + mcp-mail ---
  const messaging = composeMessaging({ logger: obs.rootLogger });
  const listsPath = opts.listsYamlPath ?? join(opts.agentsDir, "..", "lists.yaml");
  const lists = existsSync(listsPath) ? loadListsYaml(listsPath) : [];
  const maxMailsPerThread = readNonNegativeIntEnv("TEAMROOM_MAX_MAILS_PER_THREAD", 10);
  const genId = () => randomUUID();
  const mcpMail = composeMcpMail({
    storage, messaging, logger: obs.rootLogger,
    clock: obs.clock,
    genId,
    agentConfigs,
    lists,
    maxMailsPerThread,
  });

  // --- 7. Model proxy ---
  const modelProxy = await composeModelProxy({
    logger: obs.rootLogger,
    lmStudio: opts.lmStudio,
    anthropic: opts.anthropic,
  });

  // --- 8. Codebase-mount resolution ---
  const codebasePath = resolveCodebasePath(opts.dataDir, obs.rootLogger);

  // --- 9. Mail MCP server (with late-bound token resolver) ---
  let resolveMcpToken: (t: string) => string | null = () => null;
  const mailMcpServer = new MailMcpServer({
    tools: mcpMail.mcpTools,
    tokenResolver: (t) => resolveMcpToken(t),
    port: opts.mailPort ?? 0,
    logger: obs.rootLogger,
  });
  await mailMcpServer.start();
  const { port: mailPort } = mailMcpServer.address();
  writePortFile(opts.dataDir, "mail-mcp", mailPort);
  obs.rootLogger.info("mail mcp server started", { port: mailPort });

  // --- 10. Session management ---
  const idleMinutes = opts.sessionIdleMinutes ?? readNonNegativeIntEnv("TEAMROOM_SESSION_IDLE_MINUTES", 30);
  const runner = new DockerRunner();
  const sessionMgmt = composeSessionManagement({
    messaging,
    logger: obs.rootLogger,
    runner,
    idleMinutes,
    timerFactory: realTimerFactory,
    spec: (agentId: string, mcpToken: string): DockerRunSpec => buildSpec({
      agentId, mcpToken, agentConfigs,
      tokenRegistry: modelProxy.tokenRegistry,
      modelBaseUrl: modelProxy.modelBaseUrl,
      mailPort,
      codebasePath,
      genId,
    }),
    genToken: () => randomUUID(),
  });
  resolveMcpToken = (t) => sessionMgmt.sessionManager.resolveToken(t);

  // --- 11. Channels (chat WebSocket on its own port) ---
  const channels = await composeChannels({
    storage,
    messaging,
    mcpMail,
    logger: obs.rootLogger,
    port: 0,
  });
  writePortFile(opts.dataDir, "chat", channels.port);
  obs.rootLogger.info("chat server started", { port: channels.port });

  // --- 12. Mail query server (read-only WebSocket on its own port) ---
  const mail = await composeMail({
    storage,
    logger: obs.rootLogger,
    port: 0,
  });
  writePortFile(opts.dataDir, "mail", mail.port);
  obs.rootLogger.info("mail query server started", { port: mail.port });

  // --- 13. Legacy CLI path (removed in Plan Task 33) ---
  const notifyBus = new FileNotifyBus(join(opts.dataDir, "bus"));
  messaging.eventBus.subscribe<{ messageId: string; agentId: string; threadId: string }>(
    "channel.cli.out", (p) => {
      void notifyBus.publish({
        id: genId(), type: "message.outbound", ts: obs.clock.nowIso(),
        agentId: p.agentId, messageId: p.messageId, turnId: "", traceId: p.messageId,
      });
    },
  );
  await reconcile({ turnRepo: storage.turnRepo, bus: notifyBus, logger: obs.rootLogger, clock: obs.clock, genId });
  const orchestrator = new Orchestrator({
    messageRepo: storage.messageRepo,
    turnRepo: storage.turnRepo,
    bus: notifyBus,
    logger: obs.rootLogger,
    clock: obs.clock,
    runner,
    agentConfigs,
    modelProxy: modelProxy.modelProxy,
    modelBaseUrl: modelProxy.modelBaseUrl,
    anthropicAdapterPresent: modelProxy.anthropicAdapterPresent,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
    codebasePath,
  });
  const loopPromise = orchestrator.runLoop().catch((err) => {
    obs.rootLogger.fatal("orchestrator loop exited abnormally (daemon does not exit)", { error: String(err) });
  });

  // --- 14. Stop orchestration ---
  // Ingress-first: shut off external-facing surfaces (channels, mail-MCP)
  // before their dependencies (model proxy, storage) close. Any late-arriving
  // inbound can't land in a half-torn-down substrate.
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    orchestrator.stop();
    await sessionMgmt.stop();
    await loopPromise;
    await channels.stop();
    deletePortFile(opts.dataDir, "chat");
    await mail.stop();
    deletePortFile(opts.dataDir, "mail");
    await mailMcpServer.stop();
    deletePortFile(opts.dataDir, "mail-mcp");
    await modelProxy.stop();
    await notifyBus.close();
    storage.close();
    try { unlinkSync(pidFile); } catch { /* best-effort */ }
  };

  return {
    db: storage.db,
    stop,
    orchestrator,
    dispatcher: mcpMail.dispatcher,
    eventBus: messaging.eventBus,
    mailMcpServer,
    mailingListRegistry: mcpMail.mailingListRegistry,
    sessionManager: sessionMgmt.sessionManager,
  };
}

// ---------------------------------------------------------------------------
// Private startup helpers
// ---------------------------------------------------------------------------

function discoverAgentConfigs(
  agentsDir: string,
  storage: Storage,
  logger: Logger,
  clock: Clock,
): Map<string, AgentConfig> {
  const agentConfigs = new Map<string, AgentConfig>();
  if (!existsSync(agentsDir)) return agentConfigs;
  for (const entry of readdirSync(agentsDir)) {
    const full = join(agentsDir, entry);
    if (!statSync(full).isDirectory()) continue;
    const cfg = loadAgentConfig(full);
    agentConfigs.set(cfg.name, cfg);
    if (!storage.agentRepo.findById(cfg.name)) {
      storage.agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });
    }
    logger.info("agent registered", { agentName: cfg.name });
  }
  return agentConfigs;
}

function resolveCodebasePath(dataDir: string, logger: Logger): string | null {
  const raw = process.env.TEAMROOM_CODEBASE_PATH;
  let result: string | null;
  if (raw == null || raw.trim() === "") {
    const defaultPath = join(dataDir, "..", "codebase");
    result = existsSync(defaultPath) ? defaultPath : null;
  } else {
    if (!existsSync(raw)) {
      throw new Error(`TEAMROOM_CODEBASE_PATH does not exist: ${raw}`);
    }
    result = raw;
  }
  logger.info("codebase mount", { path: result ?? "(none)" });
  return result;
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
