import { describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { ControllableClock } from "../../clock/clock.js";
import { CapturingLogger } from "../../logger/logger.js";
import { TokenRegistry } from "../../model-proxy/token-registry.js";
import { composeTeamRoomWs } from "./teamroom-ws.js";

describe("teamroom-ws", () => {
  test("sends a distinct admin token to each registered repo daemon", async () => {
    let tokenCounter = 0;
    const manager = composeTeamRoomWs({
      logger: new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z")),
      clock: new ControllableClock("2026-06-23T00:00:00.000Z"),
      tokenRegistry: new TokenRegistry(() => "token"),
      genAdminToken: () => `admin-token-${++tokenCounter}`,
      daemonSecret: "daemon-secret",
      eventBus: { publish: () => {} },
    });
    const port = await manager.start(0);
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
      await Promise.all([waitOpen(ws1), waitOpen(ws2)]);
      const ack1 = waitForAck(ws1);
      const ack2 = waitForAck(ws2);
      ws1.send(JSON.stringify({
        type: "register",
        repoName: "teamroom",
        mailMcpPort: 1111,
        mailPort: 2222,
      }));
      ws2.send(JSON.stringify({
        type: "register",
        repoName: "myflow",
        mailMcpPort: 3333,
        mailPort: 4444,
      }));

      expect((await ack1).adminToken).not.toBe((await ack2).adminToken);
    } finally {
      ws1.terminate();
      ws2.terminate();
      await Promise.race([
        manager.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  });

  test("publishes delivery_error daemon events onto the Team Room daemon event bus", async () => {
    const published: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const manager = composeTeamRoomWs({
      logger: new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z")),
      clock: new ControllableClock("2026-06-23T00:00:00.000Z"),
      tokenRegistry: new TokenRegistry(() => "token"),
      genAdminToken: () => "admin-token",
      daemonSecret: "daemon-secret",
      eventBus: {
        publish: (event, payload) => published.push({ event, payload }),
      },
    });
    const port = await manager.start(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({
        type: "register",
        repoName: "teamroom",
        mailMcpPort: 1111,
        mailPort: 2222,
      }));
      ws.send(JSON.stringify({
        type: "event",
        event: "delivery_error",
        payload: {
          repoName: "teamroom",
          target: "channel:cli:don",
          from: "channel:cli:don",
          to: ["agent:missing"],
          threadId: "thread-1",
          error: "unknown recipient: agent:missing",
        },
      }));

      await waitFor(() => published.some((entry) => entry.event === "delivery.error"));
      expect(published).toContainEqual({
        event: "delivery.error",
        payload: {
          repoName: "teamroom",
          target: "channel:cli:don",
          from: "channel:cli:don",
          to: ["agent:missing"],
          threadId: "thread-1",
          error: "unknown recipient: agent:missing",
        },
      });
    } finally {
      ws.terminate();
      await Promise.race([
        manager.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  });

  test("parses channel from outbound target for Telegram events", async () => {
    const published: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const manager = composeTeamRoomWs({
      logger: new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z")),
      clock: new ControllableClock("2026-06-23T00:00:00.000Z"),
      tokenRegistry: new TokenRegistry(() => "token"),
      genAdminToken: () => "admin-token",
      daemonSecret: "daemon-secret",
      eventBus: {
        publish: (event, payload) => published.push({ event, payload }),
      },
    });
    const port = await manager.start(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
      await waitOpen(ws);
      ws.send(JSON.stringify({
        type: "register",
        repoName: "teamroom",
        mailMcpPort: 1111,
        mailPort: 2222,
      }));
      await waitForAck(ws);

      ws.send(JSON.stringify({
        type: "outbound",
        target: "channel:telegram:doc:12345",
        messageId: "msg-1",
        from: "doc",
        to: ["channel:telegram:doc:12345"],
        body: "hello back",
        threadId: "thread-1",
        ts: "2026-06-23T00:00:00.000Z",
      }));

      await waitFor(() => published.some((entry) => entry.event === "channel.out"));
      const channelOut = published.find((entry) => entry.event === "channel.out")!;
      expect(channelOut.payload).toMatchObject({
        channel: "telegram",
        user: "doc:12345",
        messageId: "msg-1",
        agentId: "doc",
        threadId: "thread-1",
        from: "doc",
        body: "hello back",
      });
    } finally {
      ws.terminate();
      await Promise.race([
        manager.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
  });
});

async function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function waitForAck(ws: WebSocket): Promise<{ adminToken: string }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for ack")), 500);
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (msg.type === "ack" && typeof msg.adminToken === "string") {
        clearTimeout(timeout);
        resolve({ adminToken: msg.adminToken });
      }
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
