import { describe, expect, it } from "bun:test";
import { composeModelProxy } from "./model-proxy.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";

describe("composeModelProxy", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  it("starts the local model proxy on an ephemeral port and exposes deps", async () => {
    const mp = await composeModelProxy({
      logger,
      openrouter: { upstreamUrl: "https://openrouter.ai/api", realKey: "openrouter-test" },
    });
    expect(mp.tokenRegistry).toBeDefined();
    expect(mp.modelProxy).toBeDefined();
    expect(mp.port).toBeGreaterThan(0);
    expect(mp.modelBaseUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    await mp.stop();
  });

  it("registers the openrouter OpenAI-compat adapter", async () => {
    const mp = await composeModelProxy({
      logger,
      openrouter: { upstreamUrl: "http://127.0.0.1:1", realKey: "test" },
    });
    const tok = mp.tokenRegistry.mint({
      agentId: "a", turnId: "t", traceId: "r",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
    expect(mp.tokenRegistry.lookup(tok)?.provider).toBe("openrouter");
    // The proxy should attempt to forward (fail with upstream_error since
    // 127.0.0.1:1 is closed), NOT return "no adapter" for the registered provider.
    const resp = await fetch(`http://127.0.0.1:${mp.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-api-key": tok, "content-type": "application/json" },
      body: "{}",
    });
    const body = await resp.text();
    expect(body).not.toMatch(/no adapter/);
    await mp.stop();
  });
});