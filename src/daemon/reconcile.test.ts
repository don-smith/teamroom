import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { InMemoryBus } from "../bus/in-memory-bus.js";
import { ControllableClock } from "../clock/clock.js";
import { CapturingLogger } from "../logger/logger.js";
import { reconcile } from "./reconcile.js";
import type { BusEvent } from "../types.js";

function seedOrphan(
  clock: ControllableClock,
): { db: ReturnType<typeof createDatabase>; turnRepo: TurnRepo; messageRepo: MessageRepo; bus: InMemoryBus; logger: CapturingLogger } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const now = clock.nowIso();
  new AgentRepo(db).create({ id: "assistant", configPath: "/abs", createdAt: now });
  const messageRepo = new MessageRepo(db);
  messageRepo.create({
    id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
    body: "a", turnId: "t-1", traceId: "tr-1", createdAt: now,
  });
  const turnRepo = new TurnRepo(db);
  turnRepo.create({
    id: "t-1", agentId: "assistant", inboundMessageId: "m-1", status: "running",
    containerId: "c-x", error: null, traceId: "tr-1",
    startedAt: now, finishedAt: null, createdAt: now,
  });
  return { db, turnRepo, messageRepo, bus: new InMemoryBus(), logger: new CapturingLogger(clock) };
}

describe("reconcile", () => {
  it("marks running turns as errored with 'daemon_restart'", async () => {
    const clock = new ControllableClock("2026-04-18T00:00:10.000Z");
    const { turnRepo, bus, logger } = seedOrphan(clock);
    const events: BusEvent[] = [];
    (async () => {
      for await (const e of bus.subscribe()) events.push(e);
    })();

    await reconcile({ turnRepo, bus, logger, clock, genId: () => "evt-1" });

    const t = turnRepo.findById("t-1");
    expect(t?.status).toBe("error");
    expect(t?.error).toBe("daemon_restart");

    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "turn.errored")).toBe(true);
  });

  it("no-ops when nothing is running", async () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const db = createDatabase(":memory:");
    runMigrations(db);
    const turnRepo = new TurnRepo(db);
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    await reconcile({ turnRepo, bus, logger, clock, genId: () => "x" });
    // no assertion error is the test
    expect(turnRepo.findByStatus("running")).toHaveLength(0);
  });
});
