import { describe, expect, it } from "bun:test";
import { resolveServeProviderTokens } from "./serve.js";

describe("resolveServeProviderTokens", () => {
  it("requires LM_STUDIO_API_TOKEN only when an lm-studio agent is configured", () => {
    expect(() =>
      resolveServeProviderTokens(["lm-studio"], {}),
    ).toThrow(/LM_STUDIO_API_TOKEN/);

    expect(
      resolveServeProviderTokens(["openrouter"], { OPENROUTER_API_KEY: "or-token" }),
    ).toEqual({
      lmStudioToken: null,
      openaiToken: null,
      openrouterToken: "or-token",
    });
  });

  it("does not require OPENAI_TOKEN when no openai agent is configured", () => {
    expect(
      resolveServeProviderTokens(
        ["lm-studio", "anthropic"],
        { LM_STUDIO_API_TOKEN: "lm-token" },
      ),
    ).toEqual({
      lmStudioToken: "lm-token",
      openaiToken: null,
      openrouterToken: null,
    });
  });

  it("requires OPENAI_TOKEN when an openai agent is configured", () => {
    expect(() =>
      resolveServeProviderTokens(
        ["lm-studio", "openai"],
        { LM_STUDIO_API_TOKEN: "lm-token" },
      ),
    ).toThrow(/OPENAI_TOKEN/);
  });

  it("requires OPENROUTER_API_KEY when an openrouter agent is configured", () => {
    expect(() =>
      resolveServeProviderTokens(
        ["lm-studio", "openrouter"],
        { LM_STUDIO_API_TOKEN: "lm-token" },
      ),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it("returns OPENROUTER_API_KEY when an openrouter agent is configured", () => {
    expect(
      resolveServeProviderTokens(
        ["lm-studio", "openrouter"],
        { LM_STUDIO_API_TOKEN: "lm-token", OPENROUTER_API_KEY: "or-token" },
      ),
    ).toEqual({
      lmStudioToken: "lm-token",
      openaiToken: null,
      openrouterToken: "or-token",
    });
  });
});
