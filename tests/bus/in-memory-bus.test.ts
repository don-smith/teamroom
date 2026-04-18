import { describe, expect, it } from "vitest";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import type { BusEvent } from "../../src/types.js";

function evt(id: string, type: string): BusEvent {
  return { id, type, ts: "2026-04-18T00:00:00.000Z" };
}

describe("InMemoryBus", () => {
  it("delivers published events to a subscriber", async () => {
    const bus = new InMemoryBus();
    const received: BusEvent[] = [];
    const iter = bus.subscribe();
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 2) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await bus.publish(evt("2", "b"));
    await reader;

    expect(received.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("applies the filter predicate to delivery", async () => {
    const bus = new InMemoryBus();
    const iter = bus.subscribe((e) => e.type === "b");
    const received: BusEvent[] = [];
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await bus.publish(evt("2", "b"));
    await reader;

    expect(received.map((e) => e.id)).toEqual(["2"]);
  });

  it("close() ends all active subscriptions", async () => {
    const bus = new InMemoryBus();
    const iter = bus.subscribe();
    const run = (async () => {
      for await (const _ of iter) {
        /* consume */
      }
      return "done";
    })();
    await bus.close();
    await expect(run).resolves.toBe("done");
  });
});
