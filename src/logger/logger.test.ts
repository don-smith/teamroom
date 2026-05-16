import { describe, expect, it } from "bun:test";
import { CapturingLogger, JsonLinesLogger } from "./logger.js";
import { ControllableClock } from "../clock/clock.js";

describe("CapturingLogger", () => {
  it("captures log entries in order", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const log = new CapturingLogger(clock);
    log.info("hello", { component: "test" });
    clock.advance(1000);
    log.error("boom", { traceId: "t-1" });
    expect(log.entries).toEqual([
      { ts: "2026-04-18T00:00:00.000Z", level: "info", msg: "hello", component: "test" },
      { ts: "2026-04-18T00:00:01.000Z", level: "error", msg: "boom", traceId: "t-1" },
    ]);
  });

  it("supports child loggers that inherit and extend fields", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const log = new CapturingLogger(clock).child({ component: "daemon", traceId: "t-1" });
    log.warn("slow", { ms: 1200 });
    const parent = (log as CapturingLogger);
    expect(parent.entries.at(-1)).toEqual({
      ts: "2026-04-18T00:00:00.000Z",
      level: "warn",
      msg: "slow",
      component: "daemon",
      traceId: "t-1",
      ms: 1200,
    });
  });
});

describe("JsonLinesLogger", () => {
  it("writes one JSON line per call to the provided sink", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const lines: string[] = [];
    const log = new JsonLinesLogger(clock, (line) => lines.push(line));
    log.info("hi", { component: "x" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual({
      ts: "2026-04-18T00:00:00.000Z",
      level: "info",
      msg: "hi",
      component: "x",
    });
  });
});
