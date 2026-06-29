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
import { MailMcpServer, type MailMcpServerDeps } from "../mail-mcp/server.js";
import { realTimerFactory } from "../session-manager/session-manager.js";
import { loadListsYaml } from "../mailing-lists/loader.js";
import { connectToTeamRoom } from "../modules/teamroom-ws/repo-ws.js";
import { composeObservability } from "../modules/observability/observability.js";
import { composeStorage } from "../modules/storage/storage.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeMcpMail } from "../modules/mcp-mail/mcp-mail.js";
import { composeSessionManagement } from "../modules/session-management/session-management.js";
import { composeMail } from "../modules/mail/mail.js";
import type { TokenRegistry, TokenEntry } from "../model-proxy/token-registry.js";
import { signEntry } from "../model-proxy/token-registry.js";
import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import type { EventBus } from "../bus/event-bus.js";
import type { MailingListRegistry } from "../mailing-lists/registry.js";
import type { SessionTimerManager } from "../session-manager/session-manager.js";
import type { Storage } from "../modules/storage/storage.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../logger/logger.js";
import type { Db } from "../db/database.js";

export interface RepoDaemonOptions {
  repoName: string;
  dataDir: string;
  agentsDir: string;
  storeBasePath: string;
  codebasePath: string | null;
  modelBaseUrl: string;
  mintToken: (entry: TokenEntry) => string;
  listsYamlPath?: string;
  sessionIdleMinutes?: number;
  mailPort?: number;
  runner?: ContainerRunner;
}

export interface StartedRepoDaemon {
  db: Db;
  stop: () => Promise<void>;
  dispatcher: MailDispatcher;
  eventBus: EventBus;
  mailMcpServer: MailMcpServer;
  mailingListRegistry: MailingListRegistry;
  sessionManager: SessionTimerManager;
}

