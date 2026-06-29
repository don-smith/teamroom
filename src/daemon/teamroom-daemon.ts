import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import OpenAI from "openai";
import { composeObservability } from "../modules/observability/observability.js";
import { composeModelProxy } from "../modules/model-proxy/model-proxy.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeTeamRoomWs } from "../modules/teamroom-ws/teamroom-ws.js";
import { composeTeamRoomChat } from "../modules/teamroom-ws/teamroom-chat.js";
import { composeTelegram } from "../gateways/telegram-gateway.js";
import { loadTelegramYaml } from "../gateways/telegram-config.js";
import { writePortFile, deletePortFile } from "../cli/ports.js";
import { installSafetyNets } from "./safety-nets.js";
import { loadReposYaml, repoDataDir, REPOS_DIR } from "../daemon/repo-config.js";
import type { TokenEntry } from "../model-proxy/token-registry.js";

export interface TeamRoomDaemonOptions {
  dataDir: string;
  openrouter: { upstreamUrl: string; realKey: string; };
  telegramYamlPath: string;
  agentsDir?: string;
  daemonWsPort?: number;
  chatPort?: number;
}

export interface DaemonConnection {
  repoName: string; ws: WebSocket; mailMcpPort: number; connectedAt: string;
}

export interface StartedTeamRoomDaemon {
  stop: () => Promise<void>;
  modelProxy: {
    port: number; modelBaseUrl: string;
    mintToken: (entry: TokenEntry) => string;
  };
  routeTable: Map<string, DaemonConnection>;
  chatPort: number; daemonWsPort: number;
}

