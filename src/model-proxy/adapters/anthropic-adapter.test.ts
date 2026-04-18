import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter.js";

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

  it("injectAuth replaces x-api-key with the real key", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode });
    const headers: Record<string, string | string[] | undefined> = {
      "x-api-key": "routing-token",
      authorization: "Bearer should-be-removed",
    };
    a.injectAuth(headers);
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
