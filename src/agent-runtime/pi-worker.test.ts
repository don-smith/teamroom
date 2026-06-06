import { describe, expect, it } from "bun:test";
import { PiAgentWorker, resolvePiAllowedTools } from "./pi-worker.js";

describe("PiAgentWorker", () => {
  it("prompts Pi to check mail on wake", async () => {
    const prompts: string[] = [];
    const worker = await PiAgentWorker.createForTest({
      createSession: async () => ({
        prompt: async (text) => { prompts.push(text); },
        subscribe: () => () => undefined,
        dispose: () => undefined,
      }),
      onText: () => undefined,
      onError: () => undefined,
    });

    await worker.handleWake({ type: "wake", events: ["mail.delivered"] });

    expect(prompts[0]).toMatch(/check.*mail/i);
  });

  it("forwards text_delta events to onText", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const text: string[] = [];
    await PiAgentWorker.createForTest({
      createSession: async () => ({
        prompt: async () => undefined,
        subscribe: (l) => { listener = l; return () => undefined; },
        dispose: () => undefined,
      }),
      onText: (t) => text.push(t),
      onError: () => undefined,
    });

    listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });

    expect(text).toEqual(["hi"]);
  });

  it("always preserves Team Room mail tools in the Pi allowlist", () => {
    expect(resolvePiAllowedTools("Read,Write")).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "mail_list",
        "mail_get",
        "mail_send",
        "mail_reply",
        "mail_mark_read",
        "mail_archive",
        "mail_delete",
      ]),
    );
  });
});
