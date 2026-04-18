import { describe, expect, it } from "vitest";
import type { Agent, Message, Turn, BusEvent } from "./types.js";

describe("shared types", () => {
  it("compiles with all expected fields", () => {
    const agent: Agent = {
      id: "assistant",
      configPath: "/abs/path/agents/assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const message: Message = {
      id: "msg-1",
      agentId: "assistant",
      channel: "cli",
      direction: "in",
      body: "hi",
      turnId: null,
      traceId: "trace-1",
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const turn: Turn = {
      id: "turn-1",
      agentId: "assistant",
      inboundMessageId: "msg-1",
      status: "pending",
      containerId: null,
      error: null,
      traceId: "trace-1",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const event: BusEvent = {
      id: "evt-1",
      type: "message.outbound",
      ts: "2026-04-18T00:00:00.000Z",
    };

    expect(agent.id).toBe("assistant");
    expect(message.direction).toBe("in");
    expect(turn.status).toBe("pending");
    expect(event.type).toBe("message.outbound");
  });
});
