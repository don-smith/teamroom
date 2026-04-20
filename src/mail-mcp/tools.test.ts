import { beforeEach, describe, expect, it } from "vitest";
import { MailMcpTools } from "./tools.js";
import { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import { EventBus } from "../bus/event-bus.js";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { ControllableClock } from "../clock/clock.js";

function setup(knownAgents = ["A", "B", "C"]) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  for (const id of knownAgents) {
    agentRepo.create({ id, configPath: `/a/${id}`, createdAt: "2026-04-20T00:00:00.000Z" });
  }
  const messageRepo = new MessageRepo(db);
  const bus = new EventBus();
  const clock = new ControllableClock("2026-04-20T10:00:00.000Z");
  let seq = 0;
  const dispatcher = new MailDispatcher({
    messageRepo,
    bus,
    clock,
    genId: () => `id-${++seq}`,
    knownAgents: (n) => knownAgents.includes(n),
    knownLists: () => false,
    listSubscribers: () => [],
    maxMailsPerThread: 10,
  });
  const tools = new MailMcpTools({ messageRepo, dispatcher, bus, clock });
  return { tools, messageRepo, bus, clock };
}

describe("MailMcpTools", () => {
  it("list returns only the caller's inbox", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "m1", agentId: "A", channel: "mail", direction: "in", body: "x",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "cli:don", threadId: "T1",
    });
    messageRepo.create({
      id: "m2", agentId: "B", channel: "mail", direction: "in", body: "y",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:B"], from: "cli:don", threadId: "T2",
    });
    const aRows = tools.list({ callerAgentId: "A" }, {});
    expect(aRows.map((r) => r.id)).toEqual(["m1"]);
    const bRows = tools.list({ callerAgentId: "B" }, {});
    expect(bRows.map((r) => r.id)).toEqual(["m2"]);
  });

  it("list publishes tool.call on bus", () => {
    const { tools, bus } = setup();
    const calls: unknown[] = [];
    bus.subscribe("tool.call", (p) => calls.push(p));
    tools.list({ callerAgentId: "A" }, {});
    expect(calls).toEqual([{ agentId: "A", tool: "mail.list" }]);
  });

  it("get returns the row when caller owns it", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "cli:don", threadId: "T1",
    });
    const got = tools.get({ callerAgentId: "A" }, { id: "r1" });
    expect(got.id).toBe("r1");
  });

  it("get refuses cross-agent access (returns 'mail not found')", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "cli:don", threadId: "T1",
    });
    expect(() => tools.get({ callerAgentId: "B" }, { id: "r1" })).toThrow(/not found/i);
  });

  it("send delegates to dispatcher and uses agent: prefix for the sender", () => {
    const { tools, messageRepo } = setup();
    const r = tools.send(
      { callerAgentId: "A" },
      { to: ["agent:B"], body: "hey" },
    );
    expect(r.threadId).toBeTruthy();
    const bRows = messageRepo.listInbox("B", {});
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.from).toBe("agent:A");
  });

  it("reply sets to=[original.from] and inherits thread_id", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "agent:B", threadId: "T1",
    });
    const r = tools.reply({ callerAgentId: "A" }, { id: "r1", body: "hello back" });
    expect(r.threadId).toBe("T1");
    const bRows = messageRepo.listInbox("B", {});
    expect(bRows.some((m) => m.body === "hello back" && m.threadId === "T1")).toBe(true);
  });

  it("reply cc_all=true includes original to/cc minus self and parent.from", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A", "agent:C"], from: "agent:B", cc: null, threadId: "T1",
    });
    tools.reply({ callerAgentId: "A" }, { id: "r1", body: "hello", ccAll: true });
    const cRows = messageRepo.listInbox("C", {});
    const last = cRows.find((m) => m.body === "hello");
    expect(last).toBeDefined();
    // to goes to original.from; cc drops self (A) and the direct recipient (B),
    // keeping C so the whole group still sees it under the same thread.
    expect(last!.to).toEqual(["agent:B"]);
    expect(last!.cc).toEqual(["agent:C"]);
  });

  it("reply without cc_all leaves cc unset", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "agent:B", threadId: "T1",
    });
    tools.reply({ callerAgentId: "A" }, { id: "r1", body: "hello" });
    const bRows = messageRepo.listInbox("B", {});
    const last = bRows.find((m) => m.body === "hello");
    expect(last!.cc).toBeNull();
  });

  it("mark_read / archive / delete set the expected timestamps", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "cli:don", threadId: "T1",
    });
    tools.markRead({ callerAgentId: "A" }, { id: "r1" });
    expect(messageRepo.findById("r1")!.readAt).toBeTruthy();
    tools.archive({ callerAgentId: "A" }, { id: "r1" });
    expect(messageRepo.findById("r1")!.archivedAt).toBeTruthy();
    tools.delete({ callerAgentId: "A" }, { id: "r1" });
    expect(messageRepo.findById("r1")!.deletedAt).toBeTruthy();
  });

  it("mark_read / archive / delete fail for rows the caller does not own", () => {
    const { tools, messageRepo } = setup();
    messageRepo.create({
      id: "r1", agentId: "A", channel: "mail", direction: "in", body: "hi",
      turnId: null, traceId: "t", createdAt: "2026-04-20T10:00:00.000Z",
      to: ["agent:A"], from: "cli:don", threadId: "T1",
    });
    expect(() => tools.markRead({ callerAgentId: "B" }, { id: "r1" })).toThrow(/not found/);
    expect(() => tools.archive({ callerAgentId: "B" }, { id: "r1" })).toThrow(/not found/);
    expect(() => tools.delete({ callerAgentId: "B" }, { id: "r1" })).toThrow(/not found/);
  });
});
