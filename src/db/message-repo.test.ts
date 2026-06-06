import { beforeEach, describe, expect, it } from "bun:test";
import { createDatabase, type Db } from "./database.js";
import { runMigrations } from "./migrator.js";
import { AgentRepo } from "./agent-repo.js";
import { MessageRepo } from "./message-repo.js";
import type { Message } from "../types.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({
    id: "studio-assistant",
    configPath: "/abs/agents/studio-assistant",
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

  it("round-trips DM-shaped messages with topic/from/conversation", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "claude-assistant", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
    const repo = new MessageRepo(db);
    const msg: Message = {
      id: "m1",
      agentId: "claude-assistant",
      channel: "dm",
      direction: "in",
      body: "hi",
      traceId: "t1",
      createdAt: "2026-04-19T00:00:01Z",
      topic: "claude-assistant",
      fromAgentId: "studio-assistant",
      conversationId: "c1",
      to: [],
      from: null,
      cc: null,
      subject: null,
      threadId: null,
      readAt: null,
      archivedAt: null,
      deletedAt: null,
    };
    repo.create(msg);
    expect(repo.findById("m1")).toEqual(msg);
  });

  it("defaults M2-style CLI messages to empty topic + null from/conversation", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "claude-assistant", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
    const repo = new MessageRepo(db);
    const msg: Message = {
      id: "m2",
      agentId: "claude-assistant",
      channel: "cli",
      direction: "in",
      body: "hi",
      traceId: "t2",
      createdAt: "2026-04-19T00:00:01Z",
      topic: "",
      fromAgentId: null,
      conversationId: null,
      to: [],
      from: null,
      cc: null,
      subject: null,
      threadId: null,
      readAt: null,
      archivedAt: null,
      deletedAt: null,
    };
    repo.create(msg);
    expect(repo.findById("m2")).toEqual(msg);
  });
});

describe("MessageRepo — M4 additions", () => {
  let db: Db;
  let repo: MessageRepo;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "claude-assistant", configPath: "/a", createdAt: "2026-04-20T00:00:00.000Z" });
    new AgentRepo(db).create({ id: "claude-researcher", configPath: "/r", createdAt: "2026-04-20T00:00:00.000Z" });
    repo = new MessageRepo(db);
  });

  it("round-trips to/from/cc/subject/thread_id fields", () => {
    repo.create({
      id: "m1",
      agentId: "claude-assistant",
      channel: "mail",
      direction: "in",
      body: "hello",
      traceId: "t1",
      createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"],
      from: "channel:cli:don",
      cc: ["agent:claude-researcher"],
      subject: "greetings",
      threadId: "T1",
    });
    const got = repo.findById("m1");
    expect(got).not.toBeNull();
    expect(got!.to).toEqual(["agent:claude-assistant"]);
    expect(got!.from).toBe("channel:cli:don");
    expect(got!.cc).toEqual(["agent:claude-researcher"]);
    expect(got!.subject).toBe("greetings");
    expect(got!.threadId).toBe("T1");
    expect(got!.readAt).toBeNull();
    expect(got!.archivedAt).toBeNull();
    expect(got!.deletedAt).toBeNull();
  });

  it("distinguishes null cc from empty-array cc after round-trip", () => {
    repo.create({
      id: "m-null", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "x", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", cc: null, threadId: "T",
    });
    repo.create({
      id: "m-empty", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "y", traceId: "t", createdAt: "2026-04-20T10:00:01.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", cc: [], threadId: "T",
    });
    expect(repo.findById("m-null")!.cc).toBeNull();
    expect(repo.findById("m-empty")!.cc).toEqual([]);
  });

  it("softDelete sets deleted_at and hides from listInbox", () => {
    repo.create({
      id: "m1", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "x", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", threadId: "T1",
    });
    repo.softDelete("m1", "2026-04-20T11:00:00.000Z");
    expect(repo.listInbox("claude-assistant", {})).toHaveLength(0);
    expect(repo.findById("m1")!.deletedAt).toBe("2026-04-20T11:00:00.000Z");
  });

  it("markRead sets read_at; unreadOnly filter respects it", () => {
    repo.create({
      id: "m1", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "x", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", threadId: "T1",
    });
    repo.markRead("m1", "2026-04-20T10:05:00.000Z");
    expect(repo.listInbox("claude-assistant", { unreadOnly: true })).toHaveLength(0);
    expect(repo.listInbox("claude-assistant", { unreadOnly: false })).toHaveLength(1);
  });

  it("archive sets archived_at; default listInbox excludes, includeArchived re-includes", () => {
    repo.create({
      id: "m1", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "x", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", threadId: "T1",
    });
    repo.archive("m1", "2026-04-20T10:05:00.000Z");
    expect(repo.listInbox("claude-assistant", {})).toHaveLength(0);
    expect(repo.listInbox("claude-assistant", { includeArchived: true })).toHaveLength(1);
  });

  it("listInbox scopes to caller, filters on thread, respects limit", () => {
    const mk = (id: string, agentId: string, threadId: string, t: string) =>
      repo.create({
        id, agentId, channel: "mail", direction: "in", body: id,
        traceId: "t", createdAt: t,
        to: [`agent:${agentId}`], from: "channel:cli:don", threadId,
      });
    mk("a1", "claude-assistant", "T1", "2026-04-20T10:00:00.000Z");
    mk("a2", "claude-assistant", "T2", "2026-04-20T10:00:01.000Z");
    mk("r1", "claude-researcher", "T1", "2026-04-20T10:00:02.000Z");

    expect(repo.listInbox("claude-assistant", {}).map((m) => m.id).sort()).toEqual(["a1", "a2"]);
    expect(repo.listInbox("claude-researcher", {}).map((m) => m.id)).toEqual(["r1"]);
    expect(repo.listInbox("claude-assistant", { threadId: "T1" }).map((m) => m.id)).toEqual(["a1"]);
    expect(repo.listInbox("claude-assistant", { limit: 1 })).toHaveLength(1);
  });

  it("countInThread counts non-deleted rows across agents", () => {
    repo.create({
      id: "m1", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "x", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", threadId: "T1",
    });
    repo.create({
      id: "m2", agentId: "claude-researcher", channel: "mail", direction: "in",
      body: "y", traceId: "t", createdAt: "2026-04-20T10:00:01.000Z",
      to: ["agent:claude-researcher"], from: "channel:cli:don", threadId: "T1",
    });
    repo.create({
      id: "m3", agentId: "claude-assistant", channel: "mail", direction: "in",
      body: "z", traceId: "t", createdAt: "2026-04-20T10:00:02.000Z",
      to: ["agent:claude-assistant"], from: "channel:cli:don", threadId: "T2",
    });
    expect(repo.countInThread("T1")).toBe(2);
    expect(repo.countInThread("T2")).toBe(1);
    repo.softDelete("m1", "2026-04-20T10:10:00.000Z");
    expect(repo.countInThread("T1")).toBe(1);
  });

  it("listCliOutbound returns CLI outbound rows newest-first", () => {
    repo.create({
      id: "o1", agentId: "claude-assistant", channel: "cli", direction: "out",
      body: "r1", traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      threadId: "T1",
    });
    repo.create({
      id: "o2", agentId: "claude-assistant", channel: "cli", direction: "out",
      body: "r2", traceId: "t", createdAt: "2026-04-20T10:00:01.000Z",
      threadId: "T1",
    });
    expect(repo.listCliOutbound().map((m) => m.id)).toEqual(["o2", "o1"]);
  });
});
