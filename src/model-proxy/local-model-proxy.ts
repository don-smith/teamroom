import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { Logger } from "../logger/logger.js";
import type { Provider } from "../types.js";
import type { ProviderAdapter } from "./adapters/adapter.js";
import { TokenRegistry, type TokenEntry } from "./token-registry.js";
import { newSpanId, buildSpan } from "./span.js";
import type { MintTokenInput, ModelProxy } from "./model-proxy.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface Opts {
  registry: TokenRegistry;
  adapters: Record<Provider, ProviderAdapter>;
  logger: Logger;
  upstreamTimeoutMs?: number; // default 60_000
  host?: string; // default "127.0.0.1"
}

/**
 * Emit a span-shaped log entry. The event name is also passed as the log msg
 * so consumers can locate spans by either `entry.msg` or `entry.event`.
 */
function emit(
  logger: Logger,
  level: "info" | "warn" | "error",
  span: Record<string, unknown>,
): void {
  const msg = String(span.event ?? "");
  logger[level](msg, span);
}

export class LocalModelProxy implements ModelProxy {
  private readonly opts: Required<Pick<Opts, "upstreamTimeoutMs" | "host">> &
    Omit<Opts, "upstreamTimeoutMs" | "host">;
  private server: Server | null = null;
  private port: number | null = null;

  constructor(opts: Opts) {
    this.opts = {
      ...opts,
      upstreamTimeoutMs: opts.upstreamTimeoutMs ?? 60_000,
      host: opts.host ?? "127.0.0.1",
    };
  }

