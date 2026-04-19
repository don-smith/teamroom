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
import { AgentSubscriptionIndex } from "./subscriptions.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { BusEvent, Message } from "../types.js";
import type { ModelProxy, MintTokenInput } from "../model-proxy/model-proxy.js";

/** Minimal in-memory ModelProxy stub for turn-processor tests. */
class StubModelProxy implements ModelProxy {
  start = async (): Promise<{ port: number }> => ({ port: 0 });
  stop = async (): Promise<void> => {};
  private next = 0;
  public readonly mintCalls: MintTokenInput[] = [];
  public readonly evictCalls: string[] = [];
  mint = (input: MintTokenInput): string => {
    this.mintCalls.push(input);
    return `tok-${this.next++}`;
  };
  evict = (token: string): void => {
    this.evictCalls.push(token);
  };
}

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
    topic: "",
    fromAgentId: null,
    conversationId: null,
  };
  messageRepo.create(inbound);

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
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
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
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
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
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
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
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: () => "generated-id",
    });
    const outbound = s.messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["real reply"]);
    const warns = s.logger.entries.filter((e) => e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });

  it("calls markRunning with placeholder before runner.run, then updates with real container id", async () => {
    const s = setup();
    // Capture turnRepo.markRunning calls + their relative ordering vs runner.run.
    const events: Array<{ kind: "markRunning"; containerId: string } | { kind: "run" }> = [];
    const realMarkRunning = s.turnRepo.markRunning.bind(s.turnRepo);
    s.turnRepo.markRunning = (id: string, containerId: string, startedAt: string): void => {
      events.push({ kind: "markRunning", containerId });
      realMarkRunning(id, containerId, startedAt);
    };
    const runner = new FakeRunner(() => {
      events.push({ kind: "run" });
      return { events: [], exitCode: 0, stderr: "" };
    });
    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });

    // Expect: markRunning("pending-spawn") → run → markRunning("fake-1")
    expect(events.length).toBe(3);
    expect(events[0]).toEqual({ kind: "markRunning", containerId: "pending-spawn" });
    expect(events[1]).toEqual({ kind: "run" });
    expect(events[2]).toEqual({ kind: "markRunning", containerId: "fake-1" });

    // Final row state should hold the real container id.
    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.containerId).toBe("fake-1");
  });

  it("mints a routing token and evicts it on success", async () => {
    const s = setup();
    const proxy = new StubModelProxy();
    let mintAtRunStart: number | null = null;
    let evictAtRunStart: number | null = null;
    const runner = new FakeRunner(() => {
      mintAtRunStart = proxy.mintCalls.length;
      evictAtRunStart = proxy.evictCalls.length;
      return { events: [{ type: "reply", body: "ok" }], exitCode: 0, stderr: "" };
    });
    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelProxy: proxy,
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });

    // mint() ran exactly once before runner.run; evict had not yet fired then.
    expect(mintAtRunStart).toBe(1);
    expect(evictAtRunStart).toBe(0);

    // mint payload carries the right routing context.
    expect(proxy.mintCalls).toHaveLength(1);
    expect(proxy.mintCalls[0]).toMatchObject({
      agentId: s.inbound.agentId,
      traceId: s.inbound.traceId,
      provider: s.agentConfig.provider,
      model: s.agentConfig.model,
    });

    // evict() called exactly once with the same token mint() returned.
    expect(proxy.evictCalls).toEqual(["tok-0"]);
  });

  it("evicts the routing token even when the container errors", async () => {
    const s = setup();
    const proxy = new StubModelProxy();
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 1,
      stderr: "boom",
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
      modelProxy: proxy,
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });
    expect(proxy.mintCalls).toHaveLength(1);
    expect(proxy.evictCalls).toEqual(["tok-0"]);
    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
  });

  it("refuses provider:anthropic agents when anthropicAdapterPresent is false", async () => {
    const s = setup();
    const anthropicCfg: AgentConfig = { ...s.agentConfig, provider: "anthropic" };
    const proxy = new StubModelProxy();
    let runnerCalled = false;
    const runner = new FakeRunner(() => {
      runnerCalled = true;
      return { events: [], exitCode: 0, stderr: "" };
    });

    await processTurn({
      inbound: s.inbound,
      agentConfig: anthropicCfg,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelProxy: proxy,
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });

    // Runner must never be invoked; no token minted/evicted.
    expect(runnerCalled).toBe(false);
    expect(proxy.mintCalls).toHaveLength(0);
    expect(proxy.evictCalls).toHaveLength(0);

    // Turn row should be in error state with the expected error string.
    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
    expect(turn?.error).toBe("missing_credential");
  });

  it("copies inbound.conversationId to the turn row", async () => {
    const s = setup();
    const inboundWithConversation: Message = {
      ...s.inbound,
      conversationId: "c-test-uuid",
    };
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 0,
      stderr: "",
    }));

    await processTurn({
      inbound: inboundWithConversation,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex: new AgentSubscriptionIndex(new Map()),
      timeoutMs: 5000,
      genId: (() => { let n = 0; return () => `gen-${++n}`; })(),
    });

    const reread = s.messageRepo.findById(inboundWithConversation.id);
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.conversationId).toBe("c-test-uuid");
  });
});
