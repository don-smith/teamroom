import { describe, it, expect } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { LocalModelProxy } from "../../src/model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../src/model-proxy/token-registry.js";
import { AnthropicAdapter } from "../../src/model-proxy/adapters/anthropic-adapter.js";
import { OpenAICompatAdapter } from "../../src/model-proxy/adapters/openai-compat-adapter.js";
import { AnthropicOAuthCache } from "../../src/model-proxy/adapters/anthropic-oauth-cache.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { SystemClock } from "../../src/clock/clock.js";

interface RouteHandler {
  (req: { headers: Record<string, string | string[] | undefined>; body: string; calls: number }): { status: number; body: string };
}

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  recorded: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
}

async function startFake(routes: Record<string, RouteHandler>): Promise<FakeUpstream> {
  let calls = 0;
  const recorded: FakeUpstream["recorded"] = [];
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        calls += 1;
        const body = Buffer.concat(chunks).toString("utf8");
        recorded.push({ path: req.url ?? "", headers: req.headers, body });
        const handler = routes[req.url ?? ""] ?? (() => ({ status: 404, body: "{}" }));
        const out = handler({ headers: req.headers, body, calls });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    }).listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
        recorded,
      });
    });
  });
}

async function postToProxy(port: number, path: string, headers: Record<string, string>, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } },
      (res) => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("proxy end-to-end", () => {
  it("API-key mode: routing token is substituted with real key before reaching upstream", async () => {
    const upstream = await startFake({
      "/v1/messages": () => ({
        status: 200,
        body: JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
      }),
    });
    const adapter = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "sk-real" }, upstreamUrl: upstream.url });
    const lmStudio = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: "http://unused", auth: { mode: "bearer", key: "_" } });
    const ollama = new OpenAICompatAdapter({ id: "ollama", upstreamUrl: "http://unused.invalid", auth: { mode: "none" } });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: adapter, "lm-studio": lmStudio, ollama },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();
    const tok = registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "x" });

    await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");

    const firstReq = upstream.recorded[0];
    if (!firstReq) throw new Error("expected recorded upstream request");
    expect(firstReq.headers["x-api-key"]).toBe("sk-real");

    await proxy.stop();
    await upstream.close();
  });

  it("OAuth mode: cached temp key is reused across two calls; only one exchange happens", async () => {
    let messagesCalls = 0;
    let exchangeCalls = 0;
    const upstream = await startFake({
      "/api/oauth/claude_cli/create_api_key": () => {
        exchangeCalls += 1;
        return { status: 200, body: JSON.stringify({ api_key: "tk-issued", expires_at: Date.now() + 60_000 }) };
      },
      "/v1/messages": () => {
        messagesCalls += 1;
        return {
          status: 200,
          body: JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }),
        };
      },
    });
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async (): Promise<{ tempKey: string; expiresAt: number }> => {
      // Real round-trip to the fake upstream's OAuth endpoint, mirroring the production
      // exchange in src/daemon/daemon.ts but standalone for this test.
      const url = new URL(upstream.url + "/api/oauth/claude_cli/create_api_key");
      return new Promise((resolveP, rejectP) => {
        const r = httpRequest(
          { host: url.hostname, port: Number(url.port), path: url.pathname, method: "POST", headers: { "content-length": "0" } },
          (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c: Buffer) => chunks.push(c));
            resp.on("end", () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { api_key: string; expires_at: number };
                resolveP({ tempKey: parsed.api_key, expiresAt: parsed.expires_at });
              } catch (err) {
                rejectP(err as Error);
              }
            });
          },
        );
        r.on("error", rejectP);
        r.end();
      });
    };
    const adapter = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: "oauth-1", cache, exchange },
      upstreamUrl: upstream.url,
    });
    const lmStudio = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: "http://unused", auth: { mode: "bearer", key: "_" } });
    const ollama = new OpenAICompatAdapter({ id: "ollama", upstreamUrl: "http://unused.invalid", auth: { mode: "none" } });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: { anthropic: adapter, "lm-studio": lmStudio, ollama },
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();
    const tok = registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "x" });

    await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");
    await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");

    expect(messagesCalls).toBe(2);
    expect(exchangeCalls).toBe(1);

    await proxy.stop();
    await upstream.close();
  });

  it("Provider isolation: studio-assistant and claude-assistant requests reach distinct upstreams", async () => {
    const anthropicUpstream = await startFake({
      "/v1/messages": () => ({
        status: 200,
        body: '{"content":[{"type":"text","text":"a"}],"usage":{"input_tokens":1,"output_tokens":1}}',
      }),
    });
    const lmStudioUpstream = await startFake({
      "/v1/chat/completions": () => ({
        status: 200,
        body: '{"choices":[{"message":{"content":"l"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      }),
    });
    const adapters = {
      anthropic: new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "sk-a" }, upstreamUrl: anthropicUpstream.url }),
      "lm-studio": new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: lmStudioUpstream.url, auth: { mode: "bearer", key: "lm-real" } }),
      ollama: new OpenAICompatAdapter({ id: "ollama", upstreamUrl: "http://unused.invalid", auth: { mode: "none" } }),
    };
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters,
      logger: new CapturingLogger(new SystemClock()),
    });
    const { port } = await proxy.start();
    const aTok = registry.mint({ agentId: "claude-assistant", turnId: "t1", traceId: "tr1", provider: "anthropic", model: "claude" });
    const lTok = registry.mint({ agentId: "studio-assistant", turnId: "t2", traceId: "tr2", provider: "lm-studio", model: "qwen" });

    await postToProxy(port, "/v1/messages", { "x-api-key": aTok }, "{}");
    await postToProxy(port, "/v1/chat/completions", { "x-api-key": lTok }, "{}");

    const anthReq = anthropicUpstream.recorded[0];
    const lmReq = lmStudioUpstream.recorded[0];
    if (!anthReq || !lmReq) throw new Error("expected recorded upstream requests");
    expect(anthReq.headers["x-api-key"]).toBe("sk-a");
    expect(lmReq.headers.authorization).toBe("Bearer lm-real");

    await proxy.stop();
    await anthropicUpstream.close();
    await lmStudioUpstream.close();
  });
});
