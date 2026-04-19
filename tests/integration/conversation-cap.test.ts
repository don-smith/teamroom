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
import { AgentSubscriptionIndex } from "../../src/daemon/subscriptions.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";
import type { ModelProxy, MintTokenInput } from "../../src/model-proxy/model-proxy.js";
import type { ContainerRunRequest } from "../../src/container/container-runner.js";
import { randomUUID } from "node:crypto";

class StubModelProxy implements ModelProxy {
  start = async (): Promise<{ port: number }> => ({ port: 0 });
  stop = async (): Promise<void> => {};
  private next = 0;
  mint = (_input: MintTokenInput): string => `tok-${this.next++}`;
  evict = (_token: string): void => {};
}

function makeAgentConfig(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    imageTag: "test-image:latest",
    provider: "lm-studio",
    configPath: `/fake/agents/${name}`,
    agentsMdPath: `/fake/agents/${name}/AGENTS.md`,
    storePath: `/fake/agents/${name}/store`,
    subscriptions: [name],
    allowedTools: [],
  };
}

describe("conversation-cap (ping-pong loop halted at limit)", () => {
  it("stops exactly at maxTurnsPerConversation=5 and logs conversation.limit_reached", async () => {
    const clock = new ControllableClock("2026-04-19T00:00:00.000Z");
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const logger = new CapturingLogger(clock);
    const bus = new InMemoryBus();

    const claudeConfig = makeAgentConfig("claude-assistant");
    const studioConfig = makeAgentConfig("studio-assistant");

    agentRepo.create({ id: "claude-assistant", configPath: claudeConfig.configPath, createdAt: clock.nowIso() });
    agentRepo.create({ id: "studio-assistant", configPath: studioConfig.configPath, createdAt: clock.nowIso() });

    const agentConfigs = new Map<string, AgentConfig>([
      ["claude-assistant", claudeConfig],
      ["studio-assistant", studioConfig],
    ]);
    const subscriptionIndex = new AgentSubscriptionIndex(agentConfigs);

    const runner = new FakeRunner((req: ContainerRunRequest) => {
      const agentName = req.spec.env["TEAMROOM_AGENT_NAME"] as string;
      const other = agentName === "claude-assistant" ? "studio-assistant" : "claude-assistant";
      return {
        events: [{ type: "dm" as const, to: other, body: "ping" }],
        exitCode: 0,
        stderr: "",
      };
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
      maxTurnsPerConversation: 5,
      pollIntervalMs: 50,
      genId: () => randomUUID(),
      codebasePath: null,
    });

    messageRepo.create({
      id: "m-cli",
      agentId: "claude-assistant",
      channel: "cli",
      direction: "in",
      body: "start the loop",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
      topic: "",
      fromAgentId: null,
      conversationId: "c-main",
    });

    for (let i = 0; i < 20; i++) {
      const pending = messageRepo.findPendingInbound();
      if (pending.length === 0) break;
      await orch.tickOnce();
      clock.advance(1);
    }

    // maxTurnsPerConversation=5 means 5 normal turns run to completion, then
    // the 6th attempt is blocked by the cap and recorded as an error turn.
    // countByConversationId counts ALL turns including the error one.
    expect(turnRepo.countByConversationId("c-main")).toBe(6);

    const allTurns = db.prepare("SELECT * FROM turns WHERE conversation_id = 'c-main' ORDER BY created_at").all() as Array<{
      status: string;
      error: string | null;
    }>;
    expect(allTurns).toHaveLength(6);

    const errorTurns = allTurns.filter((t) => t.status === "error" && t.error === "conversation_cap");
    expect(errorTurns.length).toBeGreaterThanOrEqual(1);

    const limitReachedEntries = logger.entries.filter(
      (e) => e.msg === "conversation.limit_reached",
    );
    expect(limitReachedEntries.length).toBeGreaterThanOrEqual(1);
    const entry = limitReachedEntries[0];
    expect(entry.conversationId).toBe("c-main");
    expect(entry.limit).toBe(5);
  });
});
