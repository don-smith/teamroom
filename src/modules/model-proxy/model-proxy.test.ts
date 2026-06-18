import { describe, expect, it } from "bun:test";
import { composeModelProxy } from "./model-proxy.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";

describe("composeModelProxy", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  it("starts the local model proxy on an ephemeral port and exposes deps", async () => {
    const mp = await composeModelProxy({
      logger,
      lmStudio: { upstreamUrl: "http://host.docker.internal:1234", realKey: "test" },
      ollama: { upstreamUrl: "http://host.docker.internal:11434" },
      openai: { upstreamUrl: "https://api.openai.com", realKey: "openai-test" },
      openrouter: { upstreamUrl: "https://openrouter.ai/api", realKey: "openrouter-test" },
      anthropic: null,
    });
    expect(mp.tokenRegistry).toBeDefined();
    expect(mp.modelProxy).toBeDefined();
    expect(mp.port).toBeGreaterThan(0);
    expect(mp.modelBaseUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(mp.anthropicAdapterPresent).toBe(false);
    await mp.stop();
  });

  it("includes the anthropic adapter when creds provided", async () => {
    const mp = await composeModelProxy({
      logger,
      lmStudio: { upstreamUrl: "http://host.docker.internal:1234", realKey: "test" },
      ollama: { upstreamUrl: "http://host.docker.internal:11434" },
      openai: { upstreamUrl: "https://api.openai.com", realKey: "openai-test" },
      openrouter: { upstreamUrl: "https://openrouter.ai/api", realKey: "openrouter-test" },
      anthropic: { mode: "api-key", apiKey: "sk-test" },
    });
    expect(mp.anthropicAdapterPresent).toBe(true);
    await mp.stop();
  });

  it("includes the anthropic adapter for the oauth branch (directOAuthPassthrough)", async () => {
    const mp = await composeModelProxy({
      logger,
      lmStudio: { upstreamUrl: "http://host.docker.internal:1234", realKey: "test" },
      ollama: { upstreamUrl: "http://host.docker.internal:11434" },
      openai: { upstreamUrl: "https://api.openai.com", realKey: "openai-test" },
      openrouter: { upstreamUrl: "https://openrouter.ai/api", realKey: "openrouter-test" },
      anthropic: { mode: "oauth", oauthToken: "oauth-token-test" },
    });
    expect(mp.anthropicAdapterPresent).toBe(true);
    await mp.stop();
  });

  it("registers lm-studio, ollama, openai, and openrouter OpenAI-compat adapters", async () => {
    // Use an unreachable-but-immediately-failing upstream (127.0.0.1 on a
    // closed port) so the forward path fails fast with ECONNREFUSED rather
    // than paying DNS-resolution latency. We only care that the proxy
    // CONSULTED the adapter, which is proven by the absence of
    // `"no adapter"` in the response body.
    const mp = await composeModelProxy({
      logger,
      lmStudio: { upstreamUrl: "http://127.0.0.1:1", realKey: "k" },
      ollama: { upstreamUrl: "http://127.0.0.1:1" },
      openai: { upstreamUrl: "http://127.0.0.1:1", realKey: "openai-test" },
      openrouter: { upstreamUrl: "http://127.0.0.1:1", realKey: "openrouter-test" },
      anthropic: null,
    });
    const t1 = mp.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "lm-studio", model: "m" });
    const t2 = mp.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "ollama", model: "m" });
    const t3 = mp.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "openai", model: "openai/gpt-5.5" });
    const t4 = mp.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
    // Registry sanity checks (cheap, still valid).
    expect(mp.tokenRegistry.lookup(t1)?.provider).toBe("lm-studio");
    expect(mp.tokenRegistry.lookup(t2)?.provider).toBe("ollama");
    expect(mp.tokenRegistry.lookup(t3)?.provider).toBe("openai");
    expect(mp.tokenRegistry.lookup(t4)?.provider).toBe("openrouter");
    // Actually exercise the proxy: a token whose provider has no registered
    // adapter returns 500 `{"error": "no adapter for provider"}` (see
    // local-model-proxy.ts "no_adapter" branch). A registered adapter will
    // instead attempt to forward and fail with 502 upstream_error. Either
    // way, the response body must NOT contain "no adapter".
    for (const tok of [t1, t2, t3, t4]) {
      const resp = await fetch(`http://127.0.0.1:${mp.port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": tok, "content-type": "application/json" },
        body: "{}",
      });
      const body = await resp.text();
      expect(body).not.toMatch(/no adapter/);
    }
    await mp.stop();
  });
});