  async start(): Promise<{ port: number }> {
    if (this.server) {
      throw new Error("LocalModelProxy.start: already started");
    }
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        // Catch-all: surface as 500 so the listener never crashes the process.
        try {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
          }
          res.end(JSON.stringify({ error: "internal_error" }));
        } catch {
          // ignore
        }
        emit(this.opts.logger, "error", {
          event: "model.call.errored",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, this.opts.host, () => resolve()));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return { port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    this.port = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  mint(input: MintTokenInput): string {
    return this.opts.registry.mint(input);
  }

  evict(token: string): void {
    this.opts.registry.evict(token);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const traceId = newSpanId(); // overridden once we resolve the token
    const spanId = newSpanId();
    const startedAt = Date.now();

    const tokenHeader = req.headers["x-api-key"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

    if (!token) {
      emit(this.opts.logger, "warn", buildSpan({
        event: "model.call.rejected",
        traceId,
        spanId,
        extra: { errorClass: "missing_token", status: "rejected" },
      }));
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing routing token" }));
      return;
    }

    const entry = this.opts.registry.lookup(token);
    if (!entry) {
      emit(this.opts.logger, "warn", buildSpan({
        event: "model.call.rejected",
        traceId,
        spanId,
        extra: { errorClass: "unknown_token", status: "rejected" },
      }));
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown routing token" }));
      return;
    }

    const adapter = this.opts.adapters[entry.provider];
    if (!adapter) {
      emit(this.opts.logger, "error", buildSpan({
        event: "model.call.rejected",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: { errorClass: "no_adapter", provider: entry.provider, status: "rejected" },
      }));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no adapter for provider" }));
      return;
    }

    // Buffer the request body so we can replay on retry.
    const requestBody = await readBody(req);

    await this.forward({
      req,
      res,
      requestBody,
      entry,
      adapter,
      spanId,
      startedAt,
      retried: false,
    });
  }

  private async forward(args: {
    req: IncomingMessage;
    res: ServerResponse;
    requestBody: Buffer;
    entry: TokenEntry;
    adapter: ProviderAdapter;
    spanId: string;
    startedAt: number;
    retried: boolean;
  }): Promise<void> {
    const { req, res, requestBody, entry, adapter, spanId, startedAt, retried } = args;

    const upstreamUrl = new URL(adapter.upstreamUrl());
    // Build outgoing headers: copy through except hop-by-hop and host.
    const outHeaders: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === "host") continue;
      if (value === undefined) continue;
      outHeaders[name] = value;
    }
    outHeaders.host = upstreamUrl.host;
    outHeaders["content-length"] = String(requestBody.length);

    try {
      await adapter.resolveAuth(outHeaders);
    } catch (err) {
      emit(this.opts.logger, "error", buildSpan({
        event: "model.call.errored",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: {
          provider: entry.provider,
          status: "auth_error",
          errorClass: "auth_error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "auth resolution failed" }));
      return;
    }

    // Append the original request path/search onto upstream's pathname, since
    // adapter.upstreamUrl() typically returns just the host (no path).
    const upstreamPath = (upstreamUrl.pathname.replace(/\/$/, "") + (req.url ?? "")) || "/";

    const reqFn = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;

    const upstreamPromise = new Promise<{
      status: number;
      headers: IncomingMessage["headers"];
      body: Buffer;
    }>((resolve, reject) => {
      const upstreamReq = reqFn(
        {
          protocol: upstreamUrl.protocol,
          host: upstreamUrl.hostname,
          port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
          path: upstreamPath,
          method: req.method ?? "POST",
          headers: outHeaders,
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (c) => chunks.push(c));
          upstreamRes.on("end", () => {
            resolve({
              status: upstreamRes.statusCode ?? 0,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
            });
          });
          upstreamRes.on("error", reject);
        },
      );
      upstreamReq.setTimeout(this.opts.upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error("upstream_timeout"));
      });
      upstreamReq.on("error", reject);
      upstreamReq.write(requestBody);
      upstreamReq.end();
    });

    let upstreamResp: { status: number; headers: IncomingMessage["headers"]; body: Buffer };
    try {
      upstreamResp = await upstreamPromise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === "upstream_timeout";
      emit(this.opts.logger, "error", buildSpan({
        event: "model.call.errored",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: {
          provider: entry.provider,
          status: isTimeout ? "upstream_timeout" : "upstream_error",
          errorClass: isTimeout ? "upstream_timeout" : "upstream_error",
          latencyMs: Date.now() - startedAt,
          message,
        },
      }));
      const status = isTimeout ? 504 : 502;
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: isTimeout ? "upstream_timeout" : "upstream_error" }));
      return;
    }

    // OAuth credential-refresh retry: exactly once on 401, OAuth mode only.
    if (
      upstreamResp.status === 401 &&
      !retried &&
      adapter.authMode === "oauth" &&
      typeof adapter.onUpstreamUnauthorized === "function"
    ) {
      adapter.onUpstreamUnauthorized();
      emit(this.opts.logger, "info", buildSpan({
        event: "model.call.retry",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: { provider: entry.provider, reason: "credential_refresh" },
      }));
      await this.forward({ ...args, retried: true });
      return;
    }

    // Parse body for usage extraction (defensive — body may not be JSON).
    let parsedBody: unknown;
    try {
      parsedBody = upstreamResp.body.length ? JSON.parse(upstreamResp.body.toString("utf8")) : undefined;
    } catch {
      parsedBody = undefined;
    }
    const usage = adapter.extractUsage(parsedBody);
    const status = upstreamResp.status >= 200 && upstreamResp.status < 300 ? "ok" : "upstream_error";
    const event = status === "ok" ? "model.call.completed" : "model.call.errored";

    emit(this.opts.logger, status === "ok" ? "info" : "error", buildSpan({
      event,
      traceId: entry.traceId,
      spanId,
      agentId: entry.agentId,
      turnId: entry.turnId,
      extra: {
        provider: entry.provider,
        model: entry.model,
        status,
        upstreamStatus: upstreamResp.status,
        latencyMs: Date.now() - startedAt,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      },
    }));

    // Pass response headers through, stripping hop-by-hop.
    const responseHeaders: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(upstreamResp.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (value === undefined) continue;
      responseHeaders[name] = value;
    }
    res.writeHead(upstreamResp.status, responseHeaders);
    res.end(upstreamResp.body);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
