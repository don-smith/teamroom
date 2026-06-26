import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { EventBus } from "../../bus/event-bus.js";
import { ControllableClock } from "../../clock/clock.js";
import { CapturingLogger } from "../../logger/logger.js";
import type { MailDispatcher } from "../../mail-dispatcher/mail-dispatcher.js";
import { connectToMeta } from "./repo-ws.js";

describe("repo-ws", () => {
  test("reports deliver failures back to meta as delivery_error events", async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    let clientSocket: WebSocket | null = null;
    const deliveryErrors: Record<string, unknown>[] = [];
    wss.on("connection", (ws: WebSocket) => {
      clientSocket = ws;
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "register") {
          ws.send(JSON.stringify({
            type: "ack",
            repoName: "teamroom",
            adminToken: "admin-token",
            daemonSecret: "daemon-secret",
          }));
          ws.send(JSON.stringify({
            type: "deliver",
            from: "channel:cli:don",
            to: ["agent:missing"],
            body: "hello",
            threadId: "thread-1",
            cc: [],
          }));
        }
        if (msg.type === "event" && msg.event === "delivery_error") {
          deliveryErrors.push(msg);
        }
      });
    });

    const dispatcher = {
      sendMail: () => {
        throw new Error("unknown recipient: agent:missing");
      },
    } as unknown as MailDispatcher;

    const client = connectToMeta({
      metaWsUrl: `ws://127.0.0.1:${port}`,
      repoName: "teamroom",
      mailMcpPort: 1111,
      mailPort: 2222,
      eventBus: new EventBus(),
      dispatcher,
      logger: new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z")),
    });

    try {
      await waitFor(() => deliveryErrors.length > 0);
      const msg = deliveryErrors[0]!;
      expect(msg).toMatchObject({ type: "event", event: "delivery_error" });
      expect(msg.payload).toMatchObject({
        repoName: "teamroom",
        target: "channel:cli:don",
        from: "channel:cli:don",
        to: ["agent:missing"],
        threadId: "thread-1",
        error: "unknown recipient: agent:missing",
      });
    } finally {
      client.close();
      clientSocket?.terminate();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      httpServer.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
