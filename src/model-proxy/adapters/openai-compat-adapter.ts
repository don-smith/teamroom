import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

export type OpenAICompatAuth =
  | { mode: "bearer"; key: string }
  | { mode: "none" };

export interface OpenAICompatAdapterOpts {
  /** Proxy-level provider id (`"lm-studio"` or `"ollama"`). */
  id: Provider;
  /** Upstream base URL (e.g. `http://localhost:1234` or `http://localhost:11434`). */
  upstreamUrl: string;
  /** Auth mode — `bearer` for LM Studio/OpenAI-style token, `none` for Ollama-style unauthenticated. */
  auth: OpenAICompatAuth;
  /** Optional provider-specific headers added during auth/header resolution. */
  defaultHeaders?: Record<string, string>;
}

/**
 * Single adapter shared by any OpenAI-compatible upstream (LM Studio,
 * Ollama, future hosted OpenAI / Codex). Differs from `AnthropicAdapter`
 * in auth shape and usage-field names; within the OpenAI-compat family
 * everything else is identical.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode = "api-key";
  private readonly opts: OpenAICompatAdapterOpts;

  constructor(opts: OpenAICompatAdapterOpts) {
    this.opts = opts;
    this.id = opts.id;
  }

  upstreamUrl(): string {
    return this.opts.upstreamUrl;
  }

  async resolveAuth(headers: OutgoingHttpHeaders): Promise<void> {
    delete headers["x-api-key"];
    for (const [name, value] of Object.entries(this.opts.defaultHeaders ?? {})) {
      headers[name] = value;
    }
    if (this.opts.auth.mode === "bearer") {
      headers.authorization = `Bearer ${this.opts.auth.key}`;
    } else {
      delete headers.authorization;
    }
  }

  extractUsage(responseBody: unknown): { inputTokens?: number; outputTokens?: number } {
    if (typeof responseBody !== "object" || responseBody === null) return {};
    const usage = (responseBody as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") return {};
    const inT = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const outT = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
    return { inputTokens: inT, outputTokens: outT };
  }
}
