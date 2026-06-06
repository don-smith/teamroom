import { describe, it, expect } from "bun:test";
import { OpenAICompatAdapter } from "./openai-compat-adapter.js";

describe("OpenAICompatAdapter (bearer auth)", () => {
  const base = {
    id: "lm-studio" as const,
    upstreamUrl: "http://localhost:1234",
    auth: { mode: "bearer" as const, key: "real-tok" },
  };

  it("upstreamUrl returns the configured base URL", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.upstreamUrl()).toBe("http://localhost:1234");
  });

  it("authMode is 'api-key' for bearer auth", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.authMode).toBe("api-key");
  });

  it("resolveAuth replaces Authorization with the real key and strips x-api-key", async () => {
    const a = new OpenAICompatAdapter(base);
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    await a.resolveAuth(headers);
    expect(headers.authorization).toBe("Bearer real-tok");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});

describe("OpenAICompatAdapter (none auth)", () => {
  const base = {
    id: "ollama" as const,
    upstreamUrl: "http://localhost:11434",
    auth: { mode: "none" as const },
  };

  it("upstreamUrl returns the configured base URL", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.upstreamUrl()).toBe("http://localhost:11434");
  });

  it("authMode is 'api-key' (no OAuth flows involved)", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.authMode).toBe("api-key");
  });

  it("resolveAuth strips both Authorization and x-api-key", async () => {
    const a = new OpenAICompatAdapter(base);
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    await a.resolveAuth(headers);
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });
});

describe("OpenAICompatAdapter.extractUsage", () => {
  const a = new OpenAICompatAdapter({
    id: "lm-studio",
    upstreamUrl: "http://x",
    auth: { mode: "bearer", key: "k" },
  });

  it("reads OpenAI-shape usage fields", () => {
    expect(a.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } }))
      .toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("returns empty on non-object or missing usage", () => {
    expect(a.extractUsage(null)).toEqual({});
    expect(a.extractUsage({})).toEqual({});
    expect(a.extractUsage({ usage: null })).toEqual({});
  });
});
