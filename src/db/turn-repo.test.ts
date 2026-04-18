import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "./database.js";
import { runMigrations } from "./migrator.js";
import { AgentRepo } from "./agent-repo.js";
import { MessageRepo } from "./message-repo.js";
import { TurnRepo } from "./turn-repo.js";

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
    });
    const t = repo.findById("t1");
    expect(t?.status).toBe("pending");
  });

  it("marks running with container id and startedAt", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr", startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
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
      createdAt: "2026-04-18T00:00:00.000Z",
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
      createdAt: "2026-04-18T00:00:00.000Z",
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
      createdAt: "2026-04-18T00:00:00.000Z",
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
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.countByStatus("pending")).toBe(1);
    expect(repo.countByStatus("done")).toBe(0);
  });

  it("returns latest done turn", () => {
    repo.create({
      id: "t1", agentId: "studio-assistant", inboundMessageId: "m1", status: "done",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:00.000Z", finishedAt: "2026-04-18T00:00:10.000Z",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.latestDone()?.id).toBe("t1");
  });
});
