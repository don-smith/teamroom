import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Messaging } from "../messaging/messaging.js";
import type { McpMail } from "../mcp-mail/mcp-mail.js";
import type { Storage } from "../storage/storage.js";
import type { ChannelRegistry } from "./channel-registry.js";
import type { Logger } from "../../logger/logger.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";

interface RegisteredConnection {
  channel: string;
  externalId: string;
  ws: WebSocket;
}

export interface ChatServerOpts {
  storage: Storage;
  messaging: Messaging;
  mcpMail: McpMail;
  registry: ChannelRegistry;
  logger: Logger;
  port: number;
}

export class ChatServer {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private listenPort = 0;
  private readonly connections = new Set<RegisteredConnection>();

  constructor(private readonly opts: ChatServerOpts) {}

  get port(): number {
    return this.listenPort;
  }

  async start(): Promise<void> {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Subscribe to channel.cli.out for cli-addressed outbound mail.
    // The dispatcher publishes this event (with messageId) whenever a message
    // is delivered to a channel:cli:<externalId> recipient.
    this.opts.messaging.eventBus.subscribe<{
      user: string;
      messageId: string;
      agentId: string;
      threadId: string;
    }>("channel.cli.out", (payload) => this.routeCliDelivery(payload));

    await new Promise<void>((resolve) =>
      this.http!.listen(this.opts.port, "127.0.0.1", () => resolve()),
    );
    const addr = this.http!.address();
    this.listenPort = typeof addr === "object" && addr ? addr.port : 0;
    this.opts.logger.info("chat server started", { port: this.listenPort });
  }

  async stop(): Promise<void> {
    // Close all connected sockets first so wss.close() doesn't hang.
    for (const conn of this.connections) {
      try {
        conn.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
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
    let registered: RegisteredConnection | null = null;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = parseClientMessage(raw.toString());
      } catch (err) {
        this.send(ws, {
          type: "error",
          code: "invalid_message",
          message: String(err),
        });
        return;
      }

      if (msg.type === "register") {
        if (!this.opts.registry.has(msg.channel)) {
          this.send(ws, {
            type: "error",
            code: "unknown_channel",
            message: `channel '${msg.channel}' not registered`,
          });
          return;
        }
        // Re-register replaces the prior binding for this socket.
        if (registered) this.connections.delete(registered);
        registered = { channel: msg.channel, externalId: msg.externalId, ws };
        this.connections.add(registered);
        return;
      }

      if (msg.type === "publish") {
        if (!registered) {
          this.send(ws, {
            type: "error",
            code: "not_registered",
            message: "register before publish",
          });
          return;
        }
        try {
          this.opts.mcpMail.dispatcher.sendMail({
            from: `channel:${registered.channel}:${registered.externalId}`,
            to: msg.to,
            body: msg.body,
            threadId: msg.threadId,
            cc: msg.cc.length > 0 ? msg.cc : undefined,
          });
        } catch (err) {
          this.send(ws, {
            type: "error",
            code: "dispatch_failed",
            message: String(err),
          });
        }
      }
    });

    ws.on("close", () => {
      if (registered) this.connections.delete(registered);
    });
  }

  /**
   * Routes a channel.cli.out event to the matching registered WebSocket client.
   * The dispatcher publishes this event for every message delivered to a
   * channel:cli:<externalId> recipient.
   */
  private routeCliDelivery(payload: {
    user: string;
    messageId: string;
    agentId: string;
    threadId: string;
  }): void {
    const target = [...this.connections].find(
      (c) => c.channel === "cli" && c.externalId === payload.user,
    );
    if (!target) return;

    // Look up the full message row to forward the envelope.
    const row = this.opts.storage.messageRepo.findById(payload.messageId);
    if (!row) return;

    this.send(target.ws, {
      type: "mail",
      id: row.id,
      from: row.from ?? "",
      to: row.to ?? [],
      cc: row.cc ?? [],
      body: row.body,
      threadId: row.threadId ?? payload.threadId,
      ts: row.createdAt ?? "",
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }
}
