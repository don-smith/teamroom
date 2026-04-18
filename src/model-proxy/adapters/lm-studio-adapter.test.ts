import { describe, it, expect } from "vitest";
import { LmStudioAdapter } from "./lm-studio-adapter.js";

describe("LmStudioAdapter", () => {
  it("upstreamUrl returns the configured base URL", () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://localhost:1234", realKey: "real-tok" });
    expect(a.upstreamUrl()).toBe("http://localhost:1234");
  });

  it("authMode is always 'api-key'", () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "k" });
    expect(a.authMode).toBe("api-key");
  });

  it("resolveAuth replaces Authorization with the real key", async () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "real-tok" });
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    await a.resolveAuth(headers);
    expect(headers.authorization).toBe("Bearer real-tok");
    // x-api-key is also passed through but LM Studio uses Bearer; still cleared:
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("extractUsage reads OpenAI-shape usage", () => {
    const u = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "k" }).extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});
