import { WebSocket } from "ws";
import type { EventBus } from "../../bus/event-bus.js";
import type { Logger } from "../../logger/logger.js";
import type { MailDispatcher } from "../../mail-dispatcher/mail-dispatcher.js";
import { parseMetaToDaemon } from "./protocol.js";
import type { MetaToDaemon } from "./protocol.js";

export interface RepoWsClientOpts {
  metaWsUrl: string; repoName: string; mailMcpPort: number; mailPort: number;
  eventBus: EventBus; dispatcher: MailDispatcher; logger: Logger;
  /** Called when the meta-process sends its ack with admin token and daemon secret. */
  onAck?: (info: { adminToken: string; daemonSecret: string }) => void;
}

export function connectToMeta(opts: RepoWsClientOpts): { close: () => void } {
  const { metaWsUrl, repoName, mailMcpPort, mailPort, eventBus, dispatcher, logger, onAck } = opts;
  let ws: WebSocket | null = null;
  let closed = false;
  let retryCount = 0;

  function connect(): void {
    if (closed) return;
    ws = new WebSocket(metaWsUrl);
    ws.on("open", () => {
      logger.info("repo-ws.connected", { repoName, metaWsUrl });
      ws!.send(JSON.stringify({ type: "register", repoName, mailMcpPort, mailPort }));
    });
    ws.on("message", (raw: Buffer) => {
      let msg: MetaToDaemon;
      try { msg = parseMetaToDaemon(raw.toString("utf8")); } catch { return; }
      switch (msg.type) {
        case "ack":
          logger.info("repo-ws.registered", { repoName });
          if (onAck) onAck({ adminToken: msg.adminToken, daemonSecret: msg.daemonSecret });
          break;
        case "deliver":
          logger.info("repo-ws.delivery_received", { repoName, to: msg.to, from: msg.from });
          try { dispatcher.sendMail({ from: msg.from, to: msg.to, cc: msg.cc, body: msg.body, threadId: msg.threadId ?? undefined }); }
          catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.error("repo-ws.delivery_failed", { repoName, error });
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "event",
                event: "delivery_error",
                payload: {
                  repoName,
                  target: msg.from,
                  from: msg.from,
                  to: msg.to,
                  threadId: msg.threadId,
                  error,
                },
              }));
            }
          }
          break;
      }
    });
    ws.on("close", () => {
      logger.warn("repo-ws.disconnected", { repoName });
      ws = null;
      if (!closed) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        retryCount++;
        logger.info("repo-ws.reconnect_scheduled", { repoName, delayMs: delay, attempt: retryCount });
        setTimeout(connect, delay);
      }
    });
    ws.on("error", (err) => {
      logger.warn("repo-ws.error", { repoName, error: err instanceof Error ? err.message : String(err) });
    });
  }

  const unsubOutbound = eventBus.subscribe<{
    user: string;
    messageId: string;
    agentId: string;
    threadId: string;
    channel: string;
    body: string;
  }>("channel.out", (payload) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn("repo-ws.drop_outbound", { repoName, reason: "not connected", target: payload.user });
      return;
    }
    const target = `channel:${payload.channel}:${payload.user}`;
    ws.send(JSON.stringify({
      type: "outbound",
      target,
      messageId: payload.messageId,
      from: payload.agentId,
      to: [target],
      body: payload.body,
      threadId: payload.threadId,
      ts: new Date().toISOString(),
    }));
  });

  connect();
  return { close: () => { closed = true; unsubOutbound(); if (ws) { ws.close(1001, "repo-shutdown"); ws = null; } } };
}