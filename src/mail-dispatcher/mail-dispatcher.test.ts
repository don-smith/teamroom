import { beforeEach, describe, expect, it } from "vitest";
import { MailDispatcher } from "./mail-dispatcher.js";
import { EventBus } from "../bus/event-bus.js";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { ControllableClock } from "../clock/clock.js";

interface Harness {
  dispatcher: MailDispatcher;
  messageRepo: MessageRepo;
  bus: EventBus;
  nextId: () => string;
}

function makeHarness(opts: {
  knownAgents?: string[];
  knownLists?: Record<string, string[]>;
  maxMailsPerThread?: number;
} = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  const knownAgents = opts.knownAgents ?? ["claude-assistant", "claude-researcher"];
  for (const name of knownAgents) {
    agentRepo.create({ id: name, configPath: `/agents/${name}`, createdAt: "2026-04-20T00:00:00.000Z" });
  }
  const messageRepo = new MessageRepo(db);
  const bus = new EventBus();
  const clock = new ControllableClock("2026-04-20T10:00:00.000Z");
  let seq = 0;
  const nextId = () => `id-${++seq}`;
  const lists = opts.knownLists ?? {};
  const dispatcher = new MailDispatcher({
    messageRepo,
    bus,
    clock,
    genId: nextId,
    knownAgents: (n) => knownAgents.includes(n),
    knownLists: (n) => Object.prototype.hasOwnProperty.call(lists, n),
    listSubscribers: (n) => lists[n] ?? [],
    maxMailsPerThread: opts.maxMailsPerThread ?? 10,
  });
  return { dispatcher, messageRepo, bus, nextId };
}

describe("MailDispatcher — agent recipient", () => {
  it("inserts one email row in the recipient agent's inbox", () => {
    const { dispatcher, messageRepo, bus } = makeHarness();
    const events: unknown[] = [];
    bus.subscribe("mail.delivered", (p) => events.push(p));

    const result = dispatcher.sendMail({
      from: "cli:don",
      to: ["agent:claude-assistant"],
      body: "hi",
    });

    expect(result.threadId).toBeTruthy();
    const rows = messageRepo.listInbox("claude-assistant", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from).toBe("cli:don");
    expect(rows[0]!.to).toEqual(["agent:claude-assistant"]);
    expect(rows[0]!.body).toBe("hi");
    expect(rows[0]!.threadId).toBe(result.threadId);
    expect(events).toEqual([{ to: "claude-assistant" }]);
  });

  it("mints a fresh thread_id when none is provided", () => {
    const { dispatcher } = makeHarness();
    const r1 = dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "a" });
    const r2 = dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "b" });
    expect(r1.threadId).not.toBe(r2.threadId);
  });

  it("inherits thread_id when explicitly provided", () => {
    const { dispatcher, messageRepo } = makeHarness();
    const r1 = dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "first" });
    const r2 = dispatcher.sendMail({
      from: "cli:don",
      to: ["agent:claude-assistant"],
      body: "second",
      threadId: r1.threadId,
    });
    expect(r2.threadId).toBe(r1.threadId);
    const rows = messageRepo.listInbox("claude-assistant", { threadId: r1.threadId });
    expect(rows).toHaveLength(2);
  });

  it("publishes mail.sent when the sender is an agent", () => {
    const { dispatcher, bus } = makeHarness();
    const sent: unknown[] = [];
    bus.subscribe("mail.sent", (p) => sent.push(p));

    dispatcher.sendMail({
      from: "agent:claude-assistant",
      to: ["agent:claude-researcher"],
      body: "peek",
    });

    expect(sent).toEqual([{ from: "claude-assistant" }]);
  });

  it("does not publish mail.sent when the sender is cli:*", () => {
    const { dispatcher, bus } = makeHarness();
    const sent: unknown[] = [];
    bus.subscribe("mail.sent", (p) => sent.push(p));
    dispatcher.sendMail({ from: "cli:don", to: ["agent:claude-assistant"], body: "x" });
    expect(sent).toEqual([]);
  });

  it("sets to[] on every recipient row after list expansion", () => {
    const { dispatcher, messageRepo } = makeHarness({
      knownAgents: ["A", "B", "C"],
      knownLists: { team: ["A", "B", "C"] },
      maxMailsPerThread: 0,
    });

    dispatcher.sendMail({ from: "agent:A", to: ["list:team"], body: "announce" });
    for (const who of ["A", "B", "C"]) {
      const rows = messageRepo.listInbox(who, {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.to!.slice().sort()).toEqual(["agent:A", "agent:B", "agent:C"]);
      expect(rows[0]!.body).toBe("announce");
    }
  });
});

