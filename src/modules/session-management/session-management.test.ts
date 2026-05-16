import { describe, expect, it, vi } from "bun:test";
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
    const sm = composeSessionManagement({
      messaging, logger, runner,
      idleMinutes: 30,
      timerFactory: { schedule: () => ({ cancel: () => {} }) },
      spec: () => ({ imageTag: "x", mounts: [], env: {}, labels: {} }),
      genToken: () => "tok-1",
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
});
