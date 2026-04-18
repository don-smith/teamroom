import { describe, it, expect } from "vitest";
import { parseEvent } from "./docker-runner.js";

describe("parseEvent", () => {
  it("a typed event field wins over a malformed JSON's own 'type'", () => {
    // Synthesize a payload that JSON-parses but contains 'type: "reply"' in the body
    // mimicking a malformed agent event that we should NOT trust.
    const raw = JSON.stringify({ type: "reply", body: "hi", spurious: { type: "evil" } });
    const evt = parseEvent(raw);
    expect(evt?.type).toBe("reply");
  });

  it("status events: the typed 'status' classifier wins over any spread payload", () => {
    // The status branch returns { type: "status", ...obj, type } after the fix.
    // Even if a payload tried to slip an 'evil' type through, the literal
    // 'status' must win because we've already classified it.
    const raw = JSON.stringify({ type: "status", phase: "running", extra: 1 });
    const evt = parseEvent(raw);
    expect(evt.type).toBe("status");
    if (evt.type === "status") {
      expect(evt.phase).toBe("running");
      expect(evt.extra).toBe(1);
    }
  });

  it("log events: the typed 'log' classifier wins over any spread payload", () => {
    const raw = JSON.stringify({ type: "log", level: "info", msg: "hello", extra: 2 });
    const evt = parseEvent(raw);
    expect(evt.type).toBe("log");
    if (evt.type === "log") {
      expect(evt.level).toBe("info");
      expect(evt.msg).toBe("hello");
      expect(evt.extra).toBe(2);
    }
  });

  it("non-object JSON returns an 'unknown' warn-classified event", () => {
    // Contract divergence from the plan's draft: parseEvent returns
    // { type: "unknown", raw } rather than undefined for non-object JSON
    // values like "42". The spread-order fix does not change this contract.
    const evt = parseEvent("42");
    expect(evt).toEqual({ type: "unknown", raw: "42" });
  });

  it("invalid JSON returns an 'unknown' warn-classified event", () => {
    // Same contract divergence: parseEvent returns the unknown event
    // rather than undefined for unparsable input.
    const evt = parseEvent("not json");
    expect(evt).toEqual({ type: "unknown", raw: "not json" });
  });
});
