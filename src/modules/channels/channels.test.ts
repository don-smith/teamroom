import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { composeChannels, type Channels } from "./channels.js";
import { composeStorage, type Storage } from "../storage/storage.js";
import { composeMessaging, type Messaging } from "../messaging/messaging.js";
import { composeMcpMail, type McpMail } from "../mcp-mail/mcp-mail.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";

describe("composeChannels", () => {
  let storage: Storage;
  let messaging: Messaging;
  let mcpMail: McpMail;
  let channels: Channels;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    const cfg: AgentConfig = {
      name: "alice", model: "m", imageTag: "img", provider: "anthropic", runtime: "anthropic",
      configPath: "/a", agentsMdPath: "/a/AGENTS.md", storePath: "/a/store",
      subscriptions: [], allowedTools: [],
      lifecycle: "session",
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

  it("starts the chat server on an ephemeral port and exposes the registry", () => {
    expect(channels.port).toBeGreaterThan(0);
    expect(channels.registry.listChannels()).toContain("cli");
  });

  it("the registry has cli and telegram pre-registered", () => {
    expect(channels.registry.has("cli")).toBe(true);
    expect(channels.registry.has("telegram")).toBe(true);
  });
});
