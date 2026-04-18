/**
 * Real-Anthropic OAuth integration test — costs a few cents per run (uses real
 * Anthropic API with max_tokens=10) and is OPT-IN. The intent: verify that
 * AnthropicAdapter's outgoing header shape (Authorization: Bearer +
 * anthropic-beta: oauth-2025-04-20) is what real Anthropic accepts for
 * `sk-ant-oat01-...` tokens, without needing a full smoke-test cycle (Docker +
 * agent image + daemon + container) just to exercise auth.
 *
 * Gated by RUN_REAL_INTEGRATION_TESTS=1 — `npm test` does NOT run this by
 * default (would burn API quota on every test invocation). To run:
 *
 *   RUN_REAL_INTEGRATION_TESTS=1 npx vitest run tests/integration/anthropic-oauth-real.test.ts
 *
 * Also requires credentials to resolve via the same discoverAnthropic() path
 * the daemon uses (env CLAUDE_CODE_OAUTH_TOKEN, macOS Keychain entry "Claude
 * Code-credentials", or ~/.claude/.credentials.json on Linux/Windows).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { request as httpsRequest } from "node:https";
import type { OutgoingHttpHeaders } from "node:http";
import { readEnvFile } from "../../src/env/env-file.js";
import { discoverAnthropic } from "../../src/env/anthropic-credentials.js";
import { AnthropicAdapter } from "../../src/model-proxy/adapters/anthropic-adapter.js";
import { AnthropicOAuthCache } from "../../src/model-proxy/adapters/anthropic-oauth-cache.js";

interface RealResponse {
  status: number;
  body: string;
}

const env = readEnvFile(resolve(process.cwd()), [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);
const creds = discoverAnthropic(env);

// Skip unless explicitly opted-in AND OAuth creds are available. The test
// still loads (so vitest reports a clear "skipped" line); we just don't make
// a real API call by default.
const optedIn = process.env.RUN_REAL_INTEGRATION_TESTS === "1";
const haveOAuth = creds !== null && creds.mode === "oauth";
const shouldRun = optedIn && haveOAuth;

describe.runIf(shouldRun)("AnthropicAdapter — real Anthropic OAuth", () => {
  it("Authorization: Bearer + anthropic-beta:oauth-2025-04-20 → 200 from /v1/messages", async () => {
    if (!creds || creds.mode !== "oauth") throw new Error("guard above should have skipped");

    // Build headers exactly the way our adapter would for a real request.
    const cache = new AnthropicOAuthCache();
    // Direct-passthrough exchange: this matches what daemon.ts does in
    // production now (the original spec'd /api/oauth/claude_cli/create_api_key
    // exchange is gated; sk-ant-oat01-* tokens work directly).
    const exchange = async (token: string) => ({
      tempKey: token,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    const adapter = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: creds.oauthToken, cache, exchange },
    });
    const headers: OutgoingHttpHeaders = {};
    await adapter.resolveAuth(headers);
    headers["anthropic-version"] = "2023-06-01";
    headers["content-type"] = "application/json";

    // Sanity check what we're sending — these MUST be present for the test to be meaningful.
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();

    // Pick a plausibly-current model id. Anthropic accepts both dotted-version
    // ("claude-sonnet-4-5") and dated forms; we use the alias to match
    // agents/claude-assistant/agent.yaml.
    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "Reply with exactly: oauth-test-ok" }],
    });
    headers["content-length"] = String(Buffer.byteLength(requestBody));

    const url = new URL(adapter.upstreamUrl());
    const resp = await new Promise<RealResponse>((resolveP, rejectP) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: "/v1/messages",
          method: "POST",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", rejectP);
        },
      );
      req.on("error", rejectP);
      req.write(requestBody);
      req.end();
    });

    // Always print the response so the operator sees what Anthropic returned.
    // eslint-disable-next-line no-console
    console.log(`[anthropic-oauth-real] status=${resp.status}, body=${resp.body.slice(0, 300)}`);

    // The point of THIS test is "did Anthropic accept our auth shape?", not
    // "is the model fully working." 401 or 403 = auth rejected (the bug we're
    // hunting). Anything else (200, 429 rate-limit, 400 bad-model, 5xx
    // upstream) = auth accepted; the request reached the model layer. Treat
    // all those as PASS for the auth-validation purpose.
    expect(
      resp.status,
      `Anthropic rejected the auth (status ${resp.status}). Body: ${resp.body.slice(0, 300)}`,
    ).not.toBe(401);
    expect(
      resp.status,
      `Anthropic rejected the auth (status ${resp.status}). Body: ${resp.body.slice(0, 300)}`,
    ).not.toBe(403);

    // Bonus: if it was a clean 200, sanity-check the response shape so a
    // future regression in extractUsage/parsing is caught here too.
    if (resp.status === 200) {
      const parsed = JSON.parse(resp.body) as { content?: Array<{ type: string; text?: string }> };
      expect(parsed.content, "response missing 'content' array").toBeTruthy();
      const textBlock = parsed.content?.find((b) => b.type === "text");
      expect(textBlock, "response had no 'text' block").toBeTruthy();
      expect(typeof textBlock?.text, "text block missing string content").toBe("string");
    }
  }, 30_000); // 30s timeout — real API call, can take a few seconds
});

describe.runIf(!shouldRun)("AnthropicAdapter — real Anthropic OAuth (skipped)", () => {
  it(
    `skipped: ${!optedIn ? "RUN_REAL_INTEGRATION_TESTS=1 not set" : "no OAuth credential found via discoverAnthropic()"}`,
    () => { expect(true).toBe(true); },
  );
});
