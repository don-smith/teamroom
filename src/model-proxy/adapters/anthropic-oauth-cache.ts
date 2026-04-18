interface CacheEntry { tempKey: string; expiresAt: number }
type Fetcher = () => Promise<CacheEntry>;

interface Opts {
  safetyMarginMs?: number;     // expire treats `expiresAt - safetyMarginMs` as the boundary
  now?: () => number;          // injectable clock
}

export class AnthropicOAuthCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CacheEntry>>();
  private readonly safetyMarginMs: number;
  private readonly now: () => number;

  constructor(opts: Opts = {}) {
    this.safetyMarginMs = opts.safetyMarginMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async get(oauthToken: string, fetcher: Fetcher): Promise<string> {
    const cached = this.entries.get(oauthToken);
    if (cached && cached.expiresAt - this.safetyMarginMs > this.now()) {
      return cached.tempKey;
    }
    const inflight = this.inflight.get(oauthToken);
    if (inflight) return (await inflight).tempKey;

    const p = (async () => {
      try {
        const entry = await fetcher();
        this.entries.set(oauthToken, entry);
        return entry;
      } finally {
        this.inflight.delete(oauthToken);
      }
    })();
    this.inflight.set(oauthToken, p);
    return (await p).tempKey;
  }

  evict(oauthToken: string): void {
    this.entries.delete(oauthToken);
  }
}