describe("MailDispatcher — cli recipient", () => {
  it("inserts a CLI outbound row, no email row, publishes channel.cli.out", () => {
    const { dispatcher, messageRepo, bus } = makeHarness();
    const out: unknown[] = [];
    bus.subscribe("channel.cli.out", (p) => out.push(p));

    dispatcher.sendMail({
      from: "agent:claude-assistant",
      to: ["cli:don"],
      body: "done",
    });

    const cliRows = messageRepo.listCliOutbound();
    expect(cliRows).toHaveLength(1);
    expect(cliRows[0]!.body).toBe("done");
    expect(cliRows[0]!.channel).toBe("cli");
    expect(cliRows[0]!.direction).toBe("out");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      user: "don",
      agentId: "claude-assistant",
      messageId: cliRows[0]!.id,
    });

    // And no inbox row anywhere for a cli:* recipient.
    expect(messageRepo.listInbox("claude-assistant", {})).toHaveLength(0);
  });
});

describe("MailDispatcher — validation", () => {
  it("atomically rejects when any agent recipient is unknown", () => {
    const { dispatcher, messageRepo } = makeHarness();
    expect(() =>
      dispatcher.sendMail({
        from: "cli:don",
        to: ["agent:ghost", "agent:claude-assistant"],
        body: "x",
      }),
    ).toThrow(/unknown recipient.*ghost/i);

    // Known recipient must NOT have received a row.
    expect(messageRepo.listInbox("claude-assistant", {})).toHaveLength(0);
  });

  it("rejects unknown list recipients", () => {
    const { dispatcher } = makeHarness();
    expect(() =>
      dispatcher.sendMail({
        from: "cli:don",
        to: ["list:ghost"],
        body: "x",
      }),
    ).toThrow(/unknown recipient.*list:ghost/i);
  });

  it("rejects invalid address strings outright", () => {
    const { dispatcher } = makeHarness();
    expect(() =>
      dispatcher.sendMail({ from: "cli:don", to: ["no-prefix"], body: "x" }),
    ).toThrow();
  });

  it("a list with zero subscribers produces no rows but succeeds", () => {
    const { dispatcher, messageRepo } = makeHarness({
      knownLists: { empty: [] },
    });
    expect(() =>
      dispatcher.sendMail({ from: "cli:don", to: ["list:empty"], body: "x" }),
    ).not.toThrow();
    expect(messageRepo.listInbox("claude-assistant", {})).toHaveLength(0);
    expect(messageRepo.listInbox("claude-researcher", {})).toHaveLength(0);
  });
});

describe("MailDispatcher — thread cap", () => {
  it("rejects a send that would push the thread past the cap", () => {
    const { dispatcher, messageRepo } = makeHarness({ maxMailsPerThread: 10 });
    const seedThreadId = "T1";
    for (let i = 0; i < 10; i++) {
      messageRepo.create({
        id: `m${i}`,
        agentId: "claude-assistant",
        channel: "mail",
        direction: "in",
        body: `#${i}`,
        turnId: null,
        traceId: `tr${i}`,
        createdAt: `2026-04-20T10:0${i}:00.000Z`,
        threadId: seedThreadId,
      });
    }
    expect(() =>
      dispatcher.sendMail({
        from: "cli:don",
        to: ["agent:claude-assistant"],
        body: "one more",
        threadId: seedThreadId,
      }),
    ).toThrow(/thread cap/i);
  });

  it("cap=0 disables the cap", () => {
    const { dispatcher, messageRepo } = makeHarness({ maxMailsPerThread: 0 });
    for (let i = 0; i < 50; i++) {
      messageRepo.create({
        id: `m${i}`,
        agentId: "claude-assistant",
        channel: "mail",
        direction: "in",
        body: "",
        turnId: null,
        traceId: `tr${i}`,
        createdAt: "2026-04-20T10:00:00.000Z",
        threadId: "T",
      });
    }
    expect(() =>
      dispatcher.sendMail({
        from: "cli:don",
        to: ["agent:claude-assistant"],
        body: "x",
        threadId: "T",
      }),
    ).not.toThrow();
  });

  it("counts every expanded recipient toward the cap", () => {
    const { dispatcher, messageRepo } = makeHarness({
      maxMailsPerThread: 3,
      knownAgents: ["A", "B", "C"],
      knownLists: { team: ["A", "B", "C"] },
    });
    // First send: 3 rows into thread T.
    dispatcher.sendMail({ from: "agent:A", to: ["list:team"], body: "x", threadId: "T" });
    // A second send to the same thread would add 3 more → exceeds cap.
    expect(() =>
      dispatcher.sendMail({ from: "agent:A", to: ["list:team"], body: "y", threadId: "T" }),
    ).toThrow(/thread cap/i);
    // A single-recipient send would also exceed (3+1>3).
    expect(() =>
      dispatcher.sendMail({ from: "agent:A", to: ["agent:B"], body: "z", threadId: "T" }),
    ).toThrow(/thread cap/i);
  });
});
