import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { InMemoryBus } from "../bus/in-memory-bus.js";
import { FakeRunner } from "../container/fake-runner.js";
import { ControllableClock } from "../clock/clock.js";
import { CapturingLogger } from "../logger/logger.js";
import { Orchestrator } from "./orchestrator.js";
import { AgentSubscriptionIndex } from "./subscriptions.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { ModelProxy, MintTokenInput } from "../model-proxy/model-proxy.js";

/** Minimal in-memory ModelProxy stub for orchestrator/turn-processor tests. */
class StubModelProxy implements ModelProxy {
  start = async (): Promise<{ port: number }> => ({ port: 0 });
  stop = async (): Promise<void> => {};
  private next = 0;
  mint = (_input: MintTokenInput): string => `tok-${this.next++}`;
  evict = (_token: string): void => {};
}

const agentConfig: AgentConfig = {
  name: "studio-assistant",
  model: "claude-opus-4-7",
  imageTag: "teamroom-agent-studio-assistant:latest",
  provider: "lm-studio",
  configPath: "/abs/agents/studio-assistant",
  agentsMdPath: "/abs/agents/studio-assistant/AGENTS.md",
  storePath: "/abs/agents/studio-assistant/store",
  subscriptions: [],
  allowedTools: [],
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

    agentRepo.create({ id: "studio-assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "studio-assistant", channel: "cli", direction: "in",
      body: "ping", turnId: null, traceId: "tr-1", createdAt: clock.nowIso(),
      topic: "", fromAgentId: null, conversationId: null,
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["studio-assistant", agentConfig]]),
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      turnTimeoutMs: 5000,
      maxTurnsPerConversation: 10,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
      codebasePath: null,
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

    agentRepo.create({ id: "studio-assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "studio-assistant", channel: "cli", direction: "in",
      body: "first", turnId: null, traceId: "tr-1", createdAt: "2026-04-18T00:00:00.000Z",
      topic: "", fromAgentId: null, conversationId: null,
    });
    messageRepo.create({
      id: "m-2", agentId: "studio-assistant", channel: "cli", direction: "in",
      body: "second", turnId: null, traceId: "tr-2", createdAt: "2026-04-18T00:00:01.000Z",
      topic: "", fromAgentId: null, conversationId: null,
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["studio-assistant", agentConfig]]),
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      turnTimeoutMs: 5000,
      maxTurnsPerConversation: 10,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
      codebasePath: null,
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
      agentConfigs: new Map([["studio-assistant", agentConfig]]),
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      turnTimeoutMs: 5000,
      maxTurnsPerConversation: 10,
      pollIntervalMs: 50,
      genId: () => "x",
      codebasePath: null,
    });
    await orch.tickOnce(); // should be a no-op
  });
});
