import { describe, it, expect } from "vitest";
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

describe("AnthropicOAuthCache", () => {
  it("cache miss → fetch, then hit returns the same value", async () => {
    let fetchCount = 0;
    const fetcher = async () => { fetchCount += 1; return { tempKey: "tk-1", expiresAt: Date.now() + 60_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    expect(await c.get("oauth-tok", fetcher)).toBe("tk-1");
    expect(await c.get("oauth-tok", fetcher)).toBe("tk-1");
    expect(fetchCount).toBe(1);
  });

  it("expired entry triggers refetch", async () => {
    let t = 1_000_000;
    const fetcher = async () => { t += 0; return { tempKey: "tk-fresh", expiresAt: t + 1_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => t });
    await c.get("o", fetcher);
    t += 2_000;  // past expiry
    let count = 0;
    const f2 = async () => { count += 1; return { tempKey: "tk-new", expiresAt: t + 60_000 }; };
    const v = await c.get("o", f2);
    expect(v).toBe("tk-new");
    expect(count).toBe(1);
  });

  it("evict() forces refetch on next get", async () => {
    let count = 0;
    const fetcher = async () => { count += 1; return { tempKey: "tk-" + count, expiresAt: Date.now() + 60_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    expect(await c.get("o", fetcher)).toBe("tk-1");
    c.evict("o");
    expect(await c.get("o", fetcher)).toBe("tk-2");
  });

  it("concurrent gets on a cold cache issue exactly one fetch (single-flight)", async () => {
    let fetchCount = 0;
    let resolve!: (v: { tempKey: string; expiresAt: number }) => void;
    const fetcher = () => {
      fetchCount += 1;
      return new Promise<{ tempKey: string; expiresAt: number }>(r => { resolve = r; });
    };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    const p1 = c.get("o", fetcher);
    const p2 = c.get("o", fetcher);
    const p3 = c.get("o", fetcher);
    resolve({ tempKey: "tk-shared", expiresAt: Date.now() + 60_000 });
    expect(await p1).toBe("tk-shared");
    expect(await p2).toBe("tk-shared");
    expect(await p3).toBe("tk-shared");
    expect(fetchCount).toBe(1);
  });
});
