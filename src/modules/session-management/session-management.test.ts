import { describe, expect, it, vi } from "vitest";
import { composeMessaging } from "../messaging/messaging.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import { FakeRunner } from "../../container/fake-runner.js";
import { composeSessionManagement } from "./session-management.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";

describe("composeSessionManagement", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  function baseCfg(name: string): AgentConfig {
    return {
      name,
      model: "m",
      imageTag: `img-${name}`,
      provider: "lm-studio",
      configPath: "/fake",
      agentsMdPath: "/fake/AGENTS.md",
      storePath: "/fake/store",
      subscriptions: [],
      allowedTools: [],
      lifecycle: "session",
    };
  }

  it("subscribes to mail.delivered, mail.sent, and tool.call on the bus", async () => {
    const messaging = composeMessaging({ logger });
    const runner = new FakeRunner();
    const sm = composeSessionManagement({
      messaging, logger, runner,
      idleMinutes: 30,
      timerFactory: { schedule: () => ({ cancel: () => {} }) },
      spec: () => ({ imageTag: "x", mounts: [], env: {}, labels: {} }),
      genToken: () => "tok-1",
      agentConfigs: new Map(),
    });

    const onMailSpy = vi.spyOn(sm.sessionManager, "onMailDelivered");
    void messaging.eventBus.publish("mail.delivered", { to: "agent:foo" });
    expect(onMailSpy).toHaveBeenCalledWith("agent:foo");

    const onActivitySpy = vi.spyOn(sm.sessionManager, "onAgentActivity");
    void messaging.eventBus.publish("mail.sent", { from: "agent:bar" });
    expect(onActivitySpy).toHaveBeenCalledWith("agent:bar");

    void messaging.eventBus.publish("tool.call", { agentId: "baz", tool: "mail.send" });
    expect(onActivitySpy).toHaveBeenCalledWith("baz");

    await sm.stop();
  });

  it("spawns persistent agents at init and never spawns session agents at init", async () => {
    const messaging = composeMessaging({ logger });
    const runner = new FakeRunner();

    const agentConfigs = new Map<string, AgentConfig>([
      ["session-a", { ...baseCfg("session-a"), lifecycle: "session" }],
      ["persistent-b", { ...baseCfg("persistent-b"), lifecycle: "persistent" }],
    ]);

    const sm = composeSessionManagement({
      messaging,
      logger,
      runner,
      idleMinutes: 30,
      timerFactory: { schedule: () => ({ cancel: () => {} }) },
      spec: (agentId, tok) => ({ imageTag: `img-${agentId}`, mounts: [], env: { T: tok } }),
      genToken: () => "tok-x",
      agentConfigs,
    });

    // Persistent agent spawned; session agent NOT.
    const spawned = runner.sessions.map((s) => s.spec.imageTag);
    expect(spawned).toEqual(["img-persistent-b"]);

    await sm.stop();
  });
});
