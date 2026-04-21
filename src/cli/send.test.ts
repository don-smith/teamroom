import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMailPort, sendToDb, sendViaHttp } from "./send.js";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { MailMcpServer } from "../mail-mcp/server.js";
import { MailMcpTools } from "../mail-mcp/tools.js";
import { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import { CliChannelAdapter } from "../channels/cli.js";
import { EventBus } from "../bus/event-bus.js";
import { ControllableClock } from "../clock/clock.js";

describe("sendToDb", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-send-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "agents", "studio-assistant", "store"), { recursive: true });
    writeFileSync(join(dir, "agents", "studio-assistant", "AGENTS.md"), "prompt");
    writeFileSync(
      join(dir, "agents", "studio-assistant", "agent.yaml"),
      "name: studio-assistant\nmodel: m\nimage_tag: img\nprovider: lm-studio\n",
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
    expect(inbound[0]?.agentId).toBe("studio-assistant");
  });

  it("creates the agent row lazily if the daemon hasn't yet", async () => {
    await sendToDb({ repoRoot: dir, body: "a" });
    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const agents = new AgentRepo(db).findAll();
    expect(agents.map((a) => a.id)).toEqual(["studio-assistant"]);
  });

  it("rejects if no agents folder is present", async () => {
    rmSync(join(dir, "agents"), { recursive: true });
    await expect(sendToDb({ repoRoot: dir, body: "x" })).rejects.toThrow(/no agent/);
  });

  it("generates a non-null conversationId per CLI send", async () => {
    const result = await sendToDb({ repoRoot: dir, body: "hi" });
    expect(result.conversationId).toBeTruthy();
    expect(result.conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const msg = new MessageRepo(db).findById(result.messageId);
    expect(msg?.conversationId).toBe(result.conversationId);
  });
});

describe("readMailPort", () => {
  it("returns null when the port file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "teamroom-port-"));
    try {
      expect(readMailPort(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the parsed port when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "teamroom-port-"));
    try {
      mkdirSync(join(dir, "ports"), { recursive: true });
      writeFileSync(join(dir, "ports", "mail-mcp.port"), "43219\n");
      expect(readMailPort(dir)).toBe(43219);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null on invalid content", () => {
    const dir = mkdtempSync(join(tmpdir(), "teamroom-port-"));
    try {
      mkdirSync(join(dir, "ports"), { recursive: true });
      writeFileSync(join(dir, "ports", "mail-mcp.port"), "not-a-number");
      expect(readMailPort(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sendViaHttp", () => {
  it("POSTs to /cli/send and returns the dispatcher result", async () => {
    const { createDatabase: mkDb } = await import("../db/database.js");
    const db = mkDb(":memory:");
    runMigrations(db);
    new AgentRepo(db).create({ id: "claude-assistant", configPath: "/a", createdAt: "2026-04-20T00:00:00.000Z" });
    const repo = new MessageRepo(db);
    const bus = new EventBus();
    const clock = new ControllableClock("2026-04-20T10:00:00.000Z");
    let seq = 0;
    const dispatcher = new MailDispatcher({
      messageRepo: repo, bus, clock,
      genId: () => `id-${++seq}`,
      knownAgents: (n) => n === "claude-assistant",
      knownLists: () => false, listSubscribers: () => [],
      maxMailsPerThread: 10,
    });
    const tools = new MailMcpTools({ messageRepo: repo, dispatcher, bus, clock });
    const server = new MailMcpServer({
      tools,
      tokenResolver: () => null,
      cliAdapter: new CliChannelAdapter({ dispatcher }),
      port: 0,
    });
    await server.start();
    try {
      const r = await sendViaHttp({
        port: server.address().port,
        user: "don",
        target: "claude-assistant",
        body: "hi",
      });
      expect(r.threadId).toBeTruthy();
      const inbox = repo.listInbox("claude-assistant", {});
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.from).toBe("cli:don");
    } finally {
      await server.stop();
    }
  });

  it("rejects with a descriptive error when the daemon rejects", async () => {
    // No server running → fetch fails with a network error.
    await expect(
      sendViaHttp({ port: 1, user: "don", target: "x", body: "y" }),
    ).rejects.toThrow();
  });
});
