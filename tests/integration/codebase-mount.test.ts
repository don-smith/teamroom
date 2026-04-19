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
import { ControllableClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import { AgentSubscriptionIndex } from "../../src/daemon/subscriptions.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";
import type { ModelProxy, MintTokenInput } from "../../src/model-proxy/model-proxy.js";
import type { ContainerRunRequest, ContainerRunResult } from "../../src/container/container-runner.js";
import type { DockerRunSpec } from "../../src/container/docker-command.js";
import { randomUUID } from "node:crypto";

class StubModelProxy implements ModelProxy {
  start = async (): Promise<{ port: number }> => ({ port: 0 });
  stop = async (): Promise<void> => {};
  private next = 0;
  mint = (_input: MintTokenInput): string => `tok-${this.next++}`;
  evict = (_token: string): void => {};
}

function makeAgentConfig(name: string, base: string): AgentConfig {
  return {
    name,
    model: "test-model",
    imageTag: "test-image:latest",
    provider: "lm-studio",
    configPath: join(base, "agents", name),
    agentsMdPath: join(base, "agents", name, "AGENTS.md"),
    storePath: join(base, "agents", name, "store"),
    subscriptions: [name],
    allowedTools: [],
  };
}

function buildHarness(codebasePath: string | null, capturedSpecs: DockerRunSpec[]) {
  const clock = new ControllableClock("2026-04-19T00:00:00.000Z");
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const logger = new CapturingLogger(clock);
  const bus = new InMemoryBus();

  const agentConfig = makeAgentConfig(
    "claude-assistant",
    codebasePath ? join(codebasePath, "..") : "/fake",
  );
  agentRepo.create({ id: "claude-assistant", configPath: agentConfig.configPath, createdAt: clock.nowIso() });

  const agentConfigs = new Map<string, AgentConfig>([["claude-assistant", agentConfig]]);
  const subscriptionIndex = new AgentSubscriptionIndex(agentConfigs);

  const runner = new FakeRunner((req: ContainerRunRequest): { events: []; exitCode: number; stderr: string } => {
    capturedSpecs.push(req.spec);
    return { events: [], exitCode: 0, stderr: "" };
  });

  const orch = new Orchestrator({
    messageRepo,
    turnRepo,
    bus,
    logger,
    clock,
    runner,
    agentConfigs,
    modelProxy: new StubModelProxy(),
    modelBaseUrl: "http://localhost:1234/v1",
    anthropicAdapterPresent: false,
    subscriptionIndex,
    turnTimeoutMs: 5000,
    maxTurnsPerConversation: 10,
    pollIntervalMs: 50,
    genId: () => randomUUID(),
    codebasePath,
  });

  return { messageRepo, turnRepo, orch, clock };
}

describe("codebase-mount (DockerRunSpec includes /codebase when configured)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-codebase-"));
    mkdirSync(join(dir, "codebase"), { recursive: true });
    writeFileSync(join(dir, "codebase", "README.md"), "# test codebase\n");
    mkdirSync(join(dir, "agents", "claude-assistant", "store"), { recursive: true });
    writeFileSync(join(dir, "agents", "claude-assistant", "AGENTS.md"), "You are a test agent.");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("includes /codebase mount when codebasePath is set", async () => {
    const codebasePath = join(dir, "codebase");
    const capturedSpecs: DockerRunSpec[] = [];

    const agentConfig = makeAgentConfig("claude-assistant", dir);
    const clock = new ControllableClock("2026-04-19T00:00:00.000Z");
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const logger = new CapturingLogger(clock);
    const bus = new InMemoryBus();

    agentRepo.create({ id: "claude-assistant", configPath: agentConfig.configPath, createdAt: clock.nowIso() });

    const agentConfigs = new Map<string, AgentConfig>([["claude-assistant", agentConfig]]);
    const subscriptionIndex = new AgentSubscriptionIndex(agentConfigs);

    const runner = new FakeRunner((req: ContainerRunRequest) => {
      capturedSpecs.push(req.spec);
      return { events: [], exitCode: 0, stderr: "" };
    });

    const orch = new Orchestrator({
      messageRepo,
      turnRepo,
      bus,
      logger,
      clock,
      runner,
      agentConfigs,
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex,
      turnTimeoutMs: 5000,
      maxTurnsPerConversation: 10,
      pollIntervalMs: 50,
      genId: () => randomUUID(),
      codebasePath,
    });

    messageRepo.create({
      id: "m-cli",
      agentId: "claude-assistant",
      channel: "cli",
      direction: "in",
      body: "tick once",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
      topic: "",
      fromAgentId: null,
      conversationId: "c-main",
    });

    await orch.tickOnce();

    expect(capturedSpecs).toHaveLength(1);
    const spec = capturedSpecs[0]!;
    const codebaseMount = spec.mounts.find((m) => m.containerPath === "/codebase");
    expect(codebaseMount).toBeDefined();
    expect(codebaseMount!.hostPath).toBe(codebasePath);
    expect(codebaseMount!.readOnly).toBe(false);
  });

  it("omits /codebase mount when codebasePath is null", async () => {
    const capturedSpecs: DockerRunSpec[] = [];

    const agentConfig = makeAgentConfig("claude-assistant", dir);
    const clock = new ControllableClock("2026-04-19T00:00:00.000Z");
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const logger = new CapturingLogger(clock);
    const bus = new InMemoryBus();

    agentRepo.create({ id: "claude-assistant", configPath: agentConfig.configPath, createdAt: clock.nowIso() });

    const agentConfigs = new Map<string, AgentConfig>([["claude-assistant", agentConfig]]);
    const subscriptionIndex = new AgentSubscriptionIndex(agentConfigs);

    const runner = new FakeRunner((req: ContainerRunRequest) => {
      capturedSpecs.push(req.spec);
      return { events: [], exitCode: 0, stderr: "" };
    });

    const orch = new Orchestrator({
      messageRepo,
      turnRepo,
      bus,
      logger,
      clock,
      runner,
      agentConfigs,
      modelProxy: new StubModelProxy(),
      modelBaseUrl: "http://localhost:1234/v1",
      anthropicAdapterPresent: false,
      subscriptionIndex,
      turnTimeoutMs: 5000,
      maxTurnsPerConversation: 10,
      pollIntervalMs: 50,
      genId: () => randomUUID(),
      codebasePath: null,
    });

    messageRepo.create({
      id: "m-cli",
      agentId: "claude-assistant",
      channel: "cli",
      direction: "in",
      body: "tick once",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
      topic: "",
      fromAgentId: null,
      conversationId: "c-main",
    });

    await orch.tickOnce();

    expect(capturedSpecs).toHaveLength(1);
    const spec = capturedSpecs[0]!;
    const codebaseMount = spec.mounts.find((m) => m.containerPath === "/codebase");
    expect(codebaseMount).toBeUndefined();

    const agentsMdMount = spec.mounts.find((m) => m.containerPath === "/AGENTS.md");
    expect(agentsMdMount).toBeDefined();
    const storeMount = spec.mounts.find((m) => m.containerPath === "/store");
    expect(storeMount).toBeDefined();
  });
});
