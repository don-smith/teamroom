import { describe, expect, it } from "vitest";
import { composeModelProxy } from "./model-proxy.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";

describe("composeModelProxy", () => {
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  it("starts the local model proxy on an ephemeral port and exposes deps", async () => {
    const mp = await composeModelProxy({
      logger,
      lmStudio: { upstreamUrl: "http://host.docker.internal:1234", realKey: "test" },
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
      anthropic: { mode: "api-key", apiKey: "sk-test" },
    });
    expect(mp.anthropicAdapterPresent).toBe(true);
    await mp.stop();
  });
});
