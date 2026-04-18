import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { InMemoryBus } from "../bus/in-memory-bus.js";
import { FakeRunner } from "../container/fake-runner.js";
import { ControllableClock } from "../clock/clock.js";
import { CapturingLogger } from "../logger/logger.js";
import { processTurn } from "./turn-processor.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { BusEvent, Message } from "../types.js";

function setup(): {
  db: Db;
  agentRepo: AgentRepo;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  clock: ControllableClock;
  bus: InMemoryBus;
  logger: CapturingLogger;
  inbound: Message;
  agentConfig: AgentConfig;
} {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
  const bus = new InMemoryBus();
  const logger = new CapturingLogger(clock);

  agentRepo.create({ id: "studio-assistant", configPath: "/abs", createdAt: clock.nowIso() });
  const inbound: Message = {
    id: "m-1",
    agentId: "studio-assistant",
    channel: "cli",
    direction: "in",
    body: "hello",
    turnId: null,
    traceId: "trace-1",
    createdAt: clock.nowIso(),
  };
  messageRepo.create(inbound);

  const agentConfig: AgentConfig = {
    name: "studio-assistant",
    model: "claude-opus-4-7",
    imageTag: "teamroom-agent-studio-assistant:latest",
    configPath: "/abs/agents/studio-assistant",
    agentsMdPath: "/abs/agents/studio-assistant/AGENTS.md",
    storePath: "/abs/agents/studio-assistant/store",
  };

  return { db, agentRepo, messageRepo, turnRepo, clock, bus, logger, inbound, agentConfig };
}

describe("processTurn", () => {
  it("writes outbound messages for each reply event and marks turn done", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [
        { type: "reply", body: "first" },
        { type: "reply", body: "second" },
      ],
      exitCode: 0,
      stderr: "",
    }));

    const received: BusEvent[] = [];
    (async () => {
      for await (const e of s.bus.subscribe()) received.push(e);
    })();

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelBaseUrl: "http://localhost:1234/v1", modelApiToken: "test-token",
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });

    // two outbound messages should exist
    const outbound = s.messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["first", "second"]);

    // inbound should have a turn attached
    const reread = s.messageRepo.findById("m-1");
    expect(reread?.turnId).not.toBeNull();

    // turn should be done
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("done");
    expect(turn?.finishedAt).toBeTruthy();

    // bus should have turn.started, 2x message.outbound, turn.completed
    // wait a tick so the subscriber drains
    await new Promise((r) => setTimeout(r, 10));
    const types = received.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types.filter((t) => t === "message.outbound")).toHaveLength(2);
    expect(types).toContain("turn.completed");
  });

  it("marks turn error when the container exits non-zero", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 1,
      stderr: "catastrophic",
    }));

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelBaseUrl: "http://localhost:1234/v1", modelApiToken: "test-token",
      timeoutMs: 5000,
      genId: () => "generated-id",
    });

    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
    expect(turn?.error).toMatch(/exit=1/);
  });

  it("marks turn error with 'timeout' when the runner reports timeout", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 137,
      stderr: "",
      timedOut: true,
    }));

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelBaseUrl: "http://localhost:1234/v1", modelApiToken: "test-token",
      timeoutMs: 100,
      genId: () => "generated-id",
    });
    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
    expect(turn?.error).toBe("timeout");
  });

  it("does not crash on unknown stdout events — warns and drops", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [
        { type: "unknown", raw: "gibberish" },
        { type: "reply", body: "real reply" },
      ],
      exitCode: 0,
      stderr: "",
    }));
    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelBaseUrl: "http://localhost:1234/v1", modelApiToken: "test-token",
      timeoutMs: 5000,
      genId: () => "generated-id",
    });
    const outbound = s.messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["real reply"]);
    const warns = s.logger.entries.filter((e) => e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });
});
