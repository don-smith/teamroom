import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

export type AnthropicAuth =
  | { mode: "api-key"; apiKey: string }
  | { mode: "oauth"; oauthToken: string }; // wired in Task 13

interface Opts {
  auth: AnthropicAuth;
  upstreamUrl?: string; // default: https://api.anthropic.com
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: Provider = "anthropic";
  readonly authMode: AuthMode;
  private readonly opts: Opts;

  constructor(opts: Opts) {
    this.opts = opts;
    this.authMode = opts.auth.mode;
  }

  upstreamUrl(): string {
    return this.opts.upstreamUrl ?? "https://api.anthropic.com";
  }

  injectAuth(headers: OutgoingHttpHeaders): void {
    delete headers.authorization;
    if (this.opts.auth.mode === "api-key") {
      headers["x-api-key"] = this.opts.auth.apiKey;
      return;
    }
    // OAuth mode wired in Task 13; throw for now to make the gap visible.
    throw new Error("AnthropicAdapter OAuth mode not yet implemented (Task 13)");
  }

  extractUsage(responseBody: unknown): { inputTokens?: number; outputTokens?: number } {
    if (typeof responseBody !== "object" || responseBody === null) return {};
    const usage = (responseBody as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") return {};
    const inT = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const outT = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    return { inputTokens: inT, outputTokens: outT };
  }
}
