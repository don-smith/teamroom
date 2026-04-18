import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

interface Opts {
  upstreamUrl: string;
  realKey: string;
}

export class LmStudioAdapter implements ProviderAdapter {
  readonly id: Provider = "lm-studio";
  readonly authMode: AuthMode = "api-key";
  private readonly opts: Opts;

  constructor(opts: Opts) {
    this.opts = opts;
  }

  upstreamUrl(): string {
    return this.opts.upstreamUrl;
  }

  injectAuth(headers: OutgoingHttpHeaders): void {
    headers.authorization = `Bearer ${this.opts.realKey}`;
    delete headers["x-api-key"];
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
