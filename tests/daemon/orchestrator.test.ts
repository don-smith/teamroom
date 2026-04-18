import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import { ControllableClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";

const agentConfig: AgentConfig = {
  name: "assistant",
  model: "claude-opus-4-7",
  imageTag: "teamroom-agent-assistant:latest",
  configPath: "/abs/agents/assistant",
  agentsMdPath: "/abs/agents/assistant/AGENTS.md",
  storePath: "/abs/agents/assistant/store",
};

describe("Orchestrator", () => {
  it("picks up a pending inbound message and processes it", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner(() => ({
      events: [{ type: "reply", body: "pong" }],
      exitCode: 0,
      stderr: "",
    }));

    agentRepo.create({ id: "assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
      body: "ping", turnId: null, traceId: "tr-1", createdAt: clock.nowIso(),
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
    });

    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["pong"]);
  });

  it("processes pending messages in created_at order", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner((req) => {
      const envelope = JSON.parse(req.stdinJson) as { prompt: string };
      return {
        events: [{ type: "reply", body: `echo:${envelope.prompt}` }],
        exitCode: 0,
        stderr: "",
      };
    });

    agentRepo.create({ id: "assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
      body: "first", turnId: null, traceId: "tr-1", createdAt: "2026-04-18T00:00:00.000Z",
    });
    messageRepo.create({
      id: "m-2", agentId: "assistant", channel: "cli", direction: "in",
      body: "second", turnId: null, traceId: "tr-2", createdAt: "2026-04-18T00:00:01.000Z",
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
    });
    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["echo:first", "echo:second"]);
  });

  it("does nothing on tick when no pending messages", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner(() => {
      throw new Error("should not be called");
    });
    const orch = new Orchestrator({
      messageRepo: new MessageRepo(db),
      turnRepo: new TurnRepo(db),
      bus: new InMemoryBus(),
      logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => "x",
    });
    await orch.tickOnce(); // should be a no-op
  });
});
