import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { composeStorage } from "../modules/storage/storage.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeMcpMail } from "../modules/mcp-mail/mcp-mail.js";
import { ControllableClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { MailMcpServer } from "../mail-mcp/server.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { MessageRepo } from "../db/message-repo.js";
import { LangGraphAgentWorker } from "./langgraph-worker.js";

/**
 * Tests use `fakeModel()` from `@langchain/core/testing` as the chat model —
 * it's a real `BaseChatModel` subclass with `.respond(msg)` / `.alwaysThrow(e)`
 * helpers, so no mocking layer is needed. The prebuilt ReAct agent's
 * invocation path (bindTools + prompt pipe + invoke) exercises its full
 * runnable contract unchanged.
 */

async function startMailHarness(): Promise<{
  mcpUrl: string;
  mcpToken: string;
  messageRepo: MessageRepo;
  stop: () => Promise<void>;
}> {
  const clock = new ControllableClock("2026-04-22T00:00:00.000Z");
  const logger = new JsonLinesLogger(clock, () => {}, { component: "test" });
  const storage = composeStorage({ dataDir: ":memory:" });
  storage.agentRepo.create({
    id: "studio-assistant",
    configPath: "/a",
    createdAt: "2026-04-22T00:00:00.000Z",
  });
  storage.agentRepo.create({
    id: "sender",
    configPath: "/b",
    createdAt: "2026-04-22T00:00:00.000Z",
  });
  const messaging = composeMessaging({ logger });

  const baseCfg: Omit<AgentConfig, "name" | "provider" | "configPath" | "agentsMdPath" | "storePath"> = {
    model: "m",
    imageTag: "t",
    subscriptions: [],
    allowedTools: [],
  };
  const agentConfigs = new Map<string, AgentConfig>([
    [
      "studio-assistant",
      {
        ...baseCfg,
        name: "studio-assistant",
        provider: "lm-studio",
        configPath: "/a",
        agentsMdPath: "/a/AGENTS.md",
        storePath: "/a/store",
      },
    ],
    [
      "sender",
      {
        ...baseCfg,
        name: "sender",
        provider: "anthropic",
        configPath: "/b",
        agentsMdPath: "/b/AGENTS.md",
        storePath: "/b/store",
      },
    ],
  ]);

  let seq = 0;
  const mcpMail = composeMcpMail({
    storage,
    messaging,
    logger,
    clock,
    genId: () => `id-${++seq}`,
    agentConfigs,
    lists: [],
    maxMailsPerThread: 40,
  });

  const MCP_TOKEN = "test-mcp-token";
  const server = new MailMcpServer({
    tools: mcpMail.mcpTools,
    tokenResolver: (token) => (token === MCP_TOKEN ? "studio-assistant" : null),
    port: 0,
    host: "127.0.0.1",
    logger,
  });
  await server.start();
  const { port } = server.address();

  return {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    mcpToken: MCP_TOKEN,
    messageRepo: storage.messageRepo,
    stop: async () => {
      await server.stop();
      storage.close();
    },
  };
}

describe("LangGraphAgentWorker", () => {
  let harness: Awaited<ReturnType<typeof startMailHarness>> | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it("discovers MCP tools from the mail server at construction time", async () => {
    harness = await startMailHarness();
    const model = fakeModel().respond(new AIMessage("no-op"));
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "You are a test agent.",
      agentsMdPath: "/does-not-exist",
    });
    const toolNames = worker.toolNamesForTest();
    expect(toolNames).toEqual(
      expect.arrayContaining(["mail.list", "mail.get", "mail.send", "mail.reply"]),
    );
  });

  it("on wake: appends a HumanMessage, invokes graph, emits final AI text via onText", async () => {
    harness = await startMailHarness();
    const model = fakeModel().respond(new AIMessage("I have nothing to do this wake."));
    const texts: string[] = [];
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "You are a test agent.",
      agentsMdPath: "/does-not-exist",
      onText: (t) => texts.push(t),
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(texts).toEqual(["I have nothing to do this wake."]);
    expect(model.callCount).toBe(1);
    // The graph delivers the HumanMessage we pushed plus a system prompt.
    const firstCall = model.calls[0]!;
    const humanSeen = firstCall.messages.some((m) => m instanceof HumanMessage);
    expect(humanSeen).toBe(true);
  });

  it("trims the messages array to the last 40 after wakes that push it past 40", async () => {
    harness = await startMailHarness();
    const model = fakeModel();
    for (let i = 0; i < 41; i++) {
      model.respond(new AIMessage(`answer-${i}`));
    }
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
    });
    for (let i = 0; i < 41; i++) {
      await worker.handleWake({ type: "wake", events: ["mail"] });
    }
    expect(worker.messageCountForTest()).toBe(40);
  });

  it("trim preserves AIMessage-with-tool_calls / ToolMessage pairing", async () => {
    harness = await startMailHarness();
    const model = fakeModel();
    // Script a mix of tool-bearing wakes and plain wakes to force the naive
    // `slice(-40)` boundary to fall mid-turn. A tool wake produces 4 messages
    // (Human → AI-with-tool_calls → Tool → AI-final); a plain wake produces 2
    // (Human → AI). With 10 tool wakes (40 msgs) + 1 plain wake (2 msgs) = 42
    // total, a naive slice(-40) would start at index 2 — the ToolMessage of
    // turn 0 — leaving an orphan. Our boundary-aware trim must NOT produce
    // that shape.
    const TOOL_WAKES = 10;
    const PLAIN_WAKES = 1;
    for (let i = 0; i < TOOL_WAKES; i += 1) {
      model.respondWithTools([{ name: "mail.list", args: { unreadOnly: true } }]);
      model.respond(new AIMessage(`final-${i}`));
    }
    for (let i = 0; i < PLAIN_WAKES; i += 1) {
      model.respond(new AIMessage(`plain-${i}`));
    }
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
    });
    for (let i = 0; i < TOOL_WAKES + PLAIN_WAKES; i += 1) {
      await worker.handleWake({ type: "wake", events: ["mail"] });
    }
    // Fetch messages via the last invocation's call-log equivalent: reach
    // into the worker via the test helper. We'll expose the full array
    // for this assertion.
    const messages = worker.messagesForTest();
    expect(messages.length).toBeLessThanOrEqual(40);
    expect(messages.length).toBeGreaterThan(0);
    // Invariant 1: retained array must not START with a ToolMessage —
    // that shape (orphaned tool result, no preceding tool_calls AIMessage)
    // is what OpenAI-compat providers reject.
    expect(messages[0]).not.toBeInstanceOf(ToolMessage);
    // Invariant 2: every AIMessage.tool_calls[].id in the retained segment
    // must have a matching ToolMessage.tool_call_id after it.
    const toolCallIds = new Set<string>();
    const toolMessageIds = new Set<string>();
    for (const m of messages) {
      if (m instanceof AIMessage && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id);
        }
      }
      if (m instanceof ToolMessage) {
        toolMessageIds.add(m.tool_call_id);
      }
    }
    // Each ToolMessage must reference a tool_call we kept.
    for (const id of toolMessageIds) {
      expect(toolCallIds.has(id)).toBe(true);
    }
    // Each AIMessage.tool_calls.id we kept must have a matching ToolMessage.
    for (const id of toolCallIds) {
      expect(toolMessageIds.has(id)).toBe(true);
    }
  });

  it("graph exceptions are logged but do not crash the worker", async () => {
    harness = await startMailHarness();
    const model = fakeModel().alwaysThrow(new Error("synthetic graph failure"));
    const errs: string[] = [];
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
      onError: (e) => errs.push(e instanceof Error ? e.message : String(e)),
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toEqual([expect.stringContaining("synthetic graph failure")]);
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toHaveLength(2);
  });
});
