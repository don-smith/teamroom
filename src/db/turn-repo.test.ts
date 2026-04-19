import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "./database.js";
import { runMigrations } from "./migrator.js";
import { AgentRepo } from "./agent-repo.js";
import { MessageRepo } from "./message-repo.js";
import { TurnRepo } from "./turn-repo.js";
import type { Turn } from "../types.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({
    id: "studio-assistant",
    configPath: "/abs",
    createdAt: "2026-04-18T00:00:00.000Z",
  });
  new MessageRepo(db).create({
    id: "m1",
    agentId: "studio-assistant",
    channel: "cli",
    direction: "in",
    body: "hi",
    turnId: null,
    traceId: "tr",
    createdAt: "2026-04-18T00:00:00.000Z",
    topic: "",
    fromAgentId: null,
    conversationId: null,
  });
  return db;
}

describe("TurnRepo", () => {
  let db: Db;
  let repo: TurnRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new TurnRepo(db);
  });

  it("creates a pending turn", () => {
    repo.create({
      id: "t1",
      agentId: "studio-assistant",
      inboundMessageId: "m1",
      status: "pending",
      containerId: null,
      error: null,
      traceId: "tr",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
      conversationId: null,
    });
    const t = repo.findById("t1");
    expect(t?.status).toBe("pending");
  });

  it("marks running with container id and startedAt", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr", startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    repo.markRunning("t1", "container-abc", "2026-04-18T00:00:01.000Z");
    const t = repo.findById("t1");
    expect(t?.status).toBe("running");
    expect(t?.containerId).toBe("container-abc");
    expect(t?.startedAt).toBe("2026-04-18T00:00:01.000Z");
  });

  it("marks done with finishedAt", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    repo.markDone("t1", "2026-04-18T00:00:02.000Z");
    expect(repo.findById("t1")?.status).toBe("done");
    expect(repo.findById("t1")?.finishedAt).toBe("2026-04-18T00:00:02.000Z");
  });

  it("marks error with error text and finishedAt", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    repo.markError("t1", "timeout", "2026-04-18T00:00:03.000Z");
    const t = repo.findById("t1");
    expect(t?.status).toBe("error");
    expect(t?.error).toBe("timeout");
    expect(t?.finishedAt).toBe("2026-04-18T00:00:03.000Z");
  });

  it("finds turns by status", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    const running = repo.findByStatus("running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe("t1");
  });

  it("counts by status", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr",
      startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    expect(repo.countByStatus("pending")).toBe(1);
    expect(repo.countByStatus("done")).toBe(0);
  });

  it("findAgedPending returns only pending rows with no containerId older than the cutoff", () => {
    // Aged pending, no container — should match.
    repo.create({
      id: "t-aged", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr",
      startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });
    // Fresh pending, no container — should be excluded.
    repo.create({
      id: "t-fresh", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr",
      startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:01:30.000Z", conversationId: null,
    });
    // Aged pending WITH container — should be excluded (container exists, runner can resync).
    repo.create({
      id: "t-with-container", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: "container-xyz", error: null, traceId: "tr",
      startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z", conversationId: null,
    });

    const cutoff = "2026-04-18T00:01:00.000Z";
    const aged = repo.findAgedPending(cutoff);
    expect(aged).toHaveLength(1);
    expect(aged[0]?.id).toBe("t-aged");
  });

  it("returns latest done turn", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "done",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:00.000Z", finishedAt: "2026-04-18T00:00:10.000Z",
      createdAt: "2026-04-18T00:00:00.000Z",
      conversationId: null,
    });
    expect(repo.latestDone()?.id).toBe("t1");
  });

  it("round-trips turns with conversationId", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "a1", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
    new MessageRepo(db).create({
      id: "m1", agentId: "a1", channel: "cli", direction: "in", body: "b",
      turnId: null, traceId: "t", createdAt: "2026-04-19T00:00:01Z",
      topic: "", fromAgentId: null, conversationId: "c1",
    });
    const repo = new TurnRepo(db);
    const turn: Turn = {
      id: "turn1", agentId: "a1", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "t",
      startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
      conversationId: "c1",
    };
    repo.create(turn);
    expect(repo.findById("turn1")).toEqual(turn);
  });

  it("counts turns by conversationId", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "a1", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
    new MessageRepo(db).create({
      id: "m1", agentId: "a1", channel: "cli", direction: "in", body: "b",
      turnId: null, traceId: "t", createdAt: "2026-04-19T00:00:01Z",
      topic: "", fromAgentId: null, conversationId: "c1",
    });
    const repo = new TurnRepo(db);
    for (let i = 0; i < 3; i += 1) {
      repo.create({
        id: `turn${i}`, agentId: "a1", inboundMessageId: "m1", status: "done",
        containerId: null, error: null, traceId: "t",
        startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
        conversationId: "c1",
      });
    }
    repo.create({
      id: "other", agentId: "a1", inboundMessageId: "m1", status: "done",
      containerId: null, error: null, traceId: "t",
      startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
      conversationId: "c-other",
    });
    expect(repo.countByConversationId("c1")).toBe(3);
    expect(repo.countByConversationId("c-other")).toBe(1);
    expect(repo.countByConversationId("nonexistent")).toBe(0);
  });
});
