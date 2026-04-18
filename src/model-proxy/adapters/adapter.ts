import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";

export interface UpstreamCallContext {
  // Reserved for future use (per-call context); empty in M2.
}

export interface ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode;
  upstreamUrl(): string;
  injectAuth(headers: OutgoingHttpHeaders): void;
  extractUsage(responseBody: unknown): {
    inputTokens?: number;
    outputTokens?: number;
  };
}
