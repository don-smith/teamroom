import { describe, it, expect, beforeEach } from "bun:test";
import { Agent, createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { LocalModelProxy } from "./local-model-proxy.js";
import { TokenRegistry } from "./token-registry.js";
import { OpenAICompatAdapter } from "./adapters/openai-compat-adapter.js";
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
  agent?: Agent,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        agent,
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
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

  it("substitutes x-api-key with real key and forwards to OpenRouter", async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({ id: "x", usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    }));
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "openrouter", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "sk-real" } });
    const proxy = new LocalModelProxy({
      registry,
      adapters: { openrouter: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });

    const resp = await postToProxy(port, "/v1/chat/completions", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    const firstReq = upstream.recorded[0];
    if (!firstReq) throw new Error("expected recorded upstream request");
    // OpenAICompatAdapter strips x-api-key and uses Authorization: Bearer
    expect(firstReq.headers["authorization"]).toBe("Bearer sk-real");

    const span = logger.entries.find((r) => r.event === "model.call.completed");
    expect(span).toMatchObject({
      provider: "openrouter",
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
    const adapter = new OpenAICompatAdapter({ id: "openrouter", upstreamUrl: "http://unused", auth: { mode: "bearer", key: "_" } });
    const proxy = new LocalModelProxy({
      registry,
      adapters: { openrouter: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const resp = await postToProxy(port, "/v1/chat/completions", { "x-api-key": "ghost-token" }, "{}");
    expect(resp.status).toBe(401);
    const span = logger.entries.find((r) => r.event === "model.call.rejected");
    expect(span).toMatchObject({ errorClass: "unknown_token" });
    expect(span?.tokenPrefix).toBe("ghost-to");
    await proxy.stop();
  });

  it("accepts the routing token in Authorization: Bearer (OpenAI-SDK shape)", async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    }));
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "openrouter", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "sk-real" } });
    const proxy = new LocalModelProxy({
      registry,
      adapters: { openrouter: adapter },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });

    const resp = await postToProxy(port, "/v1/chat/completions", { authorization: `Bearer ${tok}` }, "{}");
    expect(resp.status).toBe(200);
    // OpenAICompatAdapter forwards Authorization: Bearer with the real key
    expect(upstream.recorded[0]?.headers["authorization"]).toBe("Bearer sk-real");
    await proxy.stop();
    await upstream.close();
  });

  it("upstream 504 timeout produces a timed-out model.call.completed span", async () => {
    const upstream = await startFakeUpstream(() => {
      return new Promise((_resolve) => {
        // never resolve — simulates upstream timeout
      });
    });
    const registry = new TokenRegistry();
    const adapter = new OpenAICompatAdapter({ id: "openrouter", upstreamUrl: upstream.url, auth: { mode: "bearer", key: "_" } });
    const proxy = new LocalModelProxy({
      registry,
      adapters: { openrouter: adapter },
      logger,
      upstreamTimeoutMs: 50,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "openrouter",
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

  it("route to correct adapter by provider from the minted token", async () => {
    const openrouterUpstream = await startFakeUpstream(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: "or" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    }));
    const registry = new TokenRegistry();
    // Use the same adapter for both, but verify the routing picks the openrouter provider
    const orAdapter = new OpenAICompatAdapter({ id: "openrouter", upstreamUrl: openrouterUpstream.url, auth: { mode: "bearer", key: "or-key" } });
    const proxy = new LocalModelProxy({
      registry,
      adapters: { openrouter: orAdapter },
      logger,
    });
    const { port } = await proxy.start();
    const tok = registry.mint({
      agentId: "a",
      turnId: "t",
      traceId: "tr",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
    const resp = await postToProxy(port, "/v1/chat/completions", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    // OpenAICompatAdapter forwards Authorization: Bearer with the real key
    expect(openrouterUpstream.recorded[0]?.headers["authorization"]).toBe("Bearer or-key");
    await proxy.stop();
    await openrouterUpstream.close();
  });
});