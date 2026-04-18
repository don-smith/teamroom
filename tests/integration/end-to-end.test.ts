import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import { SystemClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import { loadAgentConfig } from "../../src/agent-config/agent-config.js";
import { randomUUID } from "node:crypto";

describe("end-to-end (stack assembled with test implementations)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-e2e-"));
    mkdirSync(join(dir, "agents", "assistant", "store"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "assistant", "AGENTS.md"),
      "You are a test agent.",
    );
    writeFileSync(
      join(dir, "agents", "assistant", "agent.yaml"),
      "name: assistant\nmodel: m\nimage_tag: img\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("processes an inbound CLI message end-to-end and produces a tailable reply", async () => {
    const clock = new SystemClock();
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const logger = new CapturingLogger(clock);
    const bus = new InMemoryBus();
    const cfg = loadAgentConfig(join(dir, "agents", "assistant"));

    agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });

    // seed an inbound message
    const inboundId = randomUUID();
    messageRepo.create({
      id: inboundId,
      agentId: cfg.name,
      channel: "cli",
      direction: "in",
      body: "say hello",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
    });

    const runner = new FakeRunner((req) => {
      const env = JSON.parse(req.stdinJson) as { prompt: string };
      return {
        events: [{ type: "reply", body: `echo:${env.prompt}` }],
        exitCode: 0,
        stderr: "",
      };
    });

    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([[cfg.name, cfg]]),
      modelBaseUrl: "http://localhost:1234/v1", modelApiToken: "test-token",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => randomUUID(),
    });

    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["echo:say hello"]);
    expect(messageRepo.findById(inboundId)?.turnId).not.toBeNull();
  });
});
