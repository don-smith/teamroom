import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LlmClient, LlmCreateArgs, LlmCreateResult } from "./runtime.js";

/**
 * Anthropic LLM client that runs INSIDE the agent container, talking to
 * Anthropic via the Claude Agent SDK (which spawns the Claude Code CLI as a
 * subprocess). The CLI honors `ANTHROPIC_BASE_URL` to route its `/v1/messages`
 * calls through our daemon-side model proxy, and `ANTHROPIC_AUTH_TOKEN` to
 * carry the per-turn routing token. The proxy intercepts and substitutes the
 * routing token for the real OAuth credential before forwarding upstream —
 * the container never sees a real Anthropic credential.
 *
 * This pattern is the same one NanoClaw uses (see container/agent-runner/
 * src/index.ts in qwibitai/nanoclaw): "Credentials are injected by the host's
 * credential proxy via ANTHROPIC_BASE_URL." It's the only known path that
 * works with subscription-OAuth tokens for non-Claude-Code consumers, because
 * the CLI subprocess constructs requests with the full Claude Code identity
 * (User-Agent, anthropic-beta flags) that Anthropic's gating expects.
 *
 * No constructor options needed — `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN` are read from `process.env` by the SDK / spawned CLI.
 */
export interface AnthropicLlmClientOpts {
  /**
   * Optional override for `Options.executable`. Defaults to "node" — matches
   * the runtime our container's Dockerfile installs the Claude Code CLI under.
   */
  executable?: "bun" | "deno" | "node";
}

export class AnthropicLlmClient implements LlmClient {
  private readonly executable: "bun" | "deno" | "node";

  constructor(opts: AnthropicLlmClientOpts = {}) {
    this.executable = opts.executable ?? "node";
  }

  async createMessage(args: LlmCreateArgs): Promise<LlmCreateResult> {
    // For our single-turn use case (one inbound message → one assistant
    // reply) the SDK accepts a string prompt. Conversation history is
    // appended by runTurn to /store/conversation.jsonl and is NOT passed
    // back to the SDK here — M2's contract is one Anthropic call per turn;
    // multi-turn replay through the SDK is M3+ work.
    //
    // We use args.system as the systemPrompt's `append` so the agent's
    // AGENTS.md content extends Claude Code's default system prompt rather
    // than replacing it (matches NanoClaw's pattern).
    const options: Options = {
      executable: this.executable,
      model: args.model,
      // Disable all tools — M2 is non-tool-using chat. Keeps the subprocess
      // simple and avoids Claude Code asking for tool permissions.
      allowedTools: [],
      systemPrompt: args.system
        ? { type: "preset", preset: "claude_code", append: args.system }
        : undefined,
      // Don't persist sessions to ~/.claude — each turn is independent.
      persistSession: false,
      // Pass current process.env so the spawned CLI sees ANTHROPIC_BASE_URL,
      // ANTHROPIC_AUTH_TOKEN, and any HTTP_PROXY settings. Without this,
      // the SDK's default env handling may strip our routing config.
      env: process.env as Record<string, string>,
    };

    const userPrompt = this.flattenMessagesToPrompt(args.messages);
    let resultText = "";
    let resultError: string | undefined;

    for await (const msg of query({ prompt: userPrompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          resultError = `claude-agent-sdk error subtype=${msg.subtype}`;
        }
        // result message is terminal — stop iterating.
        break;
      }
    }

    if (resultError) throw new Error(resultError);
    return { text: resultText };
  }

  /**
   * Collapse messages into a single user-facing prompt. The Claude Code CLI
   * subprocess accepts a single string per `query`; we just need to feed it
   * the latest user message. (Conversation history is persisted by runTurn
   * separately — multi-turn context replay through the SDK is M3+ work.)
   */
  private flattenMessagesToPrompt(messages: LlmCreateArgs["messages"]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "user") return m.content;
    }
    return messages.map((m) => m.content).join("\n");
  }
}
