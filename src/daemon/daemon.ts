import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DockerRunner } from "../container/docker-runner.js";
import type { DockerRunSpec } from "../container/docker-command.js";
import type { ContainerRunner } from "../container/container-runner.js";
import { killStaleTeamroomContainers } from "../container/kill-stale.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
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

export interface DaemonOptions {
  dataDir: string;   // e.g. <repo>/data
  agentsDir: string; // e.g. <repo>/agents
  /** Path to `lists.yaml`. Defaults to <agentsDir>/../lists.yaml. */
  listsYamlPath?: string;
  openrouter: {
    upstreamUrl: string; // host-side URL for the OpenRouter API
    realKey: string;
  };
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
  /**
   * Container runner. Defaults to {@link DockerRunner}. Exposed for tests
   * that need to simulate spawn failures or inspect container interactions.
   */
  runner?: ContainerRunner;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  dispatcher: MailDispatcher;
  eventBus: EventBus;
  mailMcpServer: MailMcpServer;
  mailingListRegistry: MailingListRegistry;
  sessionManager: SessionTimerManager;
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  // --- 1. FS setup + PID file ---
  mkdirSync(opts.dataDir, { recursive: true });
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
  const maxMailsPerThread = readNonNegativeIntEnv("TEAMROOM_MAX_MAILS_PER_THREAD", 40);
  const genId = () => randomUUID();
  const mcpMail = composeMcpMail({
    storage, messaging, logger: obs.rootLogger,
    clock: obs.clock,
    genId,
    agentConfigs,
    lists,
    maxMailsPerThread,
  });

  // --- 6. Telegram gateway ---
  let telegramStop: (() => Promise<void>) | undefined;
  const telegramYamlPath = opts.telegramYamlPath ?? join(opts.agentsDir, "..", "telegram.yaml");
  if (existsSync(telegramYamlPath)) {
    const telegramConfig = loadTelegramYaml(telegramYamlPath);
    // OpenAI client is created lazily — voice features fail gracefully when
    // the key is absent, but we warn at startup so operators know.
    const openaiKey = process.env.TEAMROOM_OPENAI_API_KEY;
    if (!openaiKey) {
      obs.rootLogger.warn("telegram: TEAMROOM_OPENAI_API_KEY not set — voice disabled");
    }
    const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : undefined;
    const telegram = composeTelegram({
      messageRepo: storage.messageRepo,
      bus: messaging.eventBus,
      dispatcher: mcpMail.dispatcher,
      logger: obs.rootLogger,
      bots: telegramConfig.bots,
      genId,
      openai,
    });
    await telegram.start();
    telegramStop = () => telegram.stop();
    obs.rootLogger.info("telegram gateway started", {
      botCount: telegramConfig.bots.length,
    });
  } else {
    obs.rootLogger.info("telegram gateway skipped (no telegram.yaml)");
  }

  // --- 7. Codebase-mount resolution ---
  const codebasePath = resolveCodebasePath(opts.dataDir, obs.rootLogger);
  validateCodebaseRequiredRuntimes(agentConfigs, codebasePath);

  // --- 8. Model proxy ---
  const modelProxy = await composeModelProxy({
    logger: obs.rootLogger,
    openrouter: opts.openrouter,
  });

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
  obs.rootLogger.info("session idle config", { idleMinutes });
  const runner = opts.runner ?? new DockerRunner();
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
    agentConfigs,
  });
  resolveMcpToken = (t) => sessionMgmt.sessionManager.resolveToken(t);

  // --- 10b. Observability: log mail-substrate bus events so operators can
  // see in the daemon log when agents send/receive mail and call MCP tools.
  // (composeSessionManagement consumes the same events for timer-reset; this
  // adds a parallel logging consumer with no behavioral effect.)
  const busLogUnsubscribes: Array<() => void> = [];
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{ to: string; messageId?: string; threadId?: string; replyExpected?: boolean }>("mail.delivered", (p) => {
      obs.rootLogger.info("mail.delivered", {
        to: p.to,
        messageId: p.messageId,
        threadId: p.threadId,
        replyExpected: p.replyExpected,
      });
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{ from: string }>("mail.sent", (p) => {
      obs.rootLogger.info("mail.sent", { from: p.from });
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{ agentId: string; tool: string }>("tool.call", (p) => {
      obs.rootLogger.info("tool.call", { agentId: p.agentId, tool: p.tool });
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{
      agentId: string;
      messageId?: string;
      threadId?: string;
      invalidToolCalls?: Array<{ name?: string; id?: string; error?: string }>;
    }>("agent.tool_call.invalid", (p) => {
      obs.rootLogger.warn("agent.tool_call.invalid", p);
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{
      agentId: string;
      messageId?: string;
      threadId?: string;
      reason?: string;
    }>("agent.reply_required.fallback_used", (p) => {
      obs.rootLogger.warn("agent.reply_required.fallback_used", p);
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<{ channel: string; messageId: string; agentId: string; user: string }>("channel.out", (p) => {
      obs.rootLogger.info("channel.out", {
        channel: p.channel,
        messageId: p.messageId,
        agentId: p.agentId,
        user: p.user,
      });
    }),
  );

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

  // --- 13. Stop orchestration ---
  // Ingress-first: shut off external-facing surfaces (channels, mail-MCP)
  // before their dependencies (model proxy, storage) close. Any late-arriving
  // inbound can't land in a half-torn-down substrate.
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const unsub of busLogUnsubscribes) {
      unsub();
    }
    busLogUnsubscribes.length = 0;
    await sessionMgmt.stop();
    await channels.stop();
    if (telegramStop) await telegramStop();
    deletePortFile(opts.dataDir, "chat");
    await mail.stop();
    deletePortFile(opts.dataDir, "mail");
    await mailMcpServer.stop();
    deletePortFile(opts.dataDir, "mail-mcp");
    await modelProxy.stop();
    storage.close();
    try { unlinkSync(pidFile); } catch { /* best-effort */ }
  };

  return {
    db: storage.db,
    stop,
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

function validateCodebaseRequiredRuntimes(agentConfigs: Map<string, AgentConfig>, codebasePath: string | null): void {
  if (codebasePath !== null) return;
  const requiringCodebase = Array.from(agentConfigs.values())
    .filter((cfg) => cfg.runtime === "deepagents")
    .map((cfg) => cfg.name);
  if (requiringCodebase.length === 0) return;
  throw new Error(
    `TEAMROOM_CODEBASE_PATH is required for runtime: deepagents agents (${requiringCodebase.join(", ")})`,
  );
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
