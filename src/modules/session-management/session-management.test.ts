import { describe, expect, it } from "bun:test";
import { composeMessaging } from "../messaging/messaging.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import { FakeRunner } from "../../container/fake-runner.js";
import { composeSessionManagement } from "./session-management.js";

describe("composeSessionManagement", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

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
    });

    void messaging.eventBus.publish("mail.delivered", { to: "foo" });
    expect(specCalls).toEqual([{ agentId: "foo", token: "tok-1" }]);
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]?.envelopes).toEqual([{ type: "wake", events: ["mail"] }]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ ms: 30 * 60 * 1000, cancelled: false });

    void messaging.eventBus.publish("mail.sent", { from: "foo" });
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]?.envelopes).toEqual([{ type: "wake", events: ["mail"] }]);
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
});
