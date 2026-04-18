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
    // Anthropic accepts OAuth tokens via Authorization: Bearer (NOT x-api-key,
    // which is for raw API keys only). The `anthropic-beta: oauth-2025-04-20`
    // header is required to opt this account into OAuth-token use against
    // /v1/messages — without it, the token is rejected even though the
    // Bearer auth itself is correct. (Verified against NanoClaw, vibekit,
    // gptel-anthropic-oauth, and zero-limit reference implementations.)
    delete headers["x-api-key"];
    headers.authorization = `Bearer ${tempKey}`;
    headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], "oauth-2025-04-20");
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

/**
 * Merge a new beta flag into an existing `anthropic-beta` header value.
 * The header is comma-separated; we preserve any caller-provided flags and
 * deduplicate. Accepts the SDK's array form too (collapsed to comma-string).
 */
function mergeBeta(
  existing: string | string[] | number | undefined,
  add: string,
): string {
  if (existing === undefined) return add;
  const existingStr = Array.isArray(existing) ? existing.join(",") : String(existing);
  const flags = new Set(
    existingStr
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  );
  flags.add(add);
  return Array.from(flags).join(",");
}
