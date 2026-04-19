/**
 * Real-LM-Studio integration test. Hits a locally-running LM Studio instance
 * via the FULL container-side OpenAI SDK chain through our LocalModelProxy.
 * Mirrors what the agent container does in production:
 *   container OpenAI SDK → ANTHROPIC_BASE_URL-style routing →
 *   LocalModelProxy (LmStudioAdapter substitutes routing token for real LM
 *   Studio API token) → real LM Studio at localhost:1234.
 *
 * Two cases:
 *   1. Single-turn round-trip — proves the proxy + SDK + LM Studio chain
 *      works end-to-end with the OpenAI SDK's actual path-construction
 *      (`/v1/chat/completions`), which our integration tests against fake
 *      upstreams cannot exercise (they bypass the SDK).
 *   2. Multi-turn codeword recall — proves message-history forwarding works
 *      through the proxy. The OpenAI API is stateless, so this verifies the
 *      proxy doesn't munge or drop the messages array.
 *
 * Runs as part of `npm test`. Fails loudly with a remediation message if
 * preconditions aren't met (LM_STUDIO_API_TOKEN missing, LM Studio not
 * reachable) — no silent skip per project preference.
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import OpenAI from "openai";
import { readEnvFile } from "../../src/env/env-file.js";
import { LocalModelProxy } from "../../src/model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../src/model-proxy/token-registry.js";
import { LmStudioAdapter } from "../../src/model-proxy/adapters/lm-studio-adapter.js";
import { AnthropicAdapter } from "../../src/model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../../src/model-proxy/adapters/anthropic-oauth-cache.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { SystemClock } from "../../src/clock/clock.js";

const env = readEnvFile(resolve(process.cwd()), ["LM_STUDIO_API_TOKEN", "LM_STUDIO_BASE_URL"]);
const lmStudioToken = env.LM_STUDIO_API_TOKEN;
const lmStudioUrl = env.LM_STUDIO_BASE_URL ?? "http://localhost:1234";
// Mirrors agents/studio-assistant/agent.yaml — keep in sync.
const LM_STUDIO_MODEL = "qwen/qwen3.5-9b";

async function isLmStudioReachable(url: string): Promise<boolean> {
  try {
    // Any HTTP response counts as reachable — we only care whether the
    // server is listening and speaking HTTP. Auth failures (401 when the
    // server is configured to require a key on /v1/models) should NOT
    // fail this probe; the real test below hits /v1/chat/completions
    // with the configured token and surfaces real auth errors there.
    // Matches the smoke-test script's `curl` (no -f) behaviour.
    await fetch(`${url}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

describe("OpenAI SDK against real LM Studio via proxy", () => {
  // Restore env vars we mutate so other tests aren't polluted.
  const savedEnv = {
    LM_STUDIO_API_TOKEN: process.env.LM_STUDIO_API_TOKEN,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("single-turn round-trip via proxy returns non-empty text", async () => {
    expect(
      lmStudioToken,
      "LM_STUDIO_API_TOKEN missing from .env — required for studio-assistant tests. See .env.example.",
    ).toBeTruthy();
    expect(
      await isLmStudioReachable(lmStudioUrl),
      `LM Studio not reachable at ${lmStudioUrl}/v1/models — start LM Studio and load a model. Or set LM_STUDIO_BASE_URL=http://... in .env if it's on a different host. See docs/runbooks/smoke-test.md.`,
    ).toBe(true);
    if (!lmStudioToken) throw new Error("unreachable after guards");

    const adapter = new LmStudioAdapter({ upstreamUrl: lmStudioUrl, realKey: lmStudioToken });
    const anthropicStub = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "unused" } });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: anthropicStub, "lm-studio": adapter },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();

    try {
      const routingToken = registry.mint({
        agentId: "studio-assistant",
        turnId: "lm-studio-integration",
        traceId: "lm-studio-trace",
        provider: "lm-studio",
        model: LM_STUDIO_MODEL,
      });

      // The OpenAI SDK appends `/chat/completions` to baseURL — `/v1` must be
      // in the baseURL itself. Mirrors agent-runtime/main.ts.
      const sdk = new OpenAI({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: routingToken,
      });

      // max_tokens is high enough to let reasoning models (e.g. qwen3)
      // complete their thinking phase AND emit visible content. 1024
      // mirrors agent-runtime/main.ts (production path). Non-reasoning
      // models are unaffected — they stop on `stop`, not on length.
      const resp = await sdk.chat.completions.create({
        model: LM_STUDIO_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with exactly: studio-int-ok" }],
      });

      const text = resp.choices[0]?.message?.content ?? "";
      // eslint-disable-next-line no-console
      console.log(`[lm-studio-real] single-turn text=${JSON.stringify(text).slice(0, 200)}`);
      expect(text, "expected non-empty assistant text from LM Studio").toBeTruthy();
      expect(typeof text).toBe("string");
    } finally {
      await proxy.stop();
    }
  }, 60_000);

  it("multi-turn codeword recall via the same proxy + maintained messages array", async () => {
    expect(lmStudioToken, "LM_STUDIO_API_TOKEN missing from .env").toBeTruthy();
    expect(
      await isLmStudioReachable(lmStudioUrl),
      `LM Studio not reachable at ${lmStudioUrl}/v1/models`,
    ).toBe(true);
    if (!lmStudioToken) throw new Error("unreachable after guards");

    const adapter = new LmStudioAdapter({ upstreamUrl: lmStudioUrl, realKey: lmStudioToken });
    const anthropicStub = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "unused" } });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: anthropicStub, "lm-studio": adapter },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();

    try {
      const routingToken = registry.mint({
        agentId: "studio-assistant",
        turnId: "lm-studio-multi-turn",
        traceId: "lm-studio-multi-trace",
        provider: "lm-studio",
        model: LM_STUDIO_MODEL,
      });

      const sdk = new OpenAI({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: routingToken,
      });

      // Use a unique codeword so any leaked context from prior runs can't
      // accidentally satisfy the assertion.
      const codeword = `cw-${Math.random().toString(16).slice(2, 10)}`;

      // Turn 1: introduce codeword. Maintain messages array between calls
      // (this is what runtime.ts does in production via /store/conversation.jsonl).
      const messages: { role: "user" | "assistant" | "system"; content: string }[] = [
        { role: "system", content: "Be brief. Reply with the minimum needed." },
        { role: "user", content: `Remember this codeword: ${codeword}. Reply with exactly: ack-mt` },
      ];
      const resp1 = await sdk.chat.completions.create({
        model: LM_STUDIO_MODEL,
        max_tokens: 1024,
        messages,
      });
      const turn1Text = resp1.choices[0]?.message?.content ?? "";
      // eslint-disable-next-line no-console
      console.log(`[lm-studio-real] multi-turn turn1=${JSON.stringify(turn1Text).slice(0, 200)}`);
      messages.push({ role: "assistant", content: turn1Text });

      // Turn 2: ask for codeword recall.
      messages.push({
        role: "user",
        content: "What was the codeword I just told you? Reply with just the codeword, nothing else.",
      });
      const resp2 = await sdk.chat.completions.create({
        model: LM_STUDIO_MODEL,
        max_tokens: 1024,
        messages,
      });
      const turn2Text = resp2.choices[0]?.message?.content ?? "";
      // eslint-disable-next-line no-console
      console.log(`[lm-studio-real] multi-turn turn2=${JSON.stringify(turn2Text).slice(0, 200)}`);

      expect(
        turn2Text.toLowerCase(),
        `LM Studio didn't recall '${codeword}' on turn 2. Got: '${turn2Text}'. The proxy may be stripping or munging the messages array.`,
      ).toContain(codeword);
    } finally {
      await proxy.stop();
    }
  }, 120_000); // 120s — two LM Studio generations back-to-back
});
