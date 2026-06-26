import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../../logger/logger.js";

/**
 * Meta-process chat WebSocket server.
 *
 * Accepts connections from CLI clients and routes publishes to per-repo
 * daemons via deliverToDaemon. Receives channel.out events from the meta
 * event bus (republished from per-repo daemon outbound messages) and
 * forwards them as `mail` frames to matching CLI clients.
 *
 * Unlike the per-repo daemon's ChatServer, this server has no DB access —
 * body/from/threadId all flow through the channel.out event payload.
 */

interface RegisteredConnection {
  channel: string;
  externalId: string;
  ws: WebSocket;
}

/**
 * Client→Meta messages extend the base chat protocol with a `repo` field
 * on register so the meta-process knows which per-repo daemon to target.
 */
type MetaClientMessage =
  | { type: "register"; channel: string; externalId: string; repo: string }
  | { type: "publish"; to: string[]; body: string; threadId: string | null; cc: string[] };

function parseMetaClientMessage(raw: string): MetaClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid client message: malformed JSON (${String(err)})`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string"
  ) {
    throw new Error("invalid client message: missing type");
  }
  const p = parsed as Record<string, unknown>;
  if (p.type === "register") {
    if (
      typeof p.channel !== "string" ||
      typeof p.externalId !== "string" ||
      typeof p.repo !== "string"
    ) {
      throw new Error(
        "register: channel, externalId, and repo are required strings",
      );
    }
    return {
      type: "register",
      channel: p.channel,
      externalId: p.externalId,
      repo: p.repo,
    };
  }
  if (p.type === "publish") {
    if (!Array.isArray(p.to) || typeof p.body !== "string") {
      throw new Error(
        "publish: to (array of strings) and body (string) are required",
      );
    }
    for (const t of p.to) {
      if (typeof t !== "string") {
        throw new Error("publish: to[] elements must be strings");
      }
    }
    let cc: string[] = [];
    if (Array.isArray(p.cc)) {
      for (const c of p.cc) {
        if (typeof c !== "string") {
          throw new Error("publish: cc[] elements must be strings");
        }
      }
      cc = p.cc as string[];
    }
    return {
      type: "publish",
      to: p.to as string[],
      body: p.body,
      threadId: typeof p.threadId === "string" ? p.threadId : null,
      cc,
    };
  }
  throw new Error(`unknown client message type: ${String(p.type)}`);
}

export interface MetaChatServerDeps {
  logger: Logger;
  /**
   * Deliver a publish payload to a per-repo daemon via its MCP endpoint.
   * The meta-process bakes in auth (adminToken) before calling the
   * transport layer — callers don't see tokens.
   */
  deliverToDaemon: (
    repoName: string,
    msg: {
      from: string;
      to: string[];
      body: string;
      threadId: string | null;
      cc: string[];
    },
  ) => Promise<void>;
  /**
   * Subscribe to channel.out events on the meta event bus.
   * Returns an unsubscribe function.
   */
  subscribeChannelOut: (
    handler: (payload: Record<string, unknown>) => void,
  ) => () => void;
  /**
   * Subscribe to delivery.error events on the meta event bus.
   * Used to surface per-repo delivery failures back to the CLI client
   * that originated the failed publish, when that origin is a CLI channel.
   */
  subscribeDeliveryError: (
    handler: (payload: Record<string, unknown>) => void,
  ) => () => void;
}

export interface MetaChatServer {
  start(port: number): Promise<number>;
  stop(): Promise<void>;
}

export function composeMetaChat(deps: MetaChatServerDeps): MetaChatServer {
  const connections = new Set<RegisteredConnection>();
  let httpServer: ReturnType<typeof createServer> | null = null;
  let wss: WebSocketServer | null = null;
  const unsubscribes: Array<() => void> = [];

  const server: MetaChatServer = {
    async start(port: number): Promise<number> {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });

      // Subscribe to channel.out on the meta event bus so we can forward
      // outbound mail from per-repo daemons to CLI clients.
      unsubscribes.push(
        deps.subscribeChannelOut((payload) => {
          const channel = payload.channel as string | undefined;
          if (channel && channel !== "cli") return;
          routeCliDelivery(payload);
        }),
      );
      unsubscribes.push(
        deps.subscribeDeliveryError((payload) => {
          routeCliDeliveryError(payload);
        }),
      );

      wss.on("connection", (ws: WebSocket) => {
        let registered: RegisteredConnection | null = null;
        let repoName: string | null = null;

        ws.on("message", (raw: Buffer) => {
          let msg: MetaClientMessage;
          try {
            msg = parseMetaClientMessage(raw.toString("utf8"));
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "invalid_message",
                message: String(err),
              }),
            );
            return;
          }

          if (msg.type === "register") {
            repoName = msg.repo;
            // Re-register replaces prior binding for this socket.
            if (registered) connections.delete(registered);
            registered = {
              channel: msg.channel,
              externalId: msg.externalId,
              ws: ws as unknown as WebSocket,
            };
            connections.add(registered);
            deps.logger.info("meta-chat.client_registered", {
              channel: msg.channel,
              externalId: msg.externalId,
              repo: msg.repo,
            });
            return;
          }

          if (msg.type === "publish") {
            if (!registered || !repoName) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "not_registered",
                  message: "register before publish",
                }),
              );
              return;
            }
            deps
              .deliverToDaemon(repoName, {
                from: `channel:${registered.channel}:${registered.externalId}`,
                to: msg.to,
                body: msg.body,
                threadId: msg.threadId,
                cc: msg.cc,
              })
              .catch((err) => {
                deps.logger.error("meta-chat.delivery_failed", {
                  repo: repoName,
                  error:
                    err instanceof Error ? err.message : String(err),
                });
                ws.send(
                  JSON.stringify({
                    type: "error",
                    code: "dispatch_failed",
                    message: String(err),
                  }),
                );
              });
          }
        });

        ws.on("close", () => {
          if (registered) connections.delete(registered);
        });

        ws.on("error", () => {
          if (registered) connections.delete(registered);
        });
      });

      return await new Promise<number>((resolve, reject) => {
        httpServer!.once("error", reject);
        httpServer!.listen(port, "127.0.0.1", () => {
          httpServer!.removeListener("error", reject);
          resolve((httpServer!.address() as { port: number }).port);
        });
      });
    },

    async stop(): Promise<void> {
      for (const unsubscribe of unsubscribes.splice(0)) {
        unsubscribe();
      }
      for (const conn of connections) {
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
      if (wss) {
        await new Promise<void>((r) => wss!.close(() => r()));
        wss = null;
      }
      if (httpServer) {
        await new Promise<void>((r) => httpServer!.close(() => r()));
        httpServer = null;
      }
    },
  };

  function routeCliDelivery(payload: Record<string, unknown>): void {
    const user = payload.user as string | undefined;
    if (!user) return;
    const target = findCliConnection(user);
    if (!target) return;

    // No DB lookup — body/from/threadId flow through the channel.out
    // event payload (see the body-gap fix in mail-dispatcher + repo-ws
    // + meta-ws).
    target.ws.send(
      JSON.stringify({
        type: "mail",
        id: (payload.messageId as string) ?? "",
        from: (payload.from as string) ?? "",
        to: (payload.to as string[]) ?? [],
        cc: [],
        body: (payload.body as string) ?? "",
        threadId: (payload.threadId as string) ?? "",
        ts: new Date().toISOString(),
      }),
    );
  }

  function routeCliDeliveryError(payload: Record<string, unknown>): void {
    const address =
      typeof payload.target === "string"
        ? payload.target
        : typeof payload.from === "string"
          ? payload.from
          : null;
    const user = address ? cliUserFromAddress(address) : null;
    if (!user) return;
    const target = findCliConnection(user);
    if (!target) return;
    target.ws.send(
      JSON.stringify({
        type: "error",
        code: "delivery_failed",
        message: typeof payload.error === "string" ? payload.error : "delivery failed",
      }),
    );
  }

  function findCliConnection(user: string): RegisteredConnection | undefined {
    return [...connections].find(
      (c) => c.channel === "cli" && c.externalId === user,
    );
  }

  function cliUserFromAddress(address: string): string | null {
    const prefix = "channel:cli:";
    return address.startsWith(prefix) ? address.slice(prefix.length) : null;
  }

  return server;
}