export async function startRepoDaemon(opts: RepoDaemonOptions): Promise<StartedRepoDaemon> {
  const { repoName, dataDir } = opts;

  mkdirSync(dataDir, { recursive: true });
  const pidFile = join(dataDir, "teamroom.pid");
  writeFileSync(pidFile, String(process.pid));

  const obs = composeObservability({ dataDir });
  installSafetyNets(obs.rootLogger);
  obs.rootLogger.info("repo-daemon.starting", { repoName, dataDir });

  const killed = await killStaleTeamroomContainers({ logger: obs.rootLogger });
  if (killed.length > 0) {
    obs.rootLogger.info("stale containers killed", { count: killed.length, ids: killed });
  }

  const storage = composeStorage({ dataDir });
  const agentConfigs = discoverRepoAgentConfigs(opts.agentsDir, storage, obs.rootLogger, obs.clock);

  const messaging = composeMessaging({ logger: obs.rootLogger });
  const listsPath = opts.listsYamlPath ?? join(opts.agentsDir, "..", "lists.yaml");
  const lists = existsSync(listsPath) ? loadListsYaml(listsPath) : [];
  const maxMailsPerThread = readNonNegativeIntEnv("TEAMROOM_MAX_MAILS_PER_THREAD", 40);
  const genId = () => randomUUID();
  const mcpMail = composeMcpMail({
    storage, messaging, logger: obs.rootLogger,
    clock: obs.clock, genId, agentConfigs, lists, maxMailsPerThread,
  });

  validateCodebaseRequiredRuntimes(agentConfigs, opts.codebasePath);

  let resolveMcpToken: (t: string) => string | null = () => null;
  // Mutable deps object so adminToken can be set after WS connection receives it
  // (late-binding pattern, same as resolveMcpToken above)
  const mcpDeps: MailMcpServerDeps = {
    tools: mcpMail.mcpTools,
    tokenResolver: (t) => resolveMcpToken(t),
    port: opts.mailPort ?? 0,
    logger: obs.rootLogger,
    adminToken: undefined,
  };
  const mailMcpServer = new MailMcpServer(mcpDeps);
  await mailMcpServer.start();
  const mailPort = mailMcpServer.address().port;
  writePortFile(dataDir, "mail-mcp", mailPort);
  obs.rootLogger.info("mail mcp server started", { port: mailPort });

  const remoteTokenRegistry = {
    mint: (entry: TokenEntry): string => {
      // daemonSecret is set by the onAck callback before any mail.delivered
      // event can fire (WS FIFO guarantees ack arrives before deliver).
      // If it's unset, we raced the ack — fail loudly rather than silently
      // minting an unregistered token.
      if (!daemonSecret) {
        throw new Error(
          "daemon not yet registered with Team Room daemon",
        );
      }
      return signEntry(entry, daemonSecret);
    },
  } as TokenRegistry;

  const idleMinutes = opts.sessionIdleMinutes ?? readNonNegativeIntEnv("TEAMROOM_SESSION_IDLE_MINUTES", 30);
  obs.rootLogger.info("session idle config", { idleMinutes });
  const runner = opts.runner ?? new DockerRunner();
  const sessionMgmt = composeSessionManagement({
    messaging, logger: obs.rootLogger, runner, idleMinutes,
    timerFactory: realTimerFactory,
    spec: (agentId: string, mcpToken: string): DockerRunSpec => buildSpec({
      agentId, mcpToken, agentConfigs,
      tokenRegistry: remoteTokenRegistry,
      modelBaseUrl: opts.modelBaseUrl, mailPort,
      codebasePath: opts.codebasePath, genId,
      myflowSkillsPath: null,
      storeBasePath: opts.storeBasePath,
    }),
    genToken: () => randomUUID(),
    agentConfigs,
  });
  resolveMcpToken = (t) => sessionMgmt.sessionManager.resolveToken(t);

  const busLogUnsubscribes: Array<() => void> = [];
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<Record<string, unknown>>("mail.delivered", (p) => {
      obs.rootLogger.info("mail.delivered", p);
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<Record<string, unknown>>("mail.sent", (p) => {
      obs.rootLogger.info("mail.sent", p);
    }),
  );
  busLogUnsubscribes.push(
    messaging.eventBus.subscribe<Record<string, unknown>>("tool.call", (p) => {
      obs.rootLogger.info("tool.call", p);
    }),
  );

  const mail = await composeMail({ storage, logger: obs.rootLogger, port: 0 });
  writePortFile(dataDir, "mail", mail.port);
  obs.rootLogger.info("mail query server started", { port: mail.port });

  const teamRoomWsUrl = process.env.TEAMROOM_DAEMON_WS_URL;
  let daemonSecret: string | undefined;
  const repoWsClient = teamRoomWsUrl
    ? connectToTeamRoom({
        teamRoomWsUrl, repoName: opts.repoName,
        mailMcpPort: mailPort, mailPort: mail.port,
        eventBus: messaging.eventBus, dispatcher: mcpMail.dispatcher,
        logger: obs.rootLogger,
        onAck: (info) => {
          mcpDeps.adminToken = info.adminToken;
          daemonSecret = info.daemonSecret;
        },
      })
    : null;
  if (repoWsClient) obs.rootLogger.info("repo-ws.client_started", { teamRoomWsUrl });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Each step is independently guarded so a thrown error in one step
    // does not skip remaining cleanup.
    try { for (const unsub of busLogUnsubscribes) unsub(); } catch { /* skip */ }
    busLogUnsubscribes.length = 0;
    try { if (repoWsClient) repoWsClient.close(); } catch { /* skip */ }
    try { await sessionMgmt.stop(); } catch { /* skip */ }
    try { await mail.stop(); } catch { /* skip */ }
    try { deletePortFile(dataDir, "mail"); } catch { /* skip */ }
    try { await mailMcpServer.stop(); } catch { /* skip */ }
    try { deletePortFile(dataDir, "mail-mcp"); } catch { /* skip */ }
    try { storage.close(); } catch { /* skip */ }
    try { unlinkSync(pidFile); } catch { /* best-effort */ }
  };

  return {
    db: storage.db, stop,
    dispatcher: mcpMail.dispatcher, eventBus: messaging.eventBus,
    mailMcpServer, mailingListRegistry: mcpMail.mailingListRegistry,
    sessionManager: sessionMgmt.sessionManager,
  };
}

function discoverRepoAgentConfigs(
  agentsDir: string, storage: Storage, logger: Logger, clock: Clock,
): Map<string, AgentConfig> {
  const agentConfigs = new Map<string, AgentConfig>();
  if (!existsSync(agentsDir)) return agentConfigs;
  for (const entry of readdirSync(agentsDir)) {
    const full = join(agentsDir, entry);
    if (!statSync(full).isDirectory()) continue;
    try {
      const cfg = loadAgentConfig(full, true);
      const sessionCfg = { ...cfg, lifecycle: "session" as const };
      agentConfigs.set(sessionCfg.name, sessionCfg);
      if (!storage.agentRepo.findById(cfg.name)) {
        storage.agentRepo.create({
          id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso(),
        });
      }
      logger.info("agent registered", { agentName: cfg.name });
    } catch (err) {
      logger.warn("agent registration skipped", {
        agentDir: full,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return agentConfigs;
}

function validateCodebaseRequiredRuntimes(
  agentConfigs: Map<string, AgentConfig>, codebasePath: string | null,
): void {
  if (codebasePath !== null) return;
  const requiringCodebase = Array.from(agentConfigs.values())
    .filter((cfg) => cfg.runtime === "deepagents")
    .map((cfg) => cfg.name);
  if (requiringCodebase.length === 0) return;
  throw new Error(
    `TEAMROOM_CODEBASE_PATH is required for runtime: deepagents agents (${requiringCodebase.join(", ")})`,
  );
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