import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WebSocket } from "ws";
import { ChannelRegistry } from "./channel-registry.js";
import { ChatServer } from "./chat-server.js";
import { composeStorage, type Storage } from "../storage/storage.js";
import { composeMessaging, type Messaging } from "../messaging/messaging.js";
import { composeMcpMail, type McpMail } from "../mcp-mail/mcp-mail.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";

async function closeWebSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    if (ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
    ws.close();
  });
}

describe("ChatServer", () => {
  let storage: Storage;
  let messaging: Messaging;
  let mcpMail: McpMail;
  let server: ChatServer;
  let registry: ChannelRegistry;
  const logger = new JsonLinesLogger(
    new ControllableClock("2026-04-20T00:00:00Z"),
    () => {},
    { component: "test" },
  );

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({
      id: "alice",
      configPath: "/a",
      createdAt: "2026-04-20T00:00:00Z",
    });
    const cfg: AgentConfig = {
      name: "alice",
      model: "m",
      imageTag: "img",
      provider: "openrouter",
      runtime: "pi",
      configPath: "/a",
      agentsMdPath: "/a/AGENTS.md",
      storePath: "/a/store",
      subscriptions: [],
      allowedTools: [],
      lifecycle: "session",
    };
    messaging = composeMessaging({ logger });
    let n = 0;
    const genId = () => `id-${++n}`;
    mcpMail = composeMcpMail({
      storage,
      messaging,
      logger,
      clock: new ControllableClock("2026-04-20T00:00:00Z"),
      genId,
      agentConfigs: new Map([["alice", cfg]]),
      lists: [],
      maxMailsPerThread: 10,
    });
    registry = new ChannelRegistry();
    registry.register("cli");
    server = new ChatServer({
      storage,
      messaging,
      mcpMail,
      registry,
      logger,
      port: 0,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    storage.close();
  });

  it("delivers outbound channel-addressed mail to a registered client", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    ws.send(JSON.stringify({ type: "register", channel: "cli", externalId: "don" }));
    // Tiny wait so the register message is processed before we publish.
    await new Promise((r) => setTimeout(r, 20));

    const received = new Promise<any>((ok) => {
      ws.on("message", (raw) => ok(JSON.parse(raw.toString())));
    });

    // Synthesize: alice replies to channel:cli:don via dispatcher.
    mcpMail.dispatcher.sendMail({
      from: "agent:alice",
      to: ["channel:cli:don"],
      body: "hi don",
      threadId: null,
    });

    const msg = await received;
    expect(msg.type).toBe("mail");
    expect(msg.body).toBe("hi don");
    expect(msg.from).toBe("agent:alice");
    expect(msg.to).toContain("channel:cli:don");
    await closeWebSocket(ws);
  });

  it("publishes inbound mail through the dispatcher (writes to recipient's inbox)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    ws.send(JSON.stringify({ type: "register", channel: "cli", externalId: "don" }));
    await new Promise((r) => setTimeout(r, 20));
    ws.send(
      JSON.stringify({
        type: "publish",
        to: ["agent:alice"],
        body: "hello alice",
        threadId: null,
        cc: [],
      }),
    );
    // Wait for dispatch
    await new Promise((r) => setTimeout(r, 50));
    const inbox = storage.messageRepo.listInbox("alice", { includeArchived: false });
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.body).toBe("hello alice");
    expect(inbox[0]?.from).toBe("channel:cli:don");
    await closeWebSocket(ws);
  });

  it("rejects publish from unregistered connection with a structured error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    const errorMsg = new Promise<any>((ok) => {
      ws.on("message", (raw) => ok(JSON.parse(raw.toString())));
    });
    ws.send(
      JSON.stringify({
        type: "publish",
        to: ["agent:alice"],
        body: "hi",
        threadId: null,
        cc: [],
      }),
    );
    const err = await errorMsg;
    expect(err.type).toBe("error");
    expect(err.code).toBe("not_registered");
    await closeWebSocket(ws);
  });

  it("rejects register for unknown channel with a structured error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    const errorMsg = new Promise<any>((ok) => {
      ws.on("message", (raw) => ok(JSON.parse(raw.toString())));
    });
    ws.send(JSON.stringify({ type: "register", channel: "telegram", externalId: "12345" }));
    const err = await errorMsg;
    expect(err.type).toBe("error");
    expect(err.code).toBe("unknown_channel");
    await closeWebSocket(ws);
  });

  it("disconnect removes the connection from the active set (no further deliveries)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    ws.send(JSON.stringify({ type: "register", channel: "cli", externalId: "don" }));
    await new Promise((r) => setTimeout(r, 20));
    await closeWebSocket(ws);
    // After disconnect, sending mail to channel:cli:don should NOT throw inside ChatServer
    // (no destination connection to deliver to; mail still lands in the DB row but no socket to forward to).
    // We just verify no exception bubbles up.
    expect(() =>
      mcpMail.dispatcher.sendMail({
        from: "agent:alice",
        to: ["channel:cli:don"],
        body: "ghost",
        threadId: null,
      }),
    ).not.toThrow();
  });
});
