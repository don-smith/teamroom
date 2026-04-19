import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type LlmClient } from "./runtime.js";
import { loadConversation } from "./session-store.js";

describe("runTurn", () => {
  let dir: string;
  let convFile: string;
  let agentsMd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-runtime-"));
    convFile = join(dir, "conversation.jsonl");
    agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "You are a friendly assistant.");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("calls the LLM, emits reply event, persists user + assistant to conversation.jsonl", async () => {
    const calls: { system: string; messages: unknown[] }[] = [];
    const client: LlmClient = {
      async createMessage({ system, messages, model }) {
        calls.push({ system, messages });
        expect(model).toBe("claude-opus-4-7");
        return { text: "hi there" };
      },
    };
    const events: string[] = [];
    await runTurn({
      envelope: { prompt: "hello", messageId: "m1", turnId: "t1", traceId: "tr1" },
      client,
      model: "claude-opus-4-7",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: (line) => events.push(line),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("friendly assistant");
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);

    const parsed = events.map((e) => JSON.parse(e) as { type: string; body?: string });
    expect(parsed).toEqual([{ type: "reply", body: "hi there", messageId: "m1" }]);

    expect(loadConversation(convFile)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("includes prior conversation on subsequent turns", async () => {
    writeFileSync(
      convFile,
      `${JSON.stringify({ role: "user", content: "a" })}\n${JSON.stringify({ role: "assistant", content: "b" })}\n`,
    );
    let captured: unknown[] = [];
    const client: LlmClient = {
      async createMessage({ messages }) {
        captured = messages;
        return { text: "c" };
      },
    };
    await runTurn({
      envelope: { prompt: "x", messageId: "m2", turnId: "t2", traceId: "tr2" },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    expect(captured).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "x" },
    ]);
  });

  it("prepends '[dm from X]\\n\\n' to the user prompt when envelope.channel === 'dm'", async () => {
    let capturedMessages: unknown[] = [];
    const client: LlmClient = {
      async createMessage({ messages }) {
        capturedMessages = messages;
        return { text: "response" };
      },
    };
    await runTurn({
      envelope: {
        prompt: "what day is it?",
        messageId: "m-dm",
        turnId: "t-dm",
        traceId: "tr-dm",
        channel: "dm",
        from: "studio-assistant",
      },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    const userMsg = (capturedMessages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMsg?.content).toBe("[dm from studio-assistant]\n\nwhat day is it?");
  });

  it("does NOT prepend anything when envelope.channel === 'cli'", async () => {
    let capturedMessages: unknown[] = [];
    const client: LlmClient = {
      async createMessage({ messages }) {
        capturedMessages = messages;
        return { text: "response" };
      },
    };
    await runTurn({
      envelope: {
        prompt: "hello cli",
        messageId: "m-cli",
        turnId: "t-cli",
        traceId: "tr-cli",
        channel: "cli",
        from: "cli",
      },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    const userMsg = (capturedMessages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMsg?.content).toBe("hello cli");
  });

  it("does NOT prepend anything when envelope.channel is undefined (backwards-compat)", async () => {
    let capturedMessages: unknown[] = [];
    const client: LlmClient = {
      async createMessage({ messages }) {
        capturedMessages = messages;
        return { text: "response" };
      },
    };
    await runTurn({
      envelope: { prompt: "no channel", messageId: "m-nc", turnId: "t-nc", traceId: "tr-nc" },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    const userMsg = (capturedMessages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMsg?.content).toBe("no channel");
  });

  it("uses a default system prompt if AGENTS.md is missing", async () => {
    rmSync(agentsMd);
    let captured = "";
    const client: LlmClient = {
      async createMessage({ system }) {
        captured = system;
        return { text: "ok" };
      },
    };
    await runTurn({
      envelope: { prompt: "hi", messageId: "m1", turnId: "t1", traceId: "tr1" },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    expect(captured.length).toBeGreaterThan(0);
  });
});
