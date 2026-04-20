import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processWake, type LlmClient } from "./runtime.js";

describe("processWake", () => {
  let dir: string;
  let agentsMd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-runtime-"));
    agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "You are claude-assistant. Triage your inbox.");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("invokes the LLM once with the system prompt from AGENTS.md and a wake user message", async () => {
    const calls: { system: string; messages: unknown[]; model: string }[] = [];
    const client: LlmClient = {
      async createMessage(args) {
        calls.push({ system: args.system, messages: args.messages, model: args.model });
        return { text: "" };
      },
    };

    await processWake({
      wake: { type: "wake", events: ["mail"] },
      client,
      model: "claude-opus-4-7",
      agentsMdPath: agentsMd,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("claude-assistant");
    expect(calls[0]!.model).toBe("claude-opus-4-7");
    // Messages carry the canned wake prompt — the LLM's job is to call
    // mail.* MCP tools based on what's in its inbox.
    expect(calls[0]!.messages).toEqual([
      { role: "user", content: expect.stringContaining("wake") },
    ]);
  });

  it("does not emit {type:\"reply\"} (or any stdout envelope) for LLM text output", async () => {
    const client: LlmClient = {
      async createMessage() {
        return { text: "I looked at my inbox, nothing actionable." };
      },
    };
    const originalWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await processWake({
        wake: { type: "wake", events: ["mail"] },
        client,
        model: "m",
        agentsMdPath: agentsMd,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const stdoutSeen = captured.join("");
    expect(stdoutSeen).not.toMatch(/"type":\s*"reply"/);
    expect(stdoutSeen).not.toMatch(/"type":\s*"dm"/);
  });

  it("routes LLM natural-language text to onText when provided", async () => {
    const client: LlmClient = {
      async createMessage() {
        return { text: "ok, replied to sender" };
      },
    };
    const texts: string[] = [];
    await processWake({
      wake: { type: "wake", events: ["mail"] },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      onText: (t) => texts.push(t),
    });
    expect(texts).toEqual(["ok, replied to sender"]);
  });

  it("uses a default system prompt if AGENTS.md is missing", async () => {
    rmSync(agentsMd);
    let captured = "";
    const client: LlmClient = {
      async createMessage(args) {
        captured = args.system;
        return { text: "" };
      },
    };
    await processWake({
      wake: { type: "wake", events: ["mail"] },
      client,
      model: "m",
      agentsMdPath: agentsMd,
    });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured).toMatch(/mail/i);
  });

  it("can be invoked repeatedly — each wake is independent", async () => {
    let seen = 0;
    const client: LlmClient = {
      async createMessage() {
        seen += 1;
        return { text: "" };
      },
    };
    for (let i = 0; i < 3; i++) {
      await processWake({
        wake: { type: "wake", events: ["mail"] },
        client,
        model: "m",
        agentsMdPath: agentsMd,
      });
    }
    expect(seen).toBe(3);
  });
});
