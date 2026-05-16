import { describe, expect, it } from "vitest";
import { buildPiModelConfig } from "./pi-model.js";

describe("buildPiModelConfig", () => {
  it("maps anthropic provider to an Anthropic-compatible Pi provider through Team Room proxy", () => {
    const cfg = buildPiModelConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      baseUrl: "http://host.docker.internal:9000",
      apiToken: "route-token",
    });

    expect(cfg.providerId).toBe("teamroom-anthropic");
    expect(cfg.modelId).toBe("claude-opus-4-7");
    expect(cfg.modelsJson.providers["teamroom-anthropic"]).toMatchObject({
      baseUrl: "http://host.docker.internal:9000",
      api: "anthropic-messages",
      apiKey: "route-token",
      models: [{ id: "claude-opus-4-7" }],
    });
  });

  it("maps lm-studio and ollama to OpenAI-compatible chat-completions providers through Team Room proxy", () => {
    for (const provider of ["lm-studio", "ollama"] as const) {
      const cfg = buildPiModelConfig({
        provider,
        model: "openai/gpt-oss-20b",
        baseUrl: "http://host.docker.internal:9000",
        apiToken: "route-token",
      });
      expect(cfg.modelsJson.providers[`teamroom-${provider}`]).toMatchObject({
        baseUrl: "http://host.docker.internal:9000/v1",
        api: "openai-completions",
        apiKey: "route-token",
        authHeader: true,
        models: [{ id: "openai/gpt-oss-20b" }],
      });
    }
  });

  it("maps provider openai to OpenAI chat completions and strips the provider prefix from the API model id", () => {
    const cfg = buildPiModelConfig({
      provider: "openai",
      model: "openai/gpt-5.5",
      baseUrl: "http://host.docker.internal:9000",
      apiToken: "route-token",
    });

    expect(cfg.providerId).toBe("openai");
    expect(cfg.modelId).toBe("gpt-5.5");
    expect(cfg.modelsJson.providers.openai).toMatchObject({
      baseUrl: "http://host.docker.internal:9000/v1",
      api: "openai-completions",
      apiKey: "route-token",
      authHeader: true,
      models: [{ id: "gpt-5.5" }],
    });
  });
});
