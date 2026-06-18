import { describe, expect, it } from "bun:test";
import { buildPiModelConfig } from "./pi-model.js";

describe("buildPiModelConfig", () => {
  it("maps openrouter provider to an OpenAI-compatible Pi provider through Team Room proxy", () => {
    const cfg = buildPiModelConfig({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      baseUrl: "http://host.docker.internal:9000",
      apiToken: "route-token",
    });

    expect(cfg.providerId).toBe("teamroom-openrouter");
    expect(cfg.modelId).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.modelsJson.providers["teamroom-openrouter"]).toMatchObject({
      baseUrl: "http://host.docker.internal:9000/v1",
      api: "openai-completions",
      apiKey: "route-token",
      authHeader: true,
      models: [{ id: "deepseek/deepseek-v4-flash" }],
    });
  });
});