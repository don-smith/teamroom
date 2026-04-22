import { existsSync, readFileSync } from "node:fs";
import { AnthropicLlmClient, type LlmClient } from "./anthropic-llm-client.js";
import type { AgentWorker, WakeEnvelope } from "./worker.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Anthropic-backed agent worker. Each wake invokes the claude-agent-sdk
 * once with the agent's AGENTS.md as the system prompt; the SDK streams
 * tool calls (mail.*) through the daemon-hosted MCP server. Natural-language
 * text the model emits is handed to `onText` (default stderr) for debugging;
 * there's no stdout envelope for it — all real agent-to-agent communication
 * flows via MCP tool calls.
 */

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. On wake, check your inbox via the mail.* MCP tools and respond to any unread mail. Reply in-thread with mail.reply; start fresh threads with mail.send.";

const WAKE_PROMPT =
  "You received a wake notification — new activity in your environment. Check your inbox with mail.list (unreadOnly=true), read anything relevant with mail.get, and reply or send new mail as appropriate. If there is nothing actionable, end your turn without replying.";

export interface AnthropicAgentWorkerOpts {
  client: LlmClient;
  model: string;
  agentsMdPath: string;
  onText?: (text: string) => void;
}

export class AnthropicAgentWorker implements AgentWorker {
  private readonly opts: AnthropicAgentWorkerOpts;

  constructor(opts: AnthropicAgentWorkerOpts) {
    this.opts = opts;
  }

  /** Construct from process env — used by the `buildWorker()` factory. */
  static create(): AnthropicAgentWorker {
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL is required");
    if (!process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is required");

    const toolsRaw = process.env.TEAMROOM_ALLOWED_TOOLS ?? "";
    const allowedTools = toolsRaw.trim() === ""
      ? []
      : toolsRaw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

    const mcpUrl = process.env.TEAMROOM_MCP_URL;
    const mcpToken = process.env.TEAMROOM_MCP_TOKEN;
    const mcpServers: Record<string, McpServerConfig> | undefined =
      mcpUrl && mcpToken
        ? {
            mail: {
              type: "http",
              url: mcpUrl,
              headers: { "x-teamroom-mcp-token": mcpToken },
            },
          }
        : undefined;

    const client = new AnthropicLlmClient({ allowedTools, mcpServers });
    return new AnthropicAgentWorker({
      client,
      model,
      agentsMdPath: "/AGENTS.md",
      onText: (text) => process.stderr.write(`[llm] ${text}\n`),
    });
  }

  async handleWake(_wake: WakeEnvelope): Promise<void> {
    const system = existsSync(this.opts.agentsMdPath)
      ? readFileSync(this.opts.agentsMdPath, "utf8")
      : DEFAULT_SYSTEM_PROMPT;

    const result = await this.opts.client.createMessage({
      model: this.opts.model,
      system,
      messages: [{ role: "user", content: WAKE_PROMPT }],
    });

    if (result.text && this.opts.onText) {
      this.opts.onText(result.text);
    }
  }
}
