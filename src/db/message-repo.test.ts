import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "./database.js";
import { runMigrations } from "./migrator.js";
import { AgentRepo } from "./agent-repo.js";
import { MessageRepo } from "./message-repo.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({
    id: "assistant",
    configPath: "/abs/agents/assistant",
    createdAt: "2026-04-18T00:00:00.000Z",
  });
  return db;
}

describe("MessageRepo", () => {
  let db: Db;
  let repo: MessageRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new MessageRepo(db);
  });

  it("creates an inbound message and finds it as pending", () => {
    repo.create({
      id: "m1",
      agentId: "assistant",
      channel: "cli",
      direction: "in",
      body: "hello",
      turnId: null,
      traceId: "trace-1",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const pending = repo.findPendingInbound();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("m1");
  });

  it("excludes inbound messages that already have a turnId", () => {
    repo.create({
      id: "m1", agentId: "assistant", channel: "cli", direction: "in",
      body: "a", turnId: "t-1", traceId: "tr", createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.findPendingInbound()).toEqual([]);
  });

  it("attaches a turnId to a message", () => {
    repo.create({
      id: "m1", agentId: "assistant", channel: "cli", direction: "in",
      body: "a", turnId: null, traceId: "tr", createdAt: "2026-04-18T00:00:00.000Z",
    });
    repo.attachTurn("m1", "turn-abc");
    expect(repo.findPendingInbound()).toEqual([]);
    const found = repo.findById("m1");
    expect(found?.turnId).toBe("turn-abc");
  });

  it("finds outbound messages after a given message id (for tail)", () => {
    const base = "2026-04-18T00:00:00.000Z";
    repo.create({
      id: "o1", agentId: "assistant", channel: "cli", direction: "out",
      body: "r1", turnId: "t-1", traceId: "tr", createdAt: base,
    });
    repo.create({
      id: "o2", agentId: "assistant", channel: "cli", direction: "out",
      body: "r2", turnId: "t-1", traceId: "tr",
      createdAt: "2026-04-18T00:00:01.000Z",
    });
    const after = repo.findOutboundAfter("o1");
    expect(after.map((m) => m.id)).toEqual(["o2"]);
  });

  it("findOutboundAfter(null) returns all outbound", () => {
    const base = "2026-04-18T00:00:00.000Z";
    repo.create({
      id: "o1", agentId: "assistant", channel: "cli", direction: "out",
      body: "r1", turnId: "t-1", traceId: "tr", createdAt: base,
    });
    expect(repo.findOutboundAfter(null).map((m) => m.id)).toEqual(["o1"]);
  });
});
