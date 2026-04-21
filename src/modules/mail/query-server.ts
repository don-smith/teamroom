import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Storage } from "../storage/storage.js";
import type { Logger } from "../../logger/logger.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";

export interface QueryServerOpts {
  storage: Storage;
  logger: Logger;
  port: number;
}

export class QueryServer {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private listenPort = 0;

  constructor(private readonly opts: QueryServerOpts) {}

  get port(): number {
    return this.listenPort;
  }

  async start(): Promise<void> {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Localhost-only by design — auth lives in the channel/module-layer
    // policy, not at the network layer (M4.5 spec §External surfaces).
    await new Promise<void>((resolve) =>
      this.http!.listen(this.opts.port, "127.0.0.1", () => resolve()),
    );
    const addr = this.http!.address();
    this.listenPort = typeof addr === "object" && addr ? addr.port : 0;
    this.opts.logger.info("mail query server started", { port: this.listenPort });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      await new Promise<void>((r) => this.wss!.close(() => r()));
      this.wss = null;
    }
    if (this.http) {
      await new Promise<void>((r) => this.http!.close(() => r()));
      this.http = null;
    }
  }

  private handleConnection(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = parseClientMessage(raw.toString());
      } catch (err) {
        this.send(ws, { type: "error", id: "?", code: "invalid_message", message: String(err) });
        return;
      }
      try {
        if (msg.query === "inbox") {
          const rows = this.opts.storage.messageRepo.listInbox(msg.params.agent, { includeArchived: false });
          this.send(ws, { type: "result", id: msg.id, rows });
        } else {
          const rows = this.opts.storage.messageRepo.listThread(msg.params.id);
          this.send(ws, { type: "result", id: msg.id, rows });
        }
      } catch (err) {
        this.send(ws, { type: "error", id: msg.id, code: "query_failed", message: String(err) });
      }
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }
}
