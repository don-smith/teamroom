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

describe("dm-round-trip (full multi-hop chain)", () => {
  it("routes CLI -> claude -> DM -> studio -> reply -> claude -> reply -> CLI", async () => {
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
      const envelope = JSON.parse(req.stdinJson) as { channel: string; from: string };
      const agentName = req.spec.env["TEAMROOM_AGENT_NAME"];

      if (agentName === "claude-assistant" && envelope.channel === "cli") {
        return {
          events: [{ type: "dm" as const, to: "studio-assistant", body: "ask: day of week" }],
          exitCode: 0,
          stderr: "",
        };
      }
      if (agentName === "studio-assistant" && envelope.channel === "dm") {
        return {
          events: [{ type: "reply" as const, body: "it is Sunday" }],
          exitCode: 0,
          stderr: "",
        };
      }
      // claude-assistant receives the DM reply from studio and exits without
      // further output — ending the conversation chain here.
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
      body: "ask studio what day",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
      topic: "",
      fromAgentId: null,
      conversationId: "c-main",
    });

    for (let i = 0; i < 10; i++) {
      const pending = messageRepo.findPendingInbound();
      if (pending.length === 0) break;
      await orch.tickOnce();
      clock.advance(1);
    }

    const allMessages = db.prepare("SELECT * FROM messages ORDER BY created_at, id").all() as Array<{
      id: string;
      agent_id: string;
      channel: string;
      direction: string;
      body: string;
      topic: string;
      from_agent_id: string | null;
      conversation_id: string | null;
    }>;

    const inbound = allMessages.filter((m) => m.direction === "in");

    // 3 inbound messages: seed CLI, studio DM, and claude DM return
    expect(inbound).toHaveLength(3);

    const cliInbound = inbound.find((m) => m.channel === "cli" && m.agent_id === "claude-assistant");
    expect(cliInbound).toBeDefined();
    expect(cliInbound!.id).toBe("m-cli");

    // claude → DM → studio-assistant
    const studioDmInbound = inbound.find(
      (m) => m.channel === "dm" && m.agent_id === "studio-assistant",
    );
    expect(studioDmInbound).toBeDefined();
    expect(studioDmInbound!.topic).toBe("studio-assistant");
    expect(studioDmInbound!.from_agent_id).toBe("claude-assistant");
    expect(studioDmInbound!.conversation_id).toBe("c-main");

    // studio reply → DM bounced back to claude-assistant
    const claudeDmInbound = inbound.find(
      (m) => m.channel === "dm" && m.agent_id === "claude-assistant",
    );
    expect(claudeDmInbound).toBeDefined();
    expect(claudeDmInbound!.topic).toBe("claude-assistant");
    expect(claudeDmInbound!.from_agent_id).toBe("studio-assistant");
    expect(claudeDmInbound!.conversation_id).toBe("c-main");
    expect(claudeDmInbound!.body).toBe("it is Sunday");

    const allTurns = db.prepare("SELECT * FROM turns ORDER BY created_at").all() as Array<{
      conversation_id: string | null;
      status: string;
    }>;
    expect(allTurns).toHaveLength(3);
    for (const turn of allTurns) {
      expect(turn.conversation_id).toBe("c-main");
      expect(turn.status).toBe("done");
    }
  });
});
