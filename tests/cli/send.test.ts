import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToDb } from "../../src/cli/send.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";

describe("sendToDb", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-send-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "agents", "assistant", "store"), { recursive: true });
    writeFileSync(join(dir, "agents", "assistant", "AGENTS.md"), "prompt");
    writeFileSync(
      join(dir, "agents", "assistant", "agent.yaml"),
      "name: assistant\nmodel: m\nimage_tag: img\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("inserts an inbound message for the sole agent", async () => {
    const result = await sendToDb({ repoRoot: dir, body: "hello" });
    expect(result.traceId).toMatch(/^[0-9a-f-]+$/);

    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const inbound = new MessageRepo(db).findPendingInbound();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.body).toBe("hello");
    expect(inbound[0]?.channel).toBe("cli");
    expect(inbound[0]?.direction).toBe("in");
    expect(inbound[0]?.agentId).toBe("assistant");
  });

  it("creates the agent row lazily if the daemon hasn't yet", async () => {
    await sendToDb({ repoRoot: dir, body: "a" });
    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const agents = new AgentRepo(db).findAll();
    expect(agents.map((a) => a.id)).toEqual(["assistant"]);
  });

  it("rejects if no agents folder is present", async () => {
    rmSync(join(dir, "agents"), { recursive: true });
    await expect(sendToDb({ repoRoot: dir, body: "x" })).rejects.toThrow(/no agent/);
  });
});
