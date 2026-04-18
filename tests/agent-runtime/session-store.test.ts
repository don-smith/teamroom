import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConversation, appendMessage } from "../../src/agent-runtime/session-store.js";

describe("session-store", () => {
  let file: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "tr-session-"));
    file = join(dir, "conversation.jsonl");
  });

  afterEach(() => rmSync(file, { force: true }));

  it("returns empty history when file missing", () => {
    expect(loadConversation(file)).toEqual([]);
  });

  it("loads lines into message history", () => {
    writeFileSync(
      file,
      `${JSON.stringify({ role: "user", content: "hi" })}\n${JSON.stringify({ role: "assistant", content: "hello" })}\n`,
    );
    expect(loadConversation(file)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("ignores malformed lines", () => {
    writeFileSync(file, `garbage\n${JSON.stringify({ role: "user", content: "ok" })}\n`);
    expect(loadConversation(file)).toEqual([{ role: "user", content: "ok" }]);
  });

  it("appendMessage adds one line atomically", () => {
    appendMessage(file, { role: "user", content: "a" });
    appendMessage(file, { role: "assistant", content: "b" });
    expect(loadConversation(file)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });
});
