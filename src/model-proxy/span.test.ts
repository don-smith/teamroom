import { describe, it, expect } from "vitest";
import { newSpanId, buildSpan } from "./span.js";

describe("span helpers", () => {
  it("newSpanId returns distinct ids", () => {
    const a = newSpanId();
    const b = newSpanId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("buildSpan composes the standard envelope", () => {
    const s = buildSpan({
      event: "model.call.completed",
      traceId: "tr-1",
      spanId: "sp-1",
      agentId: "a", turnId: "t",
      extra: { latencyMs: 12, status: "ok" },
    });
    expect(s).toMatchObject({
      event: "model.call.completed",
      traceId: "tr-1", spanId: "sp-1",
      agentId: "a", turnId: "t",
      latencyMs: 12, status: "ok",
    });
  });
});
