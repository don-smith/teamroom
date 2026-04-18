import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

export type AnthropicAuth =
  | { mode: "api-key"; apiKey: string }
  | {
      mode: "oauth";
      oauthToken: string;
      cache: AnthropicOAuthCache;
      exchange: (oauthToken: string) => Promise<{ tempKey: string; expiresAt: number }>;
    };

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

  async resolveAuth(headers: OutgoingHttpHeaders): Promise<void> {
    delete headers.authorization;
    const auth = this.opts.auth;
    if (auth.mode === "api-key") {
      headers["x-api-key"] = auth.apiKey;
      return;
    }
    // OAuth mode — capture `auth` locally so the discriminant narrowing
    // carries into the fetcher closure (TS doesn't narrow `this.opts.auth`
    // through closures).
    const tempKey = await auth.cache.get(auth.oauthToken, () =>
      auth.exchange(auth.oauthToken),
    );
    headers["x-api-key"] = tempKey;
  }

  onUpstreamUnauthorized(): void {
    if (this.opts.auth.mode === "oauth") {
      this.opts.auth.cache.evict(this.opts.auth.oauthToken);
    }
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
