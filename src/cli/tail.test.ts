import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailRun } from "./tail.js";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";

describe("tailRun", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-tail-"));
    mkdirSync(join(dir, "data", "bus"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints outbound messages as they are published on the bus", async () => {
    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    new AgentRepo(db).create({ id: "studio-assistant", configPath: "/abs", createdAt: "2026-04-18T00:00:00.000Z" });
    const messageRepo = new MessageRepo(db);
    messageRepo.create({
      id: "o-1", agentId: "studio-assistant", channel: "cli", direction: "out",
      body: "hello world", turnId: "t-1", traceId: "tr-1",
      createdAt: new Date().toISOString(),
      topic: "", fromAgentId: null, conversationId: null,
    });
    db.close();

    const bus = new FileNotifyBus(join(dir, "data", "bus"));
    const output: string[] = [];
    const run = tailRun({
      repoRoot: dir,
      options: { json: false, verbose: false },
      out: (line) => output.push(line),
      stopAfter: 1,
    });

    // Wait a tick so subscribe is registered, then publish
    await new Promise((r) => setTimeout(r, 100));
    await bus.publish({
      id: "e-1",
      type: "message.outbound",
      ts: new Date().toISOString(),
      agentId: "studio-assistant",
      messageId: "o-1",
      turnId: "t-1",
      traceId: "tr-1",
    });

    await run;
    await bus.close();

    expect(output.some((l) => l.includes("hello world"))).toBe(true);
  });
});
