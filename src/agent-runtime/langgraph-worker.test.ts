import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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
      model: model as unknown as BaseChatModel,
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
      model: model as unknown as BaseChatModel,
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
      model: model as unknown as BaseChatModel,
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

  it("graph exceptions are logged but do not crash the worker", async () => {
    harness = await startMailHarness();
    const model = fakeModel().alwaysThrow(new Error("synthetic graph failure"));
    const errs: string[] = [];
    const worker = await LangGraphAgentWorker.createForTest({
      model: model as unknown as BaseChatModel,
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
