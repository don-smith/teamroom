import { describe, expect, it } from "bun:test";
import { composeIntegrationHarness } from "./helpers.js";

describe("cli-mail-round-trip", () => {
  it("CLI send → agent wakes → mail.list + mail.reply → CLI outbound row", async () => {
    const h = await composeIntegrationHarness({
      agents: ["claude-assistant"],
      agentScripts: {
        "claude-assistant": (tools) => {
          const inbox = tools.mailList({ unreadOnly: true });
          expect(inbox).toHaveLength(1);
          const first = inbox[0]!;
          const full = tools.mailGet({ id: first.id });
          tools.mailReply({ id: first.id, body: `got: ${full.body}` });
        },
      },
    });

    try {
      h.cli.send({ user: "don", target: "claude-assistant", body: "ping" });
      const got = await h.waitForCliOut({ bodyMatch: /got: ping/, timeoutMs: 2000 });
      expect(got).toBe("got: ping");
    } finally {
      await h.shutdown();
    }
  });
});

describe("agent-to-agent-mail", () => {
  it("two agents exchange mail in a shared thread, CLI sees the final answer", async () => {
    let assistantTurn = 0;
    const h = await composeIntegrationHarness({
      agents: ["claude-assistant", "claude-researcher"],
      agentScripts: {
        "claude-assistant": (tools) => {
          assistantTurn += 1;
          const unread = tools.mailList({ unreadOnly: true });
          for (const m of unread) {
            if (assistantTurn === 1) {
              // First wake: from CLI. Consult researcher in the same thread.
              tools.mailSend({
                to: ["agent:claude-researcher"],
                body: `please research: ${m.body}`,
                threadId: m.threadId ?? undefined,
              });
              tools.mailMarkRead({ id: m.id });
            } else {
              // Later wake: researcher replied. Reply to the ORIGINAL CLI
              // mail in the thread so the response surfaces to the user.
              const thread = tools.mailList({ threadId: m.threadId ?? undefined });
              const originalCli = thread.find((t) => (t.from ?? "").startsWith("channel:cli:"));
              if (originalCli) {
                tools.mailReply({ id: originalCli.id, body: `final answer: ${m.body}` });
              }
              tools.mailMarkRead({ id: m.id });
            }
          }
        },
        "claude-researcher": (tools) => {
          const unread = tools.mailList({ unreadOnly: true });
          for (const m of unread) {
            tools.mailReply({ id: m.id, body: "researcher answer" });
            tools.mailMarkRead({ id: m.id });
          }
        },
      },
    });

    try {
      h.cli.send({ user: "don", target: "claude-assistant", body: "what is up" });
      const out = await h.waitForCliOut({ bodyMatch: /final answer.*researcher answer/, timeoutMs: 3000 });
      expect(out).toContain("researcher answer");
    } finally {
      await h.shutdown();
    }
  });
});
