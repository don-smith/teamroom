import { describe, expect, it } from "vitest";
import { composeIntegrationHarness } from "./helpers.js";

describe("thread-cap", () => {
  it("rejects the (cap+1)th mail in a thread", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant"],
      maxMailsPerThread: 10,
    });
    try {
      let threadId = "";
      for (let i = 0; i < 10; i++) {
        const r = h.dispatcher.sendMail({
          from: "cli:don",
          to: ["agent:claude-assistant"],
          body: `msg ${i}`,
          threadId: threadId || null,
        });
        threadId = r.threadId;
      }
      expect(h.messageRepo.countInThread(threadId)).toBe(10);
      expect(() =>
        h.dispatcher.sendMail({
          from: "cli:don",
          to: ["agent:claude-assistant"],
          body: "one more",
          threadId,
        }),
      ).toThrow(/thread cap/i);
    } finally {
      await h.shutdown();
    }
  });

  it("cap applies per thread — unrelated threads are unaffected", async () => {
    const h = composeIntegrationHarness({
      agents: ["claude-assistant"],
      maxMailsPerThread: 3,
    });
    try {
      const a = h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "a1" });
      const b = h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "b1" });
      // Fill thread A to cap.
      h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "a2", threadId: a.threadId });
      h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "a3", threadId: a.threadId });
      // A is at cap (3); another send to A throws.
      expect(() =>
        h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "a4", threadId: a.threadId }),
      ).toThrow(/thread cap/i);
      // B still has headroom.
      expect(() =>
        h.dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "b2", threadId: b.threadId }),
      ).not.toThrow();
    } finally {
      await h.shutdown();
    }
  });
});
