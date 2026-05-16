import { describe, it, expect, beforeEach } from "bun:test";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { LocalModelProxy } from "./local-model-proxy.js";
import { TokenRegistry } from "./token-registry.js";
import { AnthropicAdapter } from "./adapters/anthropic-adapter.js";
import { OpenAICompatAdapter } from "./adapters/openai-compat-adapter.js";
import { AnthropicOAuthCache } from "./adapters/anthropic-oauth-cache.js";
import { CapturingLogger } from "../logger/logger.js";
import { SystemClock } from "../clock/clock.js";

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  recorded: Recorded[];
}

function startFakeUpstream(
  handler: (req: Recorded) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    const recorded: Recorded[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const r: Recorded = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body,
        };
        recorded.push(r);
        const out = await handler(r);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    });
    s.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            for (const socket of sockets) socket.destroy();
            s.close(() => r());
          }),
        recorded,
      });
    });
  });
}

function postToProxy(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("LocalModelProxy", () => {
  let logger: CapturingLogger;

  beforeEach(() => {
    logger = new CapturingLogger(new SystemClock());
  });

  it("API-key mode: substitutes x-api-key with real key and forwards", async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({ id: "x", usage: { input_tokens: 1, output_tokens: 2 } }),
    }));
    const registry = new TokenRegistry();
    const adapter = new AnthropicAdapter({
      auth: { mode: "api-key", apiKey: "sk-real" },
      upstreamUrl: upstream.url,
    });
    const proxy = new LocalModelProxy({
      registry,
      adapters: {
        anthropic: adapter,
        "lm-studio": new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: "http://x", auth: { mode: "bearer", key: "_" } }),
        ollama: new OpenAICompatAdapter({ id: "ollama", upstreamUrl: "http://unused.invalid", auth: { mode: "none" } }),
      },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "anthropic",
      model: "claude-x",
    });

    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    const firstReq = upstream.recorded[0];
    if (!firstReq) throw new Error("expected recorded upstream request");
    expect(firstReq.headers["x-api-key"]).toBe("sk-real");

    const span = logger.entries.find((r) => r.event === "model.call.completed");
    expect(span).toMatchObject({
      provider: "anthropic",
      inputTokens: 1,
      outputTokens: 2,
      status: "ok",
      httpStatus: 200,
    });

    await proxy.stop();
    await upstream.close();
  });

  it("unknown routing token → 401 with model.call.rejected span", async () => {
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: "http://unused", auth: { mode: "bearer", key: "_" } });
    const proxy = new LocalModelProxy({
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: { anthropic: adapter as any, "lm-studio": adapter, ollama: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": "ghost-token" }, "{}");
    expect(resp.status).toBe(401);
    const span = logger.entries.find((r) => r.event === "model.call.rejected");
    expect(span).toMatchObject({ errorClass: "unknown_token" });
    expect(span?.tokenPrefix).toBe("ghost-to");
    await proxy.stop();
  });

  it("OAuth mode: 401 from upstream triggers credential-refresh retry exactly once", async () => {
    let upstreamCalls = 0;
    const upstream = await startFakeUpstream(() => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) return { status: 401, body: '{"error":"expired"}' };
      return { status: 200, body: '{"usage":{"input_tokens":3,"output_tokens":4}}' };
    });
    let exchangeCalls = 0;
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    // pre-seed cache with a "known" temp key so first call uses cache, gets 401, evicts, refetches via exchange
    await cache.get("oauth-tok", async () => ({ tempKey: "tk-stale", expiresAt: Date.now() + 60_000 }));
    const adapter = new AnthropicAdapter({
      auth: {
        mode: "oauth",
        oauthToken: "oauth-tok",
        cache,
        exchange: async () => {
          exchangeCalls += 1;
          return { tempKey: "tk-fresh", expiresAt: Date.now() + 60_000 };
        },
      },
      upstreamUrl: upstream.url,
    });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({
      registry,
      adapters: {
        anthropic: adapter,
        "lm-studio": new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: "http://x", auth: { mode: "bearer", key: "_" } }),
        ollama: new OpenAICompatAdapter({ id: "ollama", upstreamUrl: "http://unused.invalid", auth: { mode: "none" } }),
      },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "anthropic",
      model: "claude-x",
    });
    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    expect(exchangeCalls).toBe(1);
    await proxy.stop();
    await upstream.close();
  });

  it("upstream timeout → 504 + upstream_timeout span", async () => {
    const upstream = await startFakeUpstream(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { status: 200, body: "{}" };
    });
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "k" } });
    const proxy = new LocalModelProxy({
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: { anthropic: adapter as any, "lm-studio": adapter, ollama: adapter },
      logger,
      upstreamTimeoutMs: 50,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "lm-studio",
      model: "x",
    });
    const resp = await postToProxy(port, "/v1/chat/completions", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(504);
    const timeoutSpan = logger.entries.find(
      (r) => r.event === "model.call.completed" && r.status === "upstream_timeout",
    );
    expect(timeoutSpan).toBeTruthy();
    expect(timeoutSpan?.errorClass).toBe("timeout");
    await proxy.stop();
    await upstream.close();
  });

  it("accepts the routing token in Authorization: Bearer (OpenAI-SDK shape)", async () => {
    // The OpenAI SDK does not send `x-api-key`; it sends `Authorization: Bearer <apiKey>`.
    // The proxy must extract the routing token from either header so both
    // container-side SDKs (Anthropic + OpenAI-compat) work without per-SDK plumbing.
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    }));
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "lm-real" } });
    const proxy = new LocalModelProxy({
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: { anthropic: adapter as any, "lm-studio": adapter, ollama: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "lm-studio",
      model: "x",
    });

    const resp = await postToProxy(
      port,
      "/v1/chat/completions",
      { authorization: `Bearer ${tok}` },
      "{}",
    );

    expect(resp.status).toBe(200);
    const firstReq = upstream.recorded[0];
    if (!firstReq) throw new Error("expected recorded upstream request");
    expect(firstReq.headers.authorization).toBe("Bearer lm-real");
    expect(firstReq.headers["x-api-key"]).toBeUndefined();
    await proxy.stop();
    await upstream.close();
  });

  it("rejects oversized request bodies with 413 + payload_too_large span", async () => {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: "{}" }));
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "lm-real" } });
    const proxy = new LocalModelProxy({
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: { anthropic: adapter as any, "lm-studio": adapter, ollama: adapter },
      logger,
      maxBodyBytes: 128, // tiny cap so we don't have to allocate megabytes
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "lm-studio",
      model: "x",
    });

    const oversized = "x".repeat(1024); // 1 KiB body, cap is 128 B
    const resp = await postToProxy(
      port,
      "/v1/chat/completions",
      { authorization: `Bearer ${tok}` },
      oversized,
    );

    expect(resp.status).toBe(413);
    const span = logger.entries.find(
      (e) => e.event === "model.call.rejected" && e.errorClass === "payload_too_large",
    );
    expect(span).toBeDefined();
    expect(upstream.recorded.length).toBe(0); // never forwarded
    await proxy.stop();
    await upstream.close();
  });

  it("post-body client abort still yields a terminal span under Bun", async () => {
    // Under Bun's Node-compat layer, aborting the client socket after the
    // full request body is sent is not surfaced back to the server as an
    // observable disconnect. The proxy therefore completes the upstream
    // request and emits its normal terminal span rather than a distinct
    // client_disconnected status.
    const upstream = await startFakeUpstream(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { status: 200, body: "{}" };
    });
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "lm-studio", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "lm-real" } });
    const proxy = new LocalModelProxy({
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapters: { anthropic: adapter as any, "lm-studio": adapter, ollama: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "lm-studio",
      model: "x",
    });

    // Fire a request, then destroy it before the upstream returns.
    const body = "{}";
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: { "content-length": Buffer.byteLength(body), authorization: `Bearer ${tok}` },
        },
        () => finish(),
      );
      req.on("error", finish);
      req.on("close", finish);
      req.on("socket", (socket) => {
        setTimeout(() => socket.destroy(new Error("test_abort")), 100);
      });
      req.write(body);
      req.end();
    });

    // Let the upstream complete so the proxy emits its terminal span.
    await new Promise((r) => setTimeout(r, 200));
    const terminalSpan = logger.entries.find(
      (e) => e.event === "model.call.completed" && e.provider === "lm-studio",
    );
    expect(terminalSpan).toBeDefined();
    expect(terminalSpan).toMatchObject({
      provider: "lm-studio",
      status: "ok",
      httpStatus: 200,
    });

    await proxy.stop();
    await upstream.close();
  });
});
