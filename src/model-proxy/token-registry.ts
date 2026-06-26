import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import type { Provider } from "../types.js";

export interface TokenEntry {
  agentId: string;
  turnId: string;
  traceId: string;
  provider: Provider;
  model: string;
}

/**
 * Token format for daemon-signed tokens:
 *   tr.{b64(json(entry))}.{b64(hmac)}
 *
 * The HMAC is SHA-256 over the base64-encoded entry JSON, keyed with the
 * shared daemonSecret. Locally-minted tokens (via mint()) use the Map
 * lookup path and are plain UUIDs.
 */
const REMOTE_TOKEN_PREFIX = "tr.";

export function signEntry(entry: TokenEntry, secret: string): string {
  const payload = Buffer.from(JSON.stringify(entry)).toString("base64url");
  const hmac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${REMOTE_TOKEN_PREFIX}${payload}.${hmac}`;
}

function verifyRemoteToken(
  token: string,
  secret: string,
): TokenEntry | undefined {
  if (!token.startsWith(REMOTE_TOKEN_PREFIX)) return undefined;
  const rest = token.slice(REMOTE_TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot === -1) return undefined;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (sig !== expected) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenEntry;
  } catch {
    return undefined;
  }
}

export class TokenRegistry {
  private readonly map = new Map<string, TokenEntry>();
  private readonly genId: () => string;
  /** Shared secret for verifying daemon-signed tokens. */
  private readonly sharedSecret?: string;

  constructor(genId: () => string = randomUUID, sharedSecret?: string) {
    this.genId = genId;
    this.sharedSecret = sharedSecret;
  }

  mint(entry: TokenEntry): string {
    const tok = this.genId();
    this.map.set(tok, entry);
    return tok;
  }

  /**
   * Mint a token signed with the shared secret, embedding the entry data.
   * Used by per-repo daemons that don't have access to the in-memory Map.
   * Throws if no shared secret was configured.
   */
  remoteMint(entry: TokenEntry): string {
    if (!this.sharedSecret) {
      throw new Error("remoteMint: no shared secret configured");
    }
    return signEntry(entry, this.sharedSecret);
  }

  lookup(token: string): TokenEntry | undefined {
    // Map lookup first (local tokens)
    const local = this.map.get(token);
    if (local) return local;
    // Try remote (daemon-signed) token verification
    if (this.sharedSecret) {
      return verifyRemoteToken(token, this.sharedSecret);
    }
    return undefined;
  }

  evict(token: string): void {
    this.map.delete(token);
  }

  /** Expose the shared secret for daemon-side token signing. */
  getSharedSecret(): string | undefined {
    return this.sharedSecret;
  }
}
