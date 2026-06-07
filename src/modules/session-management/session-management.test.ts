import { describe, expect, it } from "bun:test";
import { composeMessaging } from "../messaging/messaging.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import { FakeRunner } from "../../container/fake-runner.js";
import { composeSessionManagement } from "./session-management.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";
import type { MailDeliveredEvent } from "../../types.js";

function mailDelivered(to: string): MailDeliveredEvent {
  return {
    type: "mail.delivered",
    to,
    messageId: `msg-${to}`,
    threadId: `thread-${to}`,
    from: "channel:cli:don",
    replyExpected: true,
  };
}

describe("composeSessionManagement", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  function baseCfg(name: string): AgentConfig {
    return {
      name,
      model: "m",
      imageTag: `img-${name}`,
      provider: "lm-studio",
      runtime: "langgraph",
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
    const scheduled: Array<{ ms: number; cancelled: boolean; fire: () => void }> = [];
    const specCalls: Array<{ agentId: string; token: string }> = [];
    const sm = composeSessionManagement({
      messaging, logger, runner,
      idleMinutes: 30,
      timerFactory: {
        schedule(ms, fn) {
          const timer = { ms, cancelled: false, fire: fn };
          scheduled.push(timer);
          return {
            cancel() {
              timer.cancelled = true;
            },
          };
        },
      },
      spec: (agentId, token) => {
        specCalls.push({ agentId, token });
        return { imageTag: "x", mounts: [], env: {}, labels: {} };
      },
      genToken: () => "tok-1",
      agentConfigs: new Map(),
    });

    const delivery = mailDelivered("foo");
    void messaging.eventBus.publish("mail.delivered", delivery);
    expect(specCalls).toEqual([{ agentId: "foo", token: "tok-1" }]);
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]?.envelopes).toEqual([{ type: "wake", events: [delivery] }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ ms: 30 * 60 * 1000, cancelled: false });

    void messaging.eventBus.publish("mail.sent", { from: "foo" });
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]?.envelopes).toEqual([{ type: "wake", events: [delivery] }]);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.cancelled).toBe(true);
    expect(scheduled[1]).toMatchObject({ ms: 30 * 60 * 1000, cancelled: false });

    void messaging.eventBus.publish("tool.call", { agentId: "foo", tool: "mail.send" });
    expect(scheduled).toHaveLength(3);
    expect(scheduled[1]?.cancelled).toBe(true);
    expect(scheduled[2]).toMatchObject({ ms: 30 * 60 * 1000, cancelled: false });

    scheduled[2]?.fire();
    expect(runner.sessions[0]?.isStdinClosed()).toBe(true);

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
