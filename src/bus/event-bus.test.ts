import { describe, expect, it, vi } from "bun:test";
import { EventBus } from "./event-bus.js";
import { CapturingLogger } from "../logger/logger.js";
import { ControllableClock } from "../clock/clock.js";

describe("EventBus", () => {
  it("delivers published events to subscribers of matching type", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe<{ to: string }>("mail.delivered", (p) => received.push(p));
    bus.publish("mail.delivered", { to: "agent:X" });
    expect(received).toEqual([{ to: "agent:X" }]);
  });

  it("does not deliver to subscribers of other types", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("mail.delivered", a);
    bus.subscribe("tool.call", b);
    bus.publish("mail.delivered", { to: "agent:X" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers to the same type", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("tool.call", a);
    bus.subscribe("tool.call", b);
    bus.publish("tool.call", { agentId: "X", tool: "mail.list" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("unsubscribe stops deliveries", () => {
    const bus = new EventBus();
    const h = vi.fn();
    const off = bus.subscribe("tool.call", h);
    off();
    bus.publish("tool.call", {});
    expect(h).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber — other subscribers still fire", () => {
    const logger = new CapturingLogger(new ControllableClock("2026-04-20T00:00:00.000Z"));
    const bus = new EventBus(logger);
    const good = vi.fn();
    bus.subscribe("tool.call", () => {
      throw new Error("boom");
    });
    bus.subscribe("tool.call", good);
    expect(() => bus.publish("tool.call", {})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
    expect(logger.entries.some((e) => e.msg === "event-bus.handler.error")).toBe(true);
  });

  it("a handler that unsubscribes during delivery doesn't skip peers", () => {
    const bus = new EventBus();
    const order: string[] = [];
    const offA = bus.subscribe("e", () => {
      order.push("a");
      offA();
    });
    bus.subscribe("e", () => order.push("b"));
    bus.publish("e", {});
    expect(order).toEqual(["a", "b"]);
  });

  it("publishing to a type with no subscribers is a no-op", () => {
    const bus = new EventBus();
    expect(() => bus.publish("nobody.listens", {})).not.toThrow();
  });
});
