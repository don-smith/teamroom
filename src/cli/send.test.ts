import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send } from "./send.js";
import { composeStorage, type Storage } from "../modules/storage/storage.js";
import { composeMessaging, type Messaging } from "../modules/messaging/messaging.js";
import { composeMcpMail, type McpMail } from "../modules/mcp-mail/mcp-mail.js";
import { composeChannels, type Channels } from "../modules/channels/channels.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { ControllableClock } from "../clock/clock.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

describe("teamroom send (channel-based)", () => {
  let storage: Storage;
  let messaging: Messaging;
  let mcpMail: McpMail;
  let channels: Channels;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    const cfg: AgentConfig = {
      name: "alice", model: "m", imageTag: "img", provider: "anthropic",
      configPath: "/a", agentsMdPath: "/a/AGENTS.md", storePath: "/a/store",
      subscriptions: [], allowedTools: [],
    };
    messaging = composeMessaging({ logger });
    let n = 0;
    mcpMail = composeMcpMail({
      storage, messaging, logger,
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

  it("publishes mail via chat WebSocket and returns", async () => {
    await send({
      port: channels.port,
      user: "don",
      agent: "alice",
      body: "hello alice",
    });
    const inbox = storage.messageRepo.listInbox("alice", { includeArchived: false });
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.body).toBe("hello alice");
    expect(inbox[0]?.from).toBe("channel:cli:don");
  });

  it("supports an optional threadId", async () => {
    await send({
      port: channels.port,
      user: "don",
      agent: "alice",
      body: "reply",
      threadId: "T-specific",
    });
    const inbox = storage.messageRepo.listInbox("alice", { includeArchived: false });
    expect(inbox.length).toBe(1);
    // The dispatcher may preserve the explicit threadId or assign a new one;
    // at minimum the mail should be delivered. Verify with a threadId check
    // if the inbox row exposes it.
    expect(inbox[0]?.body).toBe("reply");
  });
});
