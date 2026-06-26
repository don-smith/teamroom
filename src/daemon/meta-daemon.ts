import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import OpenAI from "openai";
import { composeObservability } from "../modules/observability/observability.js";
import { composeModelProxy } from "../modules/model-proxy/model-proxy.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeMetaWs } from "../modules/meta-ws/meta-ws.js";
import { composeMetaChat } from "../modules/meta-ws/meta-chat.js";
import { composeTelegram } from "../gateways/telegram-gateway.js";
import { loadTelegramYaml } from "../gateways/telegram-config.js";
import { writePortFile, deletePortFile } from "../cli/ports.js";
import { installSafetyNets } from "./safety-nets.js";
import { loadReposYaml, repoDataDir, REPOS_DIR } from "../daemon/repo-config.js";
import type { TokenEntry } from "../model-proxy/token-registry.js";

export interface MetaDaemonOptions {
  dataDir: string;
  openrouter: { upstreamUrl: string; realKey: string; };
  telegramYamlPath?: string;
  agentsDir?: string;
  daemonWsPort?: number;
  chatPort?: number;
}

export interface DaemonConnection {
  repoName: string; ws: WebSocket; mailMcpPort: number; connectedAt: string;
}

export interface StartedMetaDaemon {
  stop: () => Promise<void>;
  modelProxy: {
    port: number; modelBaseUrl: string;
    mintToken: (entry: TokenEntry) => string;
  };
  routeTable: Map<string, DaemonConnection>;
  chatPort: number; daemonWsPort: number;
}

export async function startMetaDaemon(opts: MetaDaemonOptions): Promise<StartedMetaDaemon> {
  mkdirSync(opts.dataDir, { recursive: true });

  const obs = composeObservability({ dataDir: opts.dataDir });
  installSafetyNets(obs.rootLogger);
  obs.rootLogger.info("meta-daemon.starting", { dataDir: opts.dataDir });

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
  const telegramYamlPath = opts.telegramYamlPath ?? (opts.agentsDir ? join(opts.agentsDir, "..", "telegram.yaml") : undefined);
  if (telegramYamlPath && existsSync(telegramYamlPath)) {
    const telegramConfig = loadTelegramYaml(telegramYamlPath);
    const openaiKey = process.env.TEAMROOM_OPENAI_API_KEY;
    if (!openaiKey) obs.rootLogger.warn("telegram: TEAMROOM_OPENAI_API_KEY not set — voice disabled");
    const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : undefined;
    const telegram = composeTelegram({
      messageRepo: undefined as any, bus: undefined as any, dispatcher: undefined as any,
      logger: obs.rootLogger, bots: telegramConfig.bots, genId: () => randomUUID(), openai,
    });
    telegramStop = () => telegram.stop();
    obs.rootLogger.info("telegram gateway composed (activated in Phase 4)", { botCount: telegramConfig.bots.length });
  } else {
    obs.rootLogger.info("telegram gateway skipped (no telegram.yaml)");
  }

  const metaWs = composeMetaWs({
    logger: obs.rootLogger, clock: obs.clock,
    tokenRegistry: modelProxyModule.tokenRegistry,
    genAdminToken: () => randomUUID(),
    daemonSecret,
    eventBus: messaging.eventBus,
  });
  const boundDaemonWsPort = await metaWs.start(opts.daemonWsPort ?? 0);
  writePortFile(opts.dataDir, "daemon-ws", boundDaemonWsPort);
  obs.rootLogger.info("daemon ws listener started", { port: boundDaemonWsPort });

  const chatPort = opts.chatPort ?? 0;

  // Meta chat server: accepts CLI client connections, routes publishes
  // to per-repo daemons via metaWs.deliverToDaemon, and forwards outbound
  // mail from daemons back to CLI clients.
  //
  // If the target repo daemon is not connected, auto-spawn it by running
  // `teamroom serve --repo <name>` as a detached child.
  const metaChat = composeMetaChat({
    logger: obs.rootLogger,
    deliverToDaemon: async (repoName, msg) => {
      if (!metaWs.routeTable.has(repoName)) {
        await ensureDaemon(repoName);
      }
      metaWs.deliverToDaemon(repoName, {
        type: "deliver",
        ...msg,
      });
    },
    subscribeChannelOut: (handler) =>
      messaging.eventBus.subscribe("channel.out", handler),
    subscribeDeliveryError: (handler) =>
      messaging.eventBus.subscribe("delivery.error", handler),
  });
  const boundChatPort = await metaChat.start(chatPort);
  writePortFile(opts.dataDir, "chat", boundChatPort);
  obs.rootLogger.info("chat server started", { port: boundChatPort });

  /**
   * Ensure a per-repo daemon is running and connected to the meta-process.
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
        obs.rootLogger.info("meta-daemon.waiting_reconnect", { repoName, pid });
        try {
          await waitForConnection(repoName, 15000);
          return;
        } catch {
          // Reconnect timed out — the daemon is stale (connected to a
          // previous meta instance). Kill it before spawning a fresh one.
          obs.rootLogger.info("meta-daemon.killing_stale", { repoName, pid });
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

    obs.rootLogger.info("meta-daemon.spawning", { repoName });

    const metaWsUrl = `ws://127.0.0.1:${boundDaemonWsPort}`;
    const cliEntry = process.argv[1] ?? process.execPath;
    const child = spawn(
      process.argv[0]!,
      [cliEntry, "serve", "--repo", repoName],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, TEAMROOM_META_WS_URL: metaWsUrl },
      },
    ) as ChildProcess;
    child.unref();

    try {
      await waitForConnection(repoName, 15000);
    } catch (err) {
      // Kill the spawned child so it doesn't become an orphan.
      obs.rootLogger.warn("meta-daemon.spawn_timeout", {
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
    while (!metaWs.routeTable.has(repoName)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timeout waiting for repo daemon to connect: ${repoName}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    obs.rootLogger.info("meta-daemon.repo_connected", {
      repoName,
      waitedMs: Date.now() - start,
    });
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { metaWs.stop(); } catch { /* skip */ }
    try { await metaChat.stop(); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "chat"); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "model-proxy"); } catch { /* skip */ }
    try { deletePortFile(opts.dataDir, "daemon-ws"); } catch { /* skip */ }
    try { if (telegramStop) await telegramStop(); } catch { /* skip */ }
    try { await modelProxyModule.stop(); } catch { /* skip */ }
  };

  return {
    stop,
    modelProxy: { port: modelProxyModule.port, modelBaseUrl: modelProxyModule.modelBaseUrl, mintToken: (entry: TokenEntry) => modelProxyModule.tokenRegistry.mint(entry) },
    routeTable: metaWs.routeTable as unknown as Map<string, DaemonConnection>,
    chatPort: boundChatPort, daemonWsPort: boundDaemonWsPort,
  };
}