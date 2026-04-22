import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    lifecycle: "session",
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
  // Shared temp root for the filesystem MCP child — the stdio server requires
  // at least one existing root to start. Individual tests that need their own
  // isolated root mkdtemp a fresh one; everyone else reuses this one.
  let sharedFsRoot: string;

  beforeAll(() => {
    // realpathSync: on macOS, /var/folders is a symlink into /private/var/folders.
    // The FS server resolves its roots to real paths when checking access, so
    // we must hand it the already-resolved form or subsequent path comparisons
    // fail as "outside allowed directories".
    sharedFsRoot = realpathSync(mkdtempSync(join(tmpdir(), "tr-fs-shared-")));
  });
  afterAll(() => {
    rmSync(sharedFsRoot, { recursive: true, force: true });
  });

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
      filesystemRoots: [sharedFsRoot],
    });
    const toolNames = worker.toolNamesForTest();
    expect(toolNames).toEqual(
      expect.arrayContaining(["mail.list", "mail.get", "mail.send", "mail.reply"]),
    );
  });

  it("discovers both mail and filesystem tools at construction time", async () => {
    harness = await startMailHarness();
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "tr-fs-mcp-")));
    try {
      const model = fakeModel().respond(new AIMessage("ok"));
      const worker = await LangGraphAgentWorker.createForTest({
        model,
        mcpUrl: harness.mcpUrl,
        mcpToken: harness.mcpToken,
        systemPrompt: "You are a test agent.",
        agentsMdPath: "/does-not-exist",
        filesystemRoots: [tmpRoot],
      });
      const toolNames = worker.toolNamesForTest();
      // Mail tools (existing)
      expect(toolNames).toEqual(
        expect.arrayContaining(["mail.list", "mail.get", "mail.send", "mail.reply"]),
      );
      // Filesystem tools (new) — sample of the 13 exposed by the FS server
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "read_text_file",
          "write_file",
          "list_directory",
          "search_files",
        ]),
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("skips the filesystem MCP server when none of the declared roots exist on disk", async () => {
    // /codebase is optional per src/daemon/daemon.ts#resolveCodebasePath —
    // if it's absent, the worker must still boot with mail-only capability
    // rather than crashing inside the stdio child.
    harness = await startMailHarness();
    const errs: string[] = [];
    const model = fakeModel().respond(new AIMessage("ok"));
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
      filesystemRoots: ["/definitely-not-a-real-path-xyz"],
      onError: (e) => errs.push(e instanceof Error ? e.message : String(e)),
    });
    const toolNames = worker.toolNamesForTest();
    // Mail tools still present
    expect(toolNames).toEqual(
      expect.arrayContaining(["mail.list", "mail.get", "mail.send", "mail.reply"]),
    );
    // No filesystem tools — the server was skipped
    expect(toolNames).not.toEqual(expect.arrayContaining(["read_text_file"]));
    expect(toolNames).not.toEqual(expect.arrayContaining(["write_file"]));
    // Operator visibility: the skip was reported with a [boot] prefix so it
    // doesn't read as an in-turn graph exception.
    expect(errs.some((e) => e.startsWith("[boot]"))).toBe(true);
    expect(errs.some((e) => e.includes("filesystem MCP roots not present"))).toBe(true);
    expect(errs.some((e) => e.includes("/definitely-not-a-real-path-xyz"))).toBe(true);
  });

  it("filesystem tools round-trip: write then read a file via the MCP stdio server", async () => {
    harness = await startMailHarness();
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "tr-fs-rt-")));
    try {
      const model = fakeModel().respond(new AIMessage("ok"));
      const worker = await LangGraphAgentWorker.createForTest({
        model,
        mcpUrl: harness.mcpUrl,
        mcpToken: harness.mcpToken,
        systemPrompt: "test",
        agentsMdPath: "/does-not-exist",
        filesystemRoots: [tmpRoot],
      });
      const tools = worker.toolsForTest();
      const write = tools.find((t) => t.name === "write_file");
      const read = tools.find((t) => t.name === "read_text_file");
      if (!write || !read) throw new Error("missing fs tools");
      const filepath = join(tmpRoot, "greeting.txt");
      // The FS server returns `{ content: [{ type: "text", text }], structuredContent: { content } }`.
      // When the LangChain MCP adapter sees a single text block + structuredContent,
      // it hands back a content-block-shaped object `{ type: "text", text, structuredContent, ... }`
      // from the tool's `invoke()` (no toolCallId in test → _formatToolOutput returns content directly).
      // Extract the text via a narrow helper — avoids `any` while tolerating the shape.
      const asText = (v: unknown): string => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "text" in v && typeof (v as { text: unknown }).text === "string") {
          return (v as { text: string }).text;
        }
        return JSON.stringify(v);
      };
      const writeText = asText(await write.invoke({ path: filepath, content: "hello from mcp" }));
      expect(writeText).not.toMatch(/error|fail/i);
      expect(writeText).toContain("Successfully wrote");
      expect(readFileSync(filepath, "utf8")).toBe("hello from mcp");
      const readText = asText(await read.invoke({ path: filepath }));
      expect(readText).toContain("hello from mcp");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
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
      filesystemRoots: [sharedFsRoot],
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
      filesystemRoots: [sharedFsRoot],
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
      filesystemRoots: [sharedFsRoot],
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
      filesystemRoots: [sharedFsRoot],
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toEqual([expect.stringContaining("synthetic graph failure")]);
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toHaveLength(2);
  });
});
