import { describe, expect, it, vi } from "vitest";
import { composeStorage } from "../storage/storage.js";
import { composeMessaging } from "../messaging/messaging.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";
import { composeMcpMail } from "./mcp-mail.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";

describe("composeMcpMail", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });
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

  it("exposes dispatcher, mailing-list registry, and mcp tools wired to the bus", () => {
    const storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    const messaging = composeMessaging({ logger });
    const mcpMail = composeMcpMail({
      storage, messaging, logger,
      clock: new ControllableClock("2026-04-20T00:00:00Z"),
      genId: () => "id-1",
      agentConfigs: new Map([["alice", cfg]]),
      lists: [],
      maxMailsPerThread: 10,
    });
    expect(mcpMail.dispatcher).toBeDefined();
    expect(mcpMail.mailingListRegistry).toBeDefined();
    expect(mcpMail.mcpTools).toBeDefined();
    storage.close();
  });

  it("the dispatcher writes to messageRepo and publishes mail.delivered on the bus when send target is an agent", () => {
    const storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    storage.agentRepo.create({ id: "bob", configPath: "/b", createdAt: "2026-04-20T00:00:00Z" });
    const messaging = composeMessaging({ logger });
    const mcpMail = composeMcpMail({
      storage, messaging, logger,
      clock: new ControllableClock("2026-04-20T00:00:00Z"),
      genId: (() => { let n = 0; return () => `id-${++n}`; })(),
      agentConfigs: new Map([
        ["alice", { ...cfg, name: "alice" }],
        ["bob", { ...cfg, name: "bob" }],
      ]),
      lists: [],
      maxMailsPerThread: 10,
    });

    const onDelivered = vi.fn();
    messaging.eventBus.subscribe("mail.delivered", onDelivered);

    mcpMail.dispatcher.sendMail({
      from: "agent:alice",
      to: ["agent:bob"],
      body: "hi",
      threadId: null,
    });

    expect(onDelivered).toHaveBeenCalled();
    expect(storage.messageRepo.listInbox("bob", { includeArchived: false }).length).toBe(1);
    storage.close();
  });

  it("the trigger listener is wired (a published turn.completed triggers list fanout)", () => {
    const storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    const messaging = composeMessaging({ logger });
    // ListDefinition uses { name, triggers: string[] } — event-type array, not a single trigger object.
    // The list name is the bare name (e.g. "harness-activity"), NOT prefixed with "list:".
    // The "list:" prefix is only used in addresses (subscriptions, to: fields).
    const lists = [
      { name: "harness-activity", triggers: ["turn.completed"] },
    ];
    // alice subscribes to list:harness-activity via subscriptions (address uses "list:" prefix)
    const aliceCfg: AgentConfig = { ...cfg, name: "alice", subscriptions: ["list:harness-activity"] };
    const mcpMail = composeMcpMail({
      storage, messaging, logger,
      clock: new ControllableClock("2026-04-20T00:00:00Z"),
      genId: (() => { let n = 0; return () => `id-${++n}`; })(),
      agentConfigs: new Map([["alice", aliceCfg]]),
      lists,
      maxMailsPerThread: 10,
    });

    void messaging.eventBus.publish("turn.completed", { agentId: "alice", turnId: "T1" });

    // Trigger listener should have invoked dispatcher → alice's inbox now has a fanout mail
    expect(storage.messageRepo.listInbox("alice", { includeArchived: false }).length).toBeGreaterThan(0);
    storage.close();
  });
});
