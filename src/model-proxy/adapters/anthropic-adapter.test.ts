import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

const apiKeyMode = { mode: "api-key" as const, apiKey: "sk-ant-real" };

describe("AnthropicAdapter — API-key mode", () => {
  it("upstreamUrl defaults to api.anthropic.com", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode });
    expect(a.upstreamUrl()).toBe("https://api.anthropic.com");
  });

  it("upstreamUrl honors override", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode, upstreamUrl: "http://test-server:9999" });
    expect(a.upstreamUrl()).toBe("http://test-server:9999");
  });

  it("authMode reflects the configured mode", () => {
    expect(new AnthropicAdapter({ auth: apiKeyMode }).authMode).toBe("api-key");
  });

  it("resolveAuth replaces x-api-key with the real key", async () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode });
    const headers: Record<string, string | string[] | undefined> = {
      "x-api-key": "routing-token",
      authorization: "Bearer should-be-removed",
    };
    await a.resolveAuth(headers);
    expect(headers["x-api-key"]).toBe("sk-ant-real");
    expect(headers.authorization).toBeUndefined();
  });

  it("extractUsage reads Anthropic-shape usage", () => {
    const u = new AnthropicAdapter({ auth: apiKeyMode }).extractUsage({
      usage: { input_tokens: 7, output_tokens: 11 },
    });
    expect(u).toEqual({ inputTokens: 7, outputTokens: 11 });
  });
});

describe("AnthropicAdapter — OAuth mode", () => {
  it("first call fetches via exchange and stores the temp key as Authorization: Bearer", async () => {
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async (tok: string) => ({ tempKey: "tk-" + tok, expiresAt: Date.now() + 60_000 });
    const a = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: "oauth-1", cache, exchange },
    });
    const headers: Record<string, string | string[] | undefined> = { "x-api-key": "routing" };
    await a.resolveAuth(headers);
    // OAuth tokens go in Authorization: Bearer (NOT x-api-key — Anthropic
    // accepts those only for raw API keys). The original x-api-key
    // (routing token) is removed.
    expect(headers.authorization).toBe("Bearer tk-oauth-1");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("adds the anthropic-beta: oauth-2025-04-20 header in OAuth mode", async () => {
    // Required by Anthropic to opt the request into OAuth-token use against
    // /v1/messages. Without this header, the bearer auth is rejected.
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => ({ tempKey: "tk", expiresAt: Date.now() + 60_000 });
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    const headers: Record<string, string | string[] | undefined> = {};
    await a.resolveAuth(headers);
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("merges oauth-2025-04-20 into a pre-existing anthropic-beta header (deduplicated)", async () => {
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => ({ tempKey: "tk", expiresAt: Date.now() + 60_000 });
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    const headers: Record<string, string | string[] | undefined> = {
      "anthropic-beta": "files-api-2025-04-14,oauth-2025-04-20",
    };
    await a.resolveAuth(headers);
    expect(headers["anthropic-beta"]).toBe("files-api-2025-04-14,oauth-2025-04-20");
  });

  it("second call within TTL reuses cached temp key (no second exchange)", async () => {
    let exchangeCount = 0;
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => {
      exchangeCount += 1;
      return { tempKey: "tk", expiresAt: Date.now() + 60_000 };
    };
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    await a.resolveAuth({ "x-api-key": "x" });
    await a.resolveAuth({ "x-api-key": "x" });
    expect(exchangeCount).toBe(1);
  });

  it("onUpstreamUnauthorized() forces refetch on next resolveAuth", async () => {
    let exchangeCount = 0;
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => {
      exchangeCount += 1;
      return { tempKey: "tk-" + exchangeCount, expiresAt: Date.now() + 60_000 };
    };
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    await a.resolveAuth({ "x-api-key": "x" });
    a.onUpstreamUnauthorized?.();
    await a.resolveAuth({ "x-api-key": "x" });
    expect(exchangeCount).toBe(2);
  });
});
