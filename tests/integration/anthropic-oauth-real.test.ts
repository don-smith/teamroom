/**
 * Real-Anthropic OAuth integration test. Hits real api.anthropic.com via the
 * full SDK→proxy→Anthropic chain (claude-agent-sdk in this process spawns the
 * Claude Code CLI as a subprocess, which honors ANTHROPIC_BASE_URL pointing at
 * our LocalModelProxy, which substitutes the routing token for the real OAuth
 * credential before forwarding upstream). Costs a tiny amount of subscription
 * quota per run (~tens of tokens — negligible vs. a normal Claude Code
 * conversation).
 *
 * This test exercises the SAME path the agent container uses in production —
 * just without Docker and without the daemon. If this passes, the smoke test
 * will pass too (modulo Docker/build issues that have their own diagnostics).
 *
 * Runs as part of `npm test`. Credentials are discovered via the same
 * discoverAnthropic() path the daemon uses (env CLAUDE_CODE_OAUTH_TOKEN, macOS
 * Keychain entry "Claude Code-credentials", or ~/.claude/.credentials.json on
 * Linux/Windows). Fails loudly with a remediation message if creds aren't
 * available — there's no silent skip.
 *
 * Requires the Claude Code CLI to be installed locally (the SDK spawns it):
 *   npm install -g @anthropic-ai/claude-code
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "../../src/env/env-file.js";
import { discoverAnthropic } from "../../src/env/anthropic-credentials.js";
import { LocalModelProxy } from "../../src/model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../src/model-proxy/token-registry.js";
import { AnthropicAdapter } from "../../src/model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../../src/model-proxy/adapters/anthropic-oauth-cache.js";
import { LmStudioAdapter } from "../../src/model-proxy/adapters/lm-studio-adapter.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { SystemClock } from "../../src/clock/clock.js";
import { AnthropicLlmClient } from "../../src/agent-runtime/anthropic-llm-client.js";

loadEnvFile(resolve(process.cwd()));
const creds = discoverAnthropic();

describe("AnthropicLlmClient — real Anthropic via proxy + claude-agent-sdk", () => {
  // Capture and restore env vars we mutate so other tests aren't polluted.
  const savedEnv = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("createMessage round-trip via proxy returns non-empty text from claude-opus-4-7", async () => {
    // Fail loudly if creds aren't set up — a skipped test is too easy to miss.
    expect(
      creds,
      "no Anthropic credential discoverable — set CLAUDE_CODE_OAUTH_TOKEN in .env, log into Claude Code (macOS Keychain entry 'Claude Code-credentials' is picked up automatically), or place ~/.claude/.credentials.json. See docs/runbooks/anthropic-auth.md.",
    ).not.toBeNull();
    expect(
      creds?.mode,
      `Anthropic credential resolved to mode=${creds?.mode}. This test only validates the OAuth path. Switch to ANTHROPIC_API_KEY=... in .env to exercise the API-key path.`,
    ).toBe("oauth");
    if (!creds || creds.mode !== "oauth") throw new Error("unreachable after guards");

    // Stand up our proxy with a real AnthropicAdapter in OAuth mode pointing
    // at real api.anthropic.com. The cache + exchange machinery is identical
    // to what daemon.ts wires in production.
    const cache = new AnthropicOAuthCache();
    const exchange = async (token: string) => ({
      tempKey: token,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    const adapter = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: creds.oauthToken, cache, exchange },
    });
    const lmStudio = new LmStudioAdapter({ upstreamUrl: "http://unused", realKey: "_" });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: adapter, "lm-studio": lmStudio },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();

    try {
      const routingToken = registry.mint({
        agentId: "claude-assistant",
        turnId: "integration-test-turn",
        traceId: "integration-test-trace",
        provider: "anthropic",
        model: "claude-opus-4-7",
      });

      // Configure the SDK subprocess to route through our proxy by setting
      // env vars before constructing the client. The SDK reads process.env.
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.ANTHROPIC_AUTH_TOKEN = routingToken;
      // Make sure no API key shadowing leaks in.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Use temp paths so the test doesn't try to mkdir /store (only exists
      // in the container).
      const sessionStore = mkdtempSync(join(tmpdir(), "teamroom-anthropic-test-"));
      try {
        const client = new AnthropicLlmClient({
          sessionIdFile: join(sessionStore, "anthropic-session.txt"),
          configDir: join(sessionStore, "claude-sdk"),
          cwd: join(sessionStore, "work"),
        });
        const result = await client.createMessage({
        model: "claude-opus-4-7",
        system: "Reply with a single short word.",
        messages: [{ role: "user", content: "Reply with exactly: oauth-test-ok" }],
      });

        // eslint-disable-next-line no-console
        console.log(`[anthropic-oauth-real] result.text=${JSON.stringify(result.text).slice(0, 200)}`);
        expect(result.text, "expected non-empty assistant text from /v1/messages").toBeTruthy();
        expect(typeof result.text).toBe("string");
      } finally {
        rmSync(sessionStore, { recursive: true, force: true });
      }
    } finally {
      await proxy.stop();
    }
  }, 60_000); // 60s — real CLI subprocess + real Anthropic call

  it("persists session across createMessage calls (multi-turn conversation)", async () => {
    expect(creds, "no Anthropic credential discoverable").not.toBeNull();
    expect(creds?.mode).toBe("oauth");
    if (!creds || creds.mode !== "oauth") throw new Error("unreachable after guards");

    // Same proxy setup as the first test — keep both calls going through the
    // same proxy instance + same routing-token entry so we're testing the
    // SDK's session resume, not anything external.
    const cache = new AnthropicOAuthCache();
    const exchange = async (token: string) => ({
      tempKey: token,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    const adapter = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: creds.oauthToken, cache, exchange },
    });
    const lmStudio = new LmStudioAdapter({ upstreamUrl: "http://unused", realKey: "_" });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: adapter, "lm-studio": lmStudio },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();

    const sessionStore = mkdtempSync(join(tmpdir(), "teamroom-anthropic-multi-"));
    try {
      const routingToken = registry.mint({
        agentId: "claude-assistant",
        turnId: "multi-turn-test",
        traceId: "multi-turn-trace",
        provider: "anthropic",
        model: "claude-opus-4-7",
      });
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.ANTHROPIC_AUTH_TOKEN = routingToken;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

      // Use the SAME client instance across both turns so the sidecar file
      // is shared. (In production, a fresh client is constructed per turn
      // inside a fresh container, but the sidecar is in /store which is the
      // persistent mount — same effect.)
      const client = new AnthropicLlmClient({
        sessionIdFile: join(sessionStore, "anthropic-session.txt"),
        configDir: join(sessionStore, "claude-sdk"),
        cwd: join(sessionStore, "work"),
      });

      // Turn 1: introduce a fact only this conversation knows about.
      const turn1 = await client.createMessage({
        model: "claude-opus-4-7",
        system: "Be brief.",
        messages: [
          { role: "user", content: "Remember this codeword: pelican-2926. Reply with just 'ok'." },
        ],
      });
      // eslint-disable-next-line no-console
      console.log(`[multi-turn] turn1.text=${JSON.stringify(turn1.text).slice(0, 200)}`);
      expect(turn1.text).toBeTruthy();

      // Turn 2: recall the codeword. If session resume works, the model
      // remembers; if not, it'll say it doesn't know.
      const turn2 = await client.createMessage({
        model: "claude-opus-4-7",
        system: "Be brief.",
        messages: [
          { role: "user", content: "What was the codeword I just gave you? Reply with just the codeword, nothing else." },
        ],
      });
      // eslint-disable-next-line no-console
      console.log(`[multi-turn] turn2.text=${JSON.stringify(turn2.text).slice(0, 200)}`);
      expect(
        turn2.text.toLowerCase(),
        `turn 2 didn't recall the codeword — session resume isn't working. Got: ${turn2.text}`,
      ).toContain("pelican-2926");
    } finally {
      rmSync(sessionStore, { recursive: true, force: true });
      await proxy.stop();
    }
  }, 120_000); // 120s — two real Claude calls back-to-back
});
