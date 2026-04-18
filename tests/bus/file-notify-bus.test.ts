import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNotifyBus } from "../../src/bus/file-notify-bus.js";
import type { BusEvent } from "../../src/types.js";

function evt(id: string, type: string): BusEvent {
  return { id, type, ts: "2026-04-18T00:00:00.000Z" };
}

describe("FileNotifyBus", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-bus-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers events published after subscribe starts", async () => {
    const bus = new FileNotifyBus(dir);
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
    await bus.close();

    expect(received.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("deduplicates events that re-appear in the log", async () => {
    const bus = new FileNotifyBus(dir);
    const received: BusEvent[] = [];
    const iter = bus.subscribe();
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await reader;

    // simulate a re-read: publish same id again — subscriber should already have seen it
    await bus.publish(evt("1", "a"));
    await bus.close();
    expect(received.map((e) => e.id)).toEqual(["1"]);
  });

  it("applies a filter", async () => {
    const bus = new FileNotifyBus(dir);
    const received: BusEvent[] = [];
    const iter = bus.subscribe((e) => e.type === "keep");
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "drop"));
    await bus.publish(evt("2", "keep"));
    await reader;
    await bus.close();

    expect(received.map((e) => e.id)).toEqual(["2"]);
  });
});
