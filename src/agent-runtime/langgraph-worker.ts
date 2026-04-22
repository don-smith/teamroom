import { existsSync, readFileSync } from "node:fs";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { AgentWorker, WakeEnvelope } from "./worker.js";

/**
 * LangGraph-backed agent worker for OpenAI-compatible providers (lm-studio,
 * ollama). Wires a prebuilt ReAct agent (tool-calling loop) with tools
 * discovered from the daemon-hosted mail MCP server. The in-process messages
 * array accumulates across wakes — bounded by MAX_MESSAGES so the trailing
 * context never outruns the model's window.
 */

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. On wake, check your inbox via the mail.* MCP tools and respond to any unread mail.";

const WAKE_PROMPT =
  "You received a wake notification — new activity in your environment. Check your inbox with mail.list (unreadOnly=true), read anything relevant with mail.get, and reply or send new mail as appropriate. If there is nothing actionable, end your turn without replying.";

const MAX_MESSAGES = 40;
const RECURSION_LIMIT = 10;
const MAX_RETRIES = 2;

export interface LangGraphAgentWorkerOpts {
  model: LanguageModelLike;
  mcpUrl: string;
  mcpToken: string;
  systemPrompt: string;
  agentsMdPath: string;
  onText?: (text: string) => void;
  onError?: (err: unknown) => void;
}

type ReactAgent = ReturnType<typeof createReactAgent>;

export class LangGraphAgentWorker implements AgentWorker {
  private readonly opts: LangGraphAgentWorkerOpts;
  private readonly agent: ReactAgent;
  private readonly mcpClient: MultiServerMCPClient;
  private readonly toolNames: string[];
  private messages: BaseMessage[] = [];

  private constructor(
    opts: LangGraphAgentWorkerOpts,
    agent: ReactAgent,
    mcpClient: MultiServerMCPClient,
    toolNames: string[],
  ) {
    this.opts = opts;
    this.agent = agent;
    this.mcpClient = mcpClient;
    this.toolNames = toolNames;
  }

  /** Production factory — reads env vars. Wires the real ChatOpenAI pointed at the daemon proxy. */
  static async create(): Promise<LangGraphAgentWorker> {
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    const baseURL = process.env.TEAMROOM_MODEL_BASE_URL;
    if (!baseURL) throw new Error("TEAMROOM_MODEL_BASE_URL is required");
    const apiKey = process.env.TEAMROOM_MODEL_API_TOKEN ?? "not-required";
    const mcpUrl = process.env.TEAMROOM_MCP_URL;
    const mcpToken = process.env.TEAMROOM_MCP_TOKEN;
    if (!mcpUrl) throw new Error("TEAMROOM_MCP_URL is required");
    if (!mcpToken) throw new Error("TEAMROOM_MCP_TOKEN is required");

    // OpenAI SDK appends /v1/chat/completions; LM Studio and Ollama both
    // expose /v1. Match the prior runtime's behavior.
    const configuration = {
      baseURL: baseURL.replace(/\/$/, "") + "/v1",
      apiKey,
    };
    const chat = new ChatOpenAI({
      model,
      maxRetries: MAX_RETRIES,
      configuration,
    });

    return LangGraphAgentWorker.build({
      model: chat,
      mcpUrl,
      mcpToken,
      systemPrompt: "",
      agentsMdPath: "/AGENTS.md",
      onText: (t) => process.stderr.write(`[llm] ${t}\n`),
      onError: (e) =>
        process.stderr.write(
          `[graph-error] ${e instanceof Error ? e.message : String(e)}\n`,
        ),
    });
  }

  /** Test factory — caller supplies a fake/real model and MCP endpoint directly. */
  static async createForTest(opts: LangGraphAgentWorkerOpts): Promise<LangGraphAgentWorker> {
    return LangGraphAgentWorker.build(opts);
  }

  private static async build(opts: LangGraphAgentWorkerOpts): Promise<LangGraphAgentWorker> {
    const mcpClient = new MultiServerMCPClient({
      mcpServers: {
        mail: {
          transport: "http",
          url: opts.mcpUrl,
          headers: { "x-teamroom-mcp-token": opts.mcpToken },
          automaticSSEFallback: false,
        },
      },
    });
    const tools = await mcpClient.getTools();
    const toolNames = tools.map((t) => t.name);

    const systemPrompt = existsSync(opts.agentsMdPath)
      ? readFileSync(opts.agentsMdPath, "utf8")
      : opts.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    const agent = createReactAgent({
      llm: opts.model,
      tools,
      prompt: systemPrompt,
    });

    return new LangGraphAgentWorker(opts, agent, mcpClient, toolNames);
  }

  async handleWake(_wake: WakeEnvelope): Promise<void> {
    this.messages.push(new HumanMessage(WAKE_PROMPT));
    try {
      const result = await this.agent.invoke(
        { messages: this.messages },
        { recursionLimit: RECURSION_LIMIT },
      );
      this.messages = result.messages as BaseMessage[];
      this.trimMessages();
      const last = this.messages[this.messages.length - 1];
      if (
        last instanceof AIMessage &&
        typeof last.content === "string" &&
        this.opts.onText
      ) {
        this.opts.onText(last.content);
      }
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err);
    }
  }

  /**
   * Trim the messages array at HumanMessage boundaries so the retained
   * segment stays within MAX_MESSAGES.
   *
   * Why boundary-aware: LangGraph's ReAct executor emits AIMessages carrying
   * `tool_calls` fields that must be paired with matching ToolMessage
   * responses (by `tool_call_id`). A naive `slice(-N)` can cut between an
   * AIMessage-with-tool_calls and its ToolMessage(s), leaving either an
   * orphaned ToolMessage or an AIMessage with unfulfilled tool_calls —
   * shapes OpenAI-compat providers (LM Studio, Ollama) reject with
   * 400-class errors. Cutting at HumanMessage boundaries drops whole prior
   * wakes, preserving the tool-call/tool-message invariant.
   *
   * Algorithm: walk backward looking for the EARLIEST HumanMessage whose
   * retained segment is ≤ MAX_MESSAGES; slice from there. If no such
   * boundary exists (degenerate single-turn > cap), fall back to hard
   * `slice(-MAX_MESSAGES)`.
   */
  private trimMessages(): void {
    if (this.messages.length <= MAX_MESSAGES) return;
    let earliest = -1;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const remaining = this.messages.length - i;
      if (remaining > MAX_MESSAGES) break;
      if (this.messages[i] instanceof HumanMessage) {
        earliest = i;
      }
    }
    if (earliest >= 0) {
      this.messages = this.messages.slice(earliest);
      return;
    }
    // Degenerate: no HumanMessage boundary fits under the cap.
    this.messages = this.messages.slice(-MAX_MESSAGES);
  }

  toolNamesForTest(): string[] {
    return this.toolNames;
  }
  messageCountForTest(): number {
    return this.messages.length;
  }
  messagesForTest(): readonly BaseMessage[] {
    return this.messages;
  }
}
