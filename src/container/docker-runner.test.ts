import { describe, it, expect } from "bun:test";
import { parseEvent } from "./docker-runner.js";

describe("parseEvent", () => {
  it("status events: the typed 'status' classifier wins over any spread payload", () => {
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
    const evt = parseEvent("42");
    expect(evt).toEqual({ type: "unknown", raw: "42" });
  });

  it("invalid JSON returns an 'unknown' warn-classified event", () => {
    const evt = parseEvent("not json");
    expect(evt).toEqual({ type: "unknown", raw: "not json" });
  });

  it("M3 'reply' events are no longer recognized — surface as unknown", () => {
    const evt = parseEvent(JSON.stringify({ type: "reply", body: "hi" }));
    expect(evt.type).toBe("unknown");
  });

  it("M3 'dm' events are no longer recognized — surface as unknown", () => {
    const evt = parseEvent(JSON.stringify({ type: "dm", to: "x", body: "hi" }));
    expect(evt.type).toBe("unknown");
  });
});
