import { describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { CapturingLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import { composeMetaChat } from "./meta-chat.js";

describe("meta-chat", () => {
  test("routes delivery.error events to the originating CLI connection", async () => {
    let deliveryErrorHandler: ((payload: Record<string, unknown>) => void) | null = null;
    const logger = new CapturingLogger(new ControllableClock("2026-06-23T00:00:00.000Z"));
    const chat = composeMetaChat({
      logger,
      deliverToDaemon: async () => {},
      subscribeChannelOut: () => () => {},
      subscribeDeliveryError: (handler: (payload: Record<string, unknown>) => void) => {
        deliveryErrorHandler = handler;
        return () => {};
      },
    });
    const port = await chat.start(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const frames: Record<string, unknown>[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.on("message", (raw: Buffer) => {
        frames.push(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      });
      ws.send(JSON.stringify({
        type: "register",
        channel: "cli",
        externalId: "don",
        repo: "teamroom",
      }));

      await waitFor(() => deliveryErrorHandler !== null);
      await waitFor(() => logger.entries.some((entry) => entry.msg === "meta-chat.client_registered"));
      deliveryErrorHandler!({
        repoName: "teamroom",
        target: "channel:cli:don",
        from: "channel:cli:don",
        to: ["agent:missing"],
        threadId: "thread-1",
        error: "unknown recipient: agent:missing",
      });

      await waitFor(() => frames.some((frame) => frame.type === "error"));
      expect(frames).toContainEqual({
        type: "error",
        code: "delivery_failed",
        message: "unknown recipient: agent:missing",
      });
    } finally {
      ws.terminate();
      await Promise.race([
        chat.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
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