export async function startTeamRoomDaemon(opts: TeamRoomDaemonOptions): Promise<StartedTeamRoomDaemon> {
  mkdirSync(opts.dataDir, { recursive: true });

  const obs = composeObservability({ dataDir: opts.dataDir });
  installSafetyNets(obs.rootLogger);
  obs.rootLogger.info("teamroom-daemon.starting", { dataDir: opts.dataDir });

  if (!existsSync(opts.telegramYamlPath)) {
    obs.rootLogger.error("telegram.config_missing", { path: opts.telegramYamlPath });
    throw new Error(`telegram.yaml required for Team Room daemon: ${opts.telegramYamlPath}`);
  }

  let telegramConfig: ReturnType<typeof loadTelegramYaml>;
  try {
    telegramConfig = loadTelegramYaml(opts.telegramYamlPath);
    const repos = loadReposYaml().repos;
    for (const bot of telegramConfig.bots) {
      if (!repos[bot.repo]) {
        throw new Error(`telegram.yaml: unknown repo '${bot.repo}' (agent=${bot.agent})`);
      }
    }
  } catch (err) {
    obs.rootLogger.error("telegram.config_invalid", {
      path: opts.telegramYamlPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const messaging = composeMessaging({ logger: obs.rootLogger });

  const daemonSecret = randomUUID();

  const modelProxyModule = await composeModelProxy({
    logger: obs.rootLogger,
    openrouter: opts.openrouter,
    sharedSecret: daemonSecret,
  });
  writePortFile(opts.dataDir, "model-proxy", modelProxyModule.port);
  obs.rootLogger.info("model proxy started", { port: modelProxyModule.port, modelBaseUrl: modelProxyModule.modelBaseUrl });

  let telegramStop: (() => Promise<void>) | undefined;

  const teamRoomWs = composeTeamRoomWs({
    logger: obs.rootLogger, clock: obs.clock,
    tokenRegistry: modelProxyModule.tokenRegistry,
    genAdminToken: () => randomUUID(),
    daemonSecret,
    eventBus: messaging.eventBus,
  });
  const boundDaemonWsPort = await teamRoomWs.start(opts.daemonWsPort ?? 0);
  writePortFile(opts.dataDir, "daemon-ws", boundDaemonWsPort);
  obs.rootLogger.info("daemon ws listener started", { port: boundDaemonWsPort });

  const chatPort = opts.chatPort ?? 0;

  // Team Room chat server: accepts CLI client connections, routes publishes
  // to per-repo daemons via teamRoomWs.deliverToDaemon, and forwards outbound
  // mail from daemons back to CLI clients.
  //
  // If the target repo daemon is not connected, auto-spawn it by running
  // `teamroom serve --repo <name>` as a detached child.
  const teamRoomChat = composeTeamRoomChat({
    logger: obs.rootLogger,
    deliverToDaemon: async (repoName, msg) => {
      if (!teamRoomWs.routeTable.has(repoName)) {
        await ensureDaemon(repoName);
      }
      teamRoomWs.deliverToDaemon(repoName, {
        type: "deliver",
        ...msg,
      });
    },
    subscribeChannelOut: (handler) =>
      messaging.eventBus.subscribe("channel.out", handler),
    subscribeDeliveryError: (handler) =>
      messaging.eventBus.subscribe("delivery.error", handler),
  });
  const boundChatPort = await teamRoomChat.start(chatPort);
  writePortFile(opts.dataDir, "chat", boundChatPort);
  obs.rootLogger.info("chat server started", { port: boundChatPort });

  /**
   * Ensure a per-repo daemon is running and connected to the Team Room daemon.
   *
   * Checks the PID file first — if the daemon is already running, waits
   * for its reconnect (up to 15s). Otherwise spawns a detached child,
   * waits for its `register` message, then returns.
   */
  async function ensureDaemon(repoName: string): Promise<void> {
    // Validate the repo is registered.
    const yaml = loadReposYaml();
    if (!yaml.repos[repoName]) {
      throw new Error(`unknown repo: ${repoName}`);
    }

    const pidFile = join(repoDataDir(repoName), "teamroom.pid");
    let stalePid: number | null = null;

    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        process.kill(pid, 0); // signal 0 = existence check
        // Process is alive — wait for it to reconnect.
        obs.rootLogger.info("teamroom-daemon.waiting_reconnect", { repoName, pid });
        try {
          await waitForConnection(repoName, 15000);
          return;
        } catch {
          // Reconnect timed out — the daemon is stale (connected to a
          // previous Team Room daemon instance). Kill it before spawning a fresh one.
          obs.rootLogger.info("teamroom-daemon.killing_stale", { repoName, pid });
          stalePid = pid;
        }
      } catch {
        // PID file is stale — the process is already dead.
        try { unlinkSync(pidFile); } catch { /* ignore */ }
      }
    }

    // Kill the stale daemon if it didn't reconnect in time.
    if (stalePid !== null) {
      try { process.kill(stalePid, "SIGTERM"); } catch { /* already gone */ }
      try { unlinkSync(pidFile); } catch { /* ignore */ }
    }

    obs.rootLogger.info("teamroom-daemon.spawning", { repoName });

    const teamRoomWsUrl = `ws://127.0.0.1:${boundDaemonWsPort}`;
    const cliEntry = process.argv[1] ?? process.execPath;
    const child = spawn(
      process.argv[0]!,
      [cliEntry, "serve", "--repo", repoName],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, TEAMROOM_DAEMON_WS_URL: teamRoomWsUrl },
      },
    ) as ChildProcess;
    child.unref();

    try {
      await waitForConnection(repoName, 15000);
    } catch (err) {
      // Kill the spawned child so it doesn't become an orphan.
      obs.rootLogger.warn("teamroom-daemon.spawn_timeout", {
        repoName, error: err instanceof Error ? err.message : String(err),
      });
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      throw err;
    }
  }

  /**
   * Poll the route table until `repoName` appears or `timeoutMs` elapses.
   */
  async function waitForConnection(
    repoName: string,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();
    while (!teamRoomWs.routeTable.has(repoName)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout waiting for repo daemon to connect: ${repoName}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    obs.rootLogger.info("teamroom-daemon.repo_connected", {
      repoName,
      waitedMs: Date.now() - start,
    });
  }

  // --- Telegram gateway (composed after teamRoomWs + ensureDaemon so deliverInbound
  //     can resolve repos and auto-spawn per-repo daemons) ---
  {
    const openaiKey = process.env.TEAMROOM_OPENAI_API_KEY;
    if (!openaiKey) obs.rootLogger.warn("telegram: TEAMROOM_OPENAI_API_KEY not set — voice disabled");
    const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : undefined;
    const telegram = composeTelegram({
      bus: messaging.eventBus,
      deliverInbound: (msg) => {
        // Resolve agent → repo from bot config.
        const toAgent = msg.to[0]?.replace("agent:", "");
        const bot = telegramConfig.bots.find((b) => b.agent === toAgent);
        if (!bot) {
          obs.rootLogger.error("telegram.inbound.no_bot_config", { toAgent });
          return;
        }
        // Auto-spawn the per-repo daemon if not connected.
        if (!teamRoomWs.routeTable.has(bot.repo)) {
          ensureDaemon(bot.repo).catch((err) => {
            obs.rootLogger.error("telegram.inbound.spawn_failed", {
              repo: bot.repo,
              agent: toAgent,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          // Don't await — spawn is fire-and-forget; if the daemon isn't
          // ready by the time deliverToDaemon runs, it will throw and
          // the error is caught by the caller.
        }
        teamRoomWs.deliverToDaemon(bot.repo, {
          type: "deliver",
          from: msg.from,
          to: msg.to,
          body: msg.body,
          threadId: msg.threadId,
          cc: msg.cc,
        });
      },
      logger: obs.rootLogger,
      bots: telegramConfig.bots,
      genId: () => randomUUID(),
      openai,
    });
    await telegram.start();
    telegramStop = () => telegram.stop();
    obs.rootLogger.info("telegram gateway started", { botCount: telegramConfig.bots.length });
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { teamRoomWs.stop(); } catch { /* skip */ }
    try { await teamRoomChat.stop(); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "chat"); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "model-proxy"); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "daemon-ws"); } catch { /* skip */ }
    try { if (telegramStop) await telegramStop(); } catch { /* skip */ }
    try { await modelProxyModule.stop(); } catch { /* skip */ }
  };

  return {
    stop,
    modelProxy: { port: modelProxyModule.port, modelBaseUrl: modelProxyModule.modelBaseUrl, mintToken: (entry: TokenEntry) => modelProxyModule.tokenRegistry.mint(entry) },
    routeTable: teamRoomWs.routeTable as unknown as Map<string, DaemonConnection>,
    chatPort: boundChatPort, daemonWsPort: boundDaemonWsPort,
  };
}