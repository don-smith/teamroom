import { existsSync, readFileSync } from "node:fs";
import type { ConversationMessage } from "./session-store.js";

/**
 * Agent runtime — M4 shape.
 *
 * Each wake the daemon pushes via stdin triggers one LLM invocation. The
 * LLM (via the claude-agent-sdk's MCP client) reads its inbox and sends
 * replies / new mails via the `mail.*` tools. The runtime itself no
 * longer emits `{type:"reply"}` stdout — all agent communication flows
 * through the MCP server back into the dispatcher.
 *
 * Natural-language text the LLM produces is not routed anywhere; it's
 * just model output the claude-agent-sdk streams internally. Anything
 * the runtime wants to log gets written via `process.stderr` / the
 * logger; stdout is reserved for structured envelopes (status / log
 * events) that the daemon parses.
 */

export interface WakeEnvelope {
  type: "wake";
  /** Informational tags — the agent's system prompt tells it what to check. */
  events: string[];
}

export interface LlmCreateArgs {
  model: string;
  system: string;
  messages: ConversationMessage[];
}

export interface LlmCreateResult {
  text: string;
}

export interface LlmClient {
  createMessage(args: LlmCreateArgs): Promise<LlmCreateResult>;
}

export interface ProcessWakeDeps {
  wake: WakeEnvelope;
  client: LlmClient;
  model: string;
  agentsMdPath: string;
  /** Optional sink for LLM natural-language output (stderr by default). */
  onText?: (text: string) => void;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. On wake, check your inbox via the mail.* MCP tools and respond to any unread mail. Reply in-thread with mail.reply; start fresh threads with mail.send.";

const WAKE_PROMPT =
  "You received a wake notification — new activity in your environment. Check your inbox with mail.list (unread_only=true), read anything relevant with mail.get, and reply or send new mail as appropriate. If there is nothing actionable, end your turn without replying.";

export async function processWake(deps: ProcessWakeDeps): Promise<void> {
  const system = existsSync(deps.agentsMdPath)
    ? readFileSync(deps.agentsMdPath, "utf8")
    : DEFAULT_SYSTEM_PROMPT;

  const result = await deps.client.createMessage({
    model: deps.model,
    system,
    messages: [{ role: "user", content: WAKE_PROMPT }],
  });

  // LLM natural-language output isn't routed anywhere mail-visible; it's
  // diagnostic only. Hand it to the sink (defaults to stderr) so humans
  // debugging a turn can see what the model said between tool calls.
  if (result.text && deps.onText) {
    deps.onText(result.text);
  }
}
