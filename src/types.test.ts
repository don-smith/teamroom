import { describe, expect, it } from "vitest";
import type { Agent, Message, Turn, BusEvent } from "./types.js";

describe("shared types", () => {
  it("compiles with all expected fields", () => {
    const agent: Agent = {
      id: "studio-assistant",
      configPath: "/abs/path/agents/studio-assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const message: Message = {
      id: "msg-1",
      agentId: "studio-assistant",
      channel: "cli",
      direction: "in",
      body: "hi",
      turnId: null,
      traceId: "trace-1",
      createdAt: "2026-04-18T00:00:00.000Z",
      topic: "",
      fromAgentId: null,
      conversationId: null,
      to: [],
      from: null,
      cc: null,
      subject: null,
      threadId: null,
      readAt: null,
      archivedAt: null,
      deletedAt: null,
    };

    const turn: Turn = {
      id: "turn-1",
      agentId: "studio-assistant",
      inboundMessageId: "msg-1",
      status: "pending",
      containerId: null,
      error: null,
      traceId: "trace-1",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
      conversationId: null,
    };

    const event: BusEvent = {
      id: "evt-1",
      type: "message.outbound",
      ts: "2026-04-18T00:00:00.000Z",
    };

    expect(agent.id).toBe("studio-assistant");
    expect(message.direction).toBe("in");
    expect(turn.status).toBe("pending");
    expect(event.type).toBe("message.outbound");
  });
});
