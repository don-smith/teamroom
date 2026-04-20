import { describe, expect, it } from "vitest";
import { composeIntegrationHarness } from "./helpers.js";

describe("mailing-list-fanout", () => {
  it("publishing a trigger event on the bus dispatches system-sent mail to subscribers", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant", "claude-researcher"],
      lists: [{ name: "harness-activity", triggers: ["turn.completed"] }],
      agentSubscriptions: {
        "claude-researcher": ["list:harness-activity"],
      },
    });

    try {
      h.bus.publish("turn.completed", { agentId: "claude-assistant", turnId: "T1" });
      await h.waitForInbox({ agent: "claude-researcher", minCount: 1, timeoutMs: 1000 });

      const researcherInbox = h.messageRepo.listInbox("claude-researcher", {});
      expect(researcherInbox).toHaveLength(1);
      expect(researcherInbox[0]!.from).toBe("system");
      expect(researcherInbox[0]!.to).toEqual(["agent:claude-researcher"]);
      expect(researcherInbox[0]!.body).toContain("turn.completed");

      // claude-assistant is NOT subscribed → no row.
      expect(h.messageRepo.listInbox("claude-assistant", {})).toHaveLength(0);
    } finally {
      await h.shutdown();
    }
  });

  it("un-triggered events do not fan out", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant"],
      lists: [{ name: "activity", triggers: ["turn.started"] }],
      agentSubscriptions: { "claude-assistant": ["list:activity"] },
    });
    try {
      h.bus.publish("turn.completed", { agentId: "claude-assistant", turnId: "T1" });
      await new Promise((ok) => setTimeout(ok, 50));
      expect(h.messageRepo.listInbox("claude-assistant", {})).toHaveLength(0);
    } finally {
      await h.shutdown();
    }
  });
});

describe("session-idle-exit", () => {
  it("advances the timer and closes stdin, then removes the session", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant"],
      sessionIdleMinutes: 30,
      agentScripts: {
        // No-op script; we care about the timer, not tool calls.
        "claude-assistant": () => {
          /* no-op */
        },
      },
    });

    try {
      h.cli.send({ user: "don", target: "claude-assistant", body: "wake me" });
      // Session should have been spawned by the dispatcher → bus → manager chain.
      expect(h.sessionManager.hasSession("claude-assistant")).toBe(true);

      // Advance past the idle threshold. The timer fires closeStdin on the
      // FakeRunningContainer; FakeRunningContainer does not auto-exit on
      // closeStdin (it's a fake), so we simulate the runtime's clean exit.
      h.timerFactory.advance(30 * 60 * 1000);
      const session = h.runner.sessions[0]!;
      expect(session.isStdinClosed()).toBe(true);
      session.simulateExit({ exitCode: 0 });

      await h.waitForSessionGone("claude-assistant", { timeoutMs: 200 });
      expect(h.sessionManager.hasSession("claude-assistant")).toBe(false);
    } finally {
      await h.shutdown();
    }
  });

  it("session stays alive if any activity arrives before the timer fires", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant"],
      sessionIdleMinutes: 30,
      agentScripts: { "claude-assistant": () => {} },
    });
    try {
      h.cli.send({ user: "don", target: "claude-assistant", body: "wake" });
      h.timerFactory.advance(29 * 60 * 1000);
      h.bus.publish("tool.call", { agentId: "claude-assistant", tool: "mail.list" });
      h.timerFactory.advance(29 * 60 * 1000);
      // Still alive.
      expect(h.runner.sessions[0]!.isStdinClosed()).toBe(false);
      // One more minute pushes past the 30 from last activity.
      h.timerFactory.advance(1 * 60 * 1000);
      expect(h.runner.sessions[0]!.isStdinClosed()).toBe(true);
    } finally {
      await h.shutdown();
    }
  });
});
