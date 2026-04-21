import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailMcpServer } from "./server.js";
import { MailMcpTools } from "./tools.js";
import { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import { EventBus } from "../bus/event-bus.js";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { ControllableClock } from "../clock/clock.js";

type Harness = {
  server: MailMcpServer;
  port: number;
  url: string;
  tokens: Map<string, string>;
  messageRepo: MessageRepo;
};

async function startServer(agents: string[]): Promise<Harness> {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  for (const id of agents) {
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
    knownAgents: (n) => agents.includes(n),
    knownLists: () => false,
    listSubscribers: () => [],
    maxMailsPerThread: 10,
  });
  const tools = new MailMcpTools({ messageRepo, dispatcher, bus, clock });
  const tokens = new Map<string, string>();
  for (const id of agents) tokens.set(`tok-${id}`, id);

  const server = new MailMcpServer({
    tools,
    tokenResolver: (t) => tokens.get(t) ?? null,
    port: 0,
  });
  await server.start();
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}/mcp`, tokens, messageRepo };
}

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // MCP Streamable HTTP spec requires the client to accept both content types.
    accept: "application/json, text/event-stream",
  };
  if (token !== undefined) headers["x-teamroom-mcp-token"] = token;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("MailMcpServer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer(["claude-assistant", "claude-researcher"]);
  });


  afterEach(async () => {
    await h.server.stop();
  });

  it("rejects requests with no token", async () => {
    const r = await post(h.url, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.status).toBe(401);
  });

  it("rejects requests with an unknown token", async () => {
    const r = await post(
      h.url,
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "bogus",
    );
    expect(r.status).toBe(401);
  });

  it("answers initialize with capabilities + protocolVersion", async () => {
    const r = await post(
      h.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      },
      "tok-claude-assistant",
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("teamroom-mail");
  });

  it("tools/list enumerates the seven mail tools", async () => {
    const r = await post(
      h.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "tok-claude-assistant",
    );
    const body = await r.json();
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "mail.archive",
      "mail.delete",
      "mail.get",
      "mail.list",
      "mail.mark_read",
      "mail.reply",
      "mail.send",
    ]);
  });

  it("notifications/initialized returns 202 with no body", async () => {
    const r = await post(
      h.url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "tok-claude-assistant",
    );
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("tools/call mail.send delegates to dispatcher scoped to the token's agent", async () => {
    const r = await post(
      h.url,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mail.send",
          arguments: { to: ["agent:claude-researcher"], body: "hi" },
        },
      },
      "tok-claude-assistant",
    );
    const body = await r.json();
    expect(body.result.content[0].type).toBe("text");
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.threadId).toBeTruthy();
    // structuredContent mirrors the text payload for clients that support it.
    expect(body.result.structuredContent.threadId).toBe(parsed.threadId);
  });

  it("unknown method returns a -32601 error", async () => {
    const r = await post(
      h.url,
      { jsonrpc: "2.0", id: 4, method: "not/real" },
      "tok-claude-assistant",
    );
    const body = await r.json();
    expect(body.error.code).toBe(-32601);
  });

  it("unknown tool returns a -32601 error", async () => {
    const r = await post(
      h.url,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "mail.not-a-tool", arguments: {} },
      },
      "tok-claude-assistant",
    );
    const body = await r.json();
    expect(body.error.code).toBe(-32601);
  });

  it("batch requests return an array of responses in order", async () => {
    const r = await post(
      h.url,
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      "tok-claude-assistant",
    );
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe(1);
    expect(body[1].id).toBe(2);
  });

  it("non-POST returns 404", async () => {
    const r = await fetch(h.url, { method: "GET" });
    expect(r.status).toBe(404);
  });

  it("malformed JSON returns 400", async () => {
    const r = await fetch(h.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "x-teamroom-mcp-token": "tok-claude-assistant",
      },
      body: "{not valid",
    });
    expect(r.status).toBe(400);
  });
});

