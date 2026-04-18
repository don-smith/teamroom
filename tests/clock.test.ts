import { describe, expect, it } from "vitest";
import { SystemClock, ControllableClock } from "../src/clock/clock.js";

describe("SystemClock", () => {
  it("returns a valid ISO timestamp near Date.now()", () => {
    const before = Date.now();
    const iso = new SystemClock().nowIso();
    const after = Date.now();
    const parsed = Date.parse(iso);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("returns numeric epoch ms", () => {
    const before = Date.now();
    const ms = new SystemClock().nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

describe("ControllableClock", () => {
  it("returns the initial time until advanced", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-04-18T00:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-04-18T00:00:00.000Z"));
  });

  it("advances by the given milliseconds", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.nowIso()).toBe("2026-04-18T00:00:01.500Z");
  });
});
