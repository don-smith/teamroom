import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";

export interface UpstreamCallContext {
  // Reserved for future use (per-call context); empty in M2.
}

export interface ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode;
  upstreamUrl(): string;
  /** Mutates `headers` to swap the routing-token placeholder for the real upstream credential. */
  resolveAuth(headers: OutgoingHttpHeaders): Promise<void>;
  extractUsage(responseBody: unknown): {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** OAuth only: invalidate the cached temp key after a 401 from upstream. */
  onUpstreamUnauthorized?(): void;
}
