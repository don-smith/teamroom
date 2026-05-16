import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { runChat } from "./chat.js";
import { composeStorage, type Storage } from "../modules/storage/storage.js";
import { composeMessaging, type Messaging } from "../modules/messaging/messaging.js";
import { composeMcpMail, type McpMail } from "../modules/mcp-mail/mcp-mail.js";
import { composeChannels, type Channels } from "../modules/channels/channels.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { ControllableClock } from "../clock/clock.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

describe("teamroom chat (interactive REPL)", () => {
  let storage: Storage;
  let messaging: Messaging;
  let mcpMail: McpMail;
  let channels: Channels;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    const cfg: AgentConfig = {
      name: "alice",
      model: "m",
      imageTag: "img",
      provider: "anthropic",
      runtime: "anthropic",
      configPath: "/a",
      agentsMdPath: "/a/AGENTS.md",
      storePath: "/a/store",
      subscriptions: [],
      allowedTools: [],
    };
    messaging = composeMessaging({ logger });
    let n = 0;
    mcpMail = composeMcpMail({
      storage,
      messaging,
      logger,
      clock: new ControllableClock("2026-04-20T00:00:00Z"),
      genId: () => `id-${++n}`,
      agentConfigs: new Map([["alice", cfg]]),
      lists: [],
      maxMailsPerThread: 10,
    });
    channels = await composeChannels({ storage, messaging, mcpMail, logger, port: 0 });
  });

  afterEach(async () => {
    await channels.stop();
    storage.close();
  });

  it("sends initial body, prints replies, exits on /quit", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const outChunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => outChunks.push(chunk.toString()));

    const runPromise = runChat({
      port: channels.port,
      agent: "alice",
      user: "don",
      initialBody: "hi alice",
      stdin,
      stdout,
    });

    // Give the CLI time to register + send the initial publish
    await new Promise((r) => setTimeout(r, 50));

    // Simulate alice replying to channel:cli:don
    mcpMail.dispatcher.sendMail({
      from: "agent:alice",
      to: ["channel:cli:don"],
      body: "hello don",
      threadId: null,
    });

    // Wait for the reply to print
    await new Promise((r) => setTimeout(r, 50));

    // User quits
    stdin.end("/quit\n");

    await runPromise;

    // Alice's inbox got the initial message
    expect(storage.messageRepo.listInbox("alice", { includeArchived: false }).length).toBe(1);
    expect(storage.messageRepo.listInbox("alice", { includeArchived: false })[0]?.body).toBe("hi alice");

    // stdout has the reply
    const out = outChunks.join("");
    expect(out).toContain("hello don");
  });

  it("exits on /exit", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const runPromise = runChat({
      port: channels.port,
      agent: "alice",
      user: "don",
      stdin,
      stdout,
    });
    await new Promise((r) => setTimeout(r, 30));
    stdin.end("/exit\n");
    await runPromise;
  });

  it("sends each stdin line as a separate publish", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const runPromise = runChat({
      port: channels.port,
      agent: "alice",
      user: "don",
      stdin,
      stdout,
    });
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("first line\n");
    stdin.write("second line\n");
    await new Promise((r) => setTimeout(r, 50));
    stdin.end("/quit\n");
    await runPromise;

    const inbox = storage.messageRepo.listInbox("alice", { includeArchived: false });
    expect(inbox.length).toBe(2);
    const bodies = inbox.map((r) => r.body).sort();
    expect(bodies).toEqual(["first line", "second line"]);
  });

  it("ignores blank lines (no empty publish)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const runPromise = runChat({
      port: channels.port,
      agent: "alice",
      user: "don",
      stdin,
      stdout,
    });
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\n");
    stdin.write("   \n");
    stdin.write("real\n");
    await new Promise((r) => setTimeout(r, 50));
    stdin.end("/quit\n");
    await runPromise;

    const inbox = storage.messageRepo.listInbox("alice", { includeArchived: false });
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.body).toBe("real");
  });
});
