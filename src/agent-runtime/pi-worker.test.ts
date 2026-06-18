import { describe, expect, it } from "bun:test";
import type { MailDeliveredEvent } from "../types.js";
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

  it("uses the replyExpected prompt when a structured mail event requires a reply", async () => {
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

    const event: MailDeliveredEvent = {
      type: "mail.delivered",
      to: "pi-coder",
      messageId: "msg-1",
      threadId: "thread-1",
      from: "channel:cli:don",
      replyExpected: true,
    };
    await worker.handleWake({ type: "wake", events: [event] });

    expect(prompts[0]).toMatch(/requires a reply/);
    expect(prompts[0]).toMatch(/Message id: msg-1/);
    expect(prompts[0]).toMatch(/Thread id: thread-1/);
    expect(prompts[0]).toMatch(/From: channel:cli:don/);
  });

  it("uses the no-reply prompt when replyExpected is false", async () => {
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

    const event: MailDeliveredEvent = {
      type: "mail.delivered",
      to: "pi-coder",
      messageId: "msg-1",
      threadId: "thread-1",
      from: "agent:archie",
      replyExpected: false,
    };
    await worker.handleWake({ type: "wake", events: [event] });

    expect(prompts[0]).toMatch(/no required reply/);
    expect(prompts[0]).not.toMatch(/requires a reply/);
  });

  it("rejects openrouter as a Pi provider", async () => {
    const prev = process.env.TEAMROOM_PROVIDER;
    process.env.TEAMROOM_PROVIDER = "openrouter";
    process.env.TEAMROOM_MODEL = "deepseek/deepseek-v4-flash";
    process.env.TEAMROOM_MODEL_BASE_URL = "http://localhost";
    process.env.TEAMROOM_MODEL_API_TOKEN = "tok";
    process.env.TEAMROOM_MCP_URL = "http://localhost/mcp";
    process.env.TEAMROOM_MCP_TOKEN = "mcp-tok";
    try {
      await expect(PiAgentWorker.create()).rejects.toThrow(/unsupported TEAMROOM_PROVIDER/);
    } finally {
      if (prev === undefined) delete process.env.TEAMROOM_PROVIDER;
      else process.env.TEAMROOM_PROVIDER = prev;
      delete process.env.TEAMROOM_MODEL;
      delete process.env.TEAMROOM_MODEL_BASE_URL;
      delete process.env.TEAMROOM_MODEL_API_TOKEN;
      delete process.env.TEAMROOM_MCP_URL;
      delete process.env.TEAMROOM_MCP_TOKEN;
    }
  });
});
