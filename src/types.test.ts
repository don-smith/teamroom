import { describe, expect, it } from "vitest";
import type { Agent, Message, BusEvent } from "./types.js";

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

    const event: BusEvent = {
      id: "evt-1",
      type: "message.outbound",
      ts: "2026-04-18T00:00:00.000Z",
    };

    expect(agent.id).toBe("studio-assistant");
    expect(message.direction).toBe("in");
    expect(event.type).toBe("message.outbound");
  });
});
