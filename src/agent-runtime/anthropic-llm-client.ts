import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * Conversation continuity: the SDK persists sessions to disk (under
 * `CLAUDE_CONFIG_DIR`, which we point at the agent's `/store` mount so it
 * survives the per-turn container teardown). Each turn we read the previous
 * session UUID from a sidecar file in `/store`, pass it as `resume`, and
 * write the new session UUID after the call. The first turn has no sidecar
 * and starts a fresh session.
 */
export interface AnthropicLlmClientOpts {
  /**
   * Override for `Options.executable`. Defaults to "node" — matches the
   * runtime our container's Dockerfile installs the Claude Code CLI under.
   */
  executable?: "bun" | "deno" | "node";
  /**
   * Where to read/write the session-id sidecar. Defaults to
   * `/store/anthropic-session.txt`. Tests inject a temp path.
   */
  sessionIdFile?: string;
  /**
   * Where the SDK should persist its session JSONL files. Defaults to
   * `/store/claude-sdk` — picked up via the spawned subprocess's
   * `CLAUDE_CONFIG_DIR` env var. Tests inject a temp path.
   */
  configDir?: string;
  /**
   * Working directory passed to the SDK. The SDK groups sessions per-cwd,
   * so we pin to a stable path so resume can find prior sessions. Defaults
   * to `/store/work` (created on demand). Tests inject a temp path.
   */
  cwd?: string;
}

const DEFAULT_SESSION_FILE = "/store/anthropic-session.txt";
const DEFAULT_CONFIG_DIR = "/store/claude-sdk";
const DEFAULT_CWD = "/store/work";

export class AnthropicLlmClient implements LlmClient {
  private readonly executable: "bun" | "deno" | "node";
  private readonly sessionIdFile: string;
  private readonly configDir: string;
  private readonly cwd: string;

  constructor(opts: AnthropicLlmClientOpts = {}) {
    this.executable = opts.executable ?? "node";
    this.sessionIdFile = opts.sessionIdFile ?? DEFAULT_SESSION_FILE;
    this.configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
    this.cwd = opts.cwd ?? DEFAULT_CWD;
  }

  async createMessage(args: LlmCreateArgs): Promise<LlmCreateResult> {
    // Make sure cwd + configDir exist so the SDK doesn't error on first turn.
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });
    mkdirSync(dirname(this.sessionIdFile), { recursive: true });

    const resumeSessionId = this.readSessionIdSidecar();

    const options: Options = {
      executable: this.executable,
      model: args.model,
      cwd: this.cwd,
      // Disable all tools — M2 is non-tool-using chat. Keeps the subprocess
      // simple and avoids Claude Code asking for tool permissions.
      allowedTools: [],
      systemPrompt: args.system
        ? { type: "preset", preset: "claude_code", append: args.system }
        : undefined,
      // Persist sessions so the next turn can resume.
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // Pass current env PLUS our CLAUDE_CONFIG_DIR so session files land in
      // the persistent /store mount (default ~/.claude is inside the
      // ephemeral container — gone with --rm). Process.env is needed so the
      // CLI subprocess sees ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.
      env: { ...(process.env as Record<string, string>), CLAUDE_CONFIG_DIR: this.configDir },
    };

    // For the prompt: only send the latest user message. The SDK will fold
    // it into the resumed session (which already contains all prior turns).
    // For the very first turn there's no resume, so the prompt IS the entire
    // conversation context.
    const userPrompt = this.latestUserMessage(args.messages);
    let resultText = "";
    let resultError: string | undefined;
    let newSessionId: string | undefined;

    for await (const msg of query({ prompt: userPrompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
          newSessionId = msg.session_id;
        } else {
          resultError = `claude-agent-sdk error subtype=${msg.subtype}`;
        }
        // result message is terminal — stop iterating.
        break;
      }
    }

    if (resultError) throw new Error(resultError);
    if (newSessionId) this.writeSessionIdSidecar(newSessionId);
    return { text: resultText };
  }

  private readSessionIdSidecar(): string | undefined {
    if (!existsSync(this.sessionIdFile)) return undefined;
    try {
      const raw = readFileSync(this.sessionIdFile, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }

  private writeSessionIdSidecar(sessionId: string): void {
    try {
      writeFileSync(this.sessionIdFile, sessionId, "utf8");
    } catch {
      // Best-effort — losing the sidecar means the next turn starts fresh
      // (degraded but not broken). Don't crash the call over it.
    }
  }

  /**
   * Returns the last user message (the new inbound for this turn). Conversation
   * history older than that is replayed by the SDK from the persisted session.
   */
  private latestUserMessage(messages: LlmCreateArgs["messages"]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "user") return m.content;
    }
    return messages.map((m) => m.content).join("\n");
  }
}
