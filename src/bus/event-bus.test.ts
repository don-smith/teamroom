import { describe, expect, it } from "bun:test";
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
    let mailDeliveredCount = 0;
    let toolCallCount = 0;
    bus.subscribe("mail.delivered", () => {
      mailDeliveredCount += 1;
    });
    bus.subscribe("tool.call", () => {
      toolCallCount += 1;
    });
    bus.publish("mail.delivered", { to: "agent:X" });
    expect(mailDeliveredCount).toBe(1);
    expect(toolCallCount).toBe(0);
  });

  it("supports multiple subscribers to the same type", () => {
    const bus = new EventBus();
    let firstCount = 0;
    let secondCount = 0;
    bus.subscribe("tool.call", () => {
      firstCount += 1;
    });
    bus.subscribe("tool.call", () => {
      secondCount += 1;
    });
    bus.publish("tool.call", { agentId: "X", tool: "mail.list" });
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });

  it("unsubscribe stops deliveries", () => {
    const bus = new EventBus();
    let callCount = 0;
    const off = bus.subscribe("tool.call", () => {
      callCount += 1;
    });
    off();
    bus.publish("tool.call", {});
    expect(callCount).toBe(0);
  });

  it("isolates a throwing subscriber — other subscribers still fire", () => {
    const logger = new CapturingLogger(new ControllableClock("2026-04-20T00:00:00.000Z"));
    const bus = new EventBus(logger);
    let goodCount = 0;
    bus.subscribe("tool.call", () => {
      throw new Error("boom");
    });
    bus.subscribe("tool.call", () => {
      goodCount += 1;
    });
    expect(() => bus.publish("tool.call", {})).not.toThrow();
    expect(goodCount).toBe(1);
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
