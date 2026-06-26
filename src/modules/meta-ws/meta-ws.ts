import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../../logger/logger.js";
import type { Clock } from "../../clock/clock.js";
import type { TokenRegistry } from "../../model-proxy/token-registry.js";
import { parseDaemonToMeta } from "./protocol.js";
import type { DaemonToMeta, DeliverMessage } from "./protocol.js";

export interface DaemonConnection {
  repoName: string; ws: WebSocket; mailMcpPort: number; mailPort: number; connectedAt: string; adminToken: string;
}

export interface MetaWsManagerDeps {
  logger: Logger; clock: Clock; tokenRegistry: TokenRegistry;
  genAdminToken: () => string; daemonSecret: string;
  eventBus: { publish: (event: string, payload: Record<string, unknown>) => void; };
}

export interface MetaWsManager {
  routeTable: Map<string, DaemonConnection>;
  start(port: number): Promise<number>;
  stop(): Promise<void>;
  /** Send a deliver message to a per-repo daemon over its WebSocket connection. */
  deliverToDaemon(repoName: string, msg: DeliverMessage): void;
}

export function composeMetaWs(deps: MetaWsManagerDeps): MetaWsManager {
  const routeTable = new Map<string, DaemonConnection>();
  const logger = deps.logger;
  let httpServer: ReturnType<typeof createServer> | null = null;
  let wss: WebSocketServer | null = null;

  const manager: MetaWsManager = {
    routeTable,
    async start(port: number): Promise<number> {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      wss.on("connection", (ws: WebSocket) => {
        let repoName: string | null = null;
        ws.on("message", (raw: Buffer) => {
          let msg: DaemonToMeta;
          try { msg = parseDaemonToMeta(raw.toString("utf8")); } catch { logger.warn("meta-ws.invalid_message", { raw: raw.toString("utf8").slice(0, 200) }); return; }
          switch (msg.type) {
            case "register":
              repoName = msg.repoName;
              routeTable.delete(repoName);
              const adminToken = deps.genAdminToken();
              routeTable.set(repoName, { repoName, ws: ws as unknown as WebSocket, mailMcpPort: msg.mailMcpPort, mailPort: msg.mailPort, connectedAt: deps.clock.nowIso(), adminToken });
              logger.info("repo-daemon.connected", { repoName, mailMcpPort: msg.mailMcpPort });
              ws.send(JSON.stringify({ type: "ack", repoName, adminToken, daemonSecret: deps.daemonSecret }));
              break;
            case "outbound":
              logger.info("meta-daemon.outbound_relayed", { repoName, target: msg.target });
              deps.eventBus.publish("channel.out", {
                channel: "cli", user: msg.target.replace("channel:cli:", ""),
                messageId: msg.messageId, agentId: msg.from, threadId: msg.threadId, from: msg.from, to: msg.to,
                body: msg.body,
              });
              break;
            case "event":
              logger.info("meta-daemon.event_relayed", { repoName, event: msg.event });
              if (msg.event === "delivery_error") {
                deps.eventBus.publish(
                  "delivery.error",
                  typeof msg.payload === "object" && msg.payload !== null
                    ? msg.payload as Record<string, unknown>
                    : { repoName, error: String(msg.payload) },
                );
              }
              break;
          }
        });
        const onClose = () => { if (repoName) { routeTable.delete(repoName); logger.info("repo-daemon.disconnected", { repoName }); } };
        ws.on("close", onClose);
        ws.on("error", onClose);
      });
      return await new Promise<number>((resolve, reject) => {
        httpServer!.once("error", reject);
        httpServer!.listen(port, "127.0.0.1", () => { httpServer!.removeListener("error", reject); resolve((httpServer!.address() as { port: number }).port); });
      });
    },
    async stop(): Promise<void> {
      for (const [, conn] of routeTable) { try { conn.ws.close(1001, "meta-shutdown"); } catch {} }
      routeTable.clear();
      if (wss) { await new Promise<void>((r) => wss!.close(() => r())); wss = null; }
      if (httpServer) { await new Promise<void>((r) => httpServer!.close(() => r())); httpServer = null; }
    },
    deliverToDaemon(repoName: string, msg: DeliverMessage): void {
      const conn = routeTable.get(repoName);
      if (!conn) throw new Error(`no daemon connected for repo: ${repoName}`);
      logger.info("meta-ws.delivering", { repoName, to: msg.to, from: msg.from });
      conn.ws.send(JSON.stringify(msg));
    },
  };
  return manager;
}