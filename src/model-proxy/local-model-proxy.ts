import {
  createServer,
  type ClientRequest,
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
import { newSpanId, buildSpan, type SpanLog } from "./span.js";
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
  /**
   * Wall-clock timeout for the outbound upstream request, in milliseconds.
   * Default 60_000. This is enforced explicitly rather than via
   * `ClientRequest.setTimeout` so the behavior stays consistent under Bun's
   * Node-compat layer too.
   */
  upstreamTimeoutMs?: number;
  host?: string; // default "127.0.0.1"
  /**
   * Reject incoming request bodies larger than this many bytes. Default 10 MB
   * — leaves plenty of room for Anthropic calls with large system prompts,
   * tool schemas, and conversation history, while bounding the memory one
   * misbehaving client can consume. Rejected calls return 413 and emit a
   * `model.call.rejected` span with `errorClass:"payload_too_large"`.
   */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Emit a span-shaped log entry. The event name is also passed as the log msg
 * so consumers can locate spans by either `entry.msg` or `entry.event` — both
 * carry the same canonical value (e.g. "model.call.completed").
 */
function emit(
  logger: Logger,
  level: "debug" | "info" | "warn" | "error",
  span: SpanLog,
): void {
  logger[level](span.event, span);
}

/**
 * Per-request mutable state shared between `handle()` and `forward()`. Lets the
 * `req.on("close")` listener signal client-disconnect into the forward path
 * (which may still be mid-upstream-call), and lets `forward()` register the
 * in-flight upstream ClientRequest so the listener can destroy it cleanly.
 */
interface RequestState {
  clientGone: boolean;
  upstreamReq: ClientRequest | null;
  upstreamAbortReason: "client_disconnected" | "upstream_timeout" | null;
}

/**
 * Write a response if and only if we haven't already finalised one for this
 * request. Double-respond protection: after a client-disconnect mid-flight or
 * after any earlier writeHead/end, further writes would throw or be silently
 * dropped. Making the check explicit keeps error paths safe.
 */
function safeRespond(res: ServerResponse, status: number, body: string): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(body);
}

function clientResponseGone(res: ServerResponse, state: RequestState): boolean {
  return state.clientGone
    || (res as ServerResponse & { destroyed?: boolean }).destroyed === true
    || res.socket?.destroyed === true;
}

export class LocalModelProxy implements ModelProxy {
  private readonly opts: Required<Pick<Opts, "upstreamTimeoutMs" | "host" | "maxBodyBytes">> &
    Omit<Opts, "upstreamTimeoutMs" | "host" | "maxBodyBytes">;
  private server: Server | null = null;
  private port: number | null = null;

  constructor(opts: Opts) {
    this.opts = {
      ...opts,
      upstreamTimeoutMs: opts.upstreamTimeoutMs ?? 60_000,
      host: opts.host ?? "127.0.0.1",
      maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
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
        emit(this.opts.logger, "error", buildSpan({
          event: "model.call.completed",
          traceId: newSpanId(),
          spanId: newSpanId(),
          extra: {
            status: "upstream_error",
            errorClass: "internal_error",
            message: err instanceof Error ? err.message : String(err),
          },
        }));
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

    // Track client-disconnect so `forward()` can branch to a
    // `client_disconnected` span instead of trying to write a response to a
    // socket that's already gone. We listen on `res.on("close")` rather than
    // `req.on("close")` because the request's close event fires on *normal*
    // body-end too (once the request stream is fully consumed), which would
    // misfire on every happy path. The response's close event only fires
    // when the connection terminates; `writableFinished` distinguishes
    // "fully flushed to socket" (normal) from "client gave up" (abort).
    const state: RequestState = {
      clientGone: false,
      upstreamReq: null,
      upstreamAbortReason: null,
    };
    const handleClientGone = () => {
      if (res.writableFinished) return;
      state.clientGone = true;
      // Abort the in-flight upstream call, if any — no point finishing a
      // request whose response will be discarded.
      if (state.upstreamReq) {
        state.upstreamAbortReason = "client_disconnected";
        state.upstreamReq.destroy(new Error("client_disconnected"));
      }
    };
    res.on("close", handleClientGone);
    req.on("aborted", handleClientGone);
    req.on("close", () => {
      if (req.aborted) handleClientGone();
    });
    req.socket.on("close", handleClientGone);

    // The Anthropic SDK sends the routing token as `x-api-key`; the OpenAI SDK
    // sends it as `Authorization: Bearer <token>`. Accept either so both
    // container-side SDKs work without per-SDK proxy plumbing.
    const apiKeyHeader = req.headers["x-api-key"];
    const apiKeyValue = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    let token: string | undefined = apiKeyValue;
    if (!token) {
      const authHeader = req.headers.authorization;
      const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (authValue && authValue.startsWith("Bearer ")) {
        token = authValue.slice("Bearer ".length).trim() || undefined;
      }
    }

    if (!token) {
      // Downgraded to debug: the Claude Code CLI (spawned by
      // claude-agent-sdk) makes an unauthenticated probe on startup that
      // lands here. It's harmless — the real LLM call that follows carries
      // our routing token — but at warn level it grabs attention every
      // time an agent session spawns.
      emit(this.opts.logger, "debug", buildSpan({
        event: "model.call.rejected",
        traceId,
        spanId,
        extra: { errorClass: "missing_token", status: "rejected" },
      }));
      safeRespond(res, 401, JSON.stringify({ error: "missing routing token" }));
      return;
    }

    const entry = this.opts.registry.lookup(token);
    if (!entry) {
      emit(this.opts.logger, "warn", buildSpan({
        event: "model.call.rejected",
        traceId,
        spanId,
        extra: {
          errorClass: "unknown_token",
          status: "rejected",
          tokenPrefix: token.slice(0, 8),
        },
      }));
      safeRespond(res, 401, JSON.stringify({ error: "unknown routing token" }));
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
      safeRespond(res, 500, JSON.stringify({ error: "no adapter for provider" }));
      return;
    }

    // Buffer the request body so we can replay on retry. Capped at
    // `maxBodyBytes` to bound per-request memory.
    let requestBody: Buffer;
    try {
      requestBody = await readBody(req, this.opts.maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        emit(this.opts.logger, "warn", buildSpan({
          event: "model.call.rejected",
          traceId: entry.traceId,
          spanId,
          agentId: entry.agentId,
          turnId: entry.turnId,
          extra: {
            provider: entry.provider,
            status: "rejected",
            errorClass: "payload_too_large",
            maxBodyBytes: this.opts.maxBodyBytes,
          },
        }));
        safeRespond(res, 413, JSON.stringify({ error: "payload too large" }));
        return;
      }
      throw err;
    }

    await this.forward({
      req,
      res,
      requestBody,
      entry,
      adapter,
      spanId,
      startedAt,
      retried: false,
      state,
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
    state: RequestState;
  }): Promise<void> {
    const { req, res, requestBody, entry, adapter, spanId, startedAt, retried, state } = args;

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
        event: "model.call.rejected",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: {
          provider: entry.provider,
          status: "rejected",
          errorClass: "auth_error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
      // 502 Bad Gateway: resolveAuth() failure means we couldn't reach (or
      // couldn't satisfy) an upstream auth dependency (e.g., the OAuth
      // exchange endpoint). 500 misattributed the fault to the proxy itself.
      safeRespond(res, 502, JSON.stringify({ error: "auth resolution failed" }));
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
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        state.upstreamReq = null;
        fn();
      };
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
            settle(() => {
              resolve({
                status: upstreamRes.statusCode ?? 0,
                headers: upstreamRes.headers,
                body: Buffer.concat(chunks),
              });
            });
          });
          upstreamRes.on("error", (err) => settle(() => reject(err)));
        },
      );
      // Share the upstream request so the `req.on("close")` listener can
      // destroy it if the client disconnects mid-flight.
      state.upstreamReq = upstreamReq;
      timeoutId = setTimeout(() => {
        state.upstreamAbortReason = "upstream_timeout";
        upstreamReq.destroy(new Error("upstream_timeout"));
      }, this.opts.upstreamTimeoutMs);
      upstreamReq.on("error", (err) => settle(() => reject(err)));
      upstreamReq.on("close", () => {
        if (!state.upstreamAbortReason) return;
        const reason = state.upstreamAbortReason;
        state.upstreamAbortReason = null;
        settle(() => reject(new Error(reason)));
      });
      upstreamReq.write(requestBody);
      upstreamReq.end();
    });

    let upstreamResp: { status: number; headers: IncomingMessage["headers"]; body: Buffer };
    try {
      upstreamResp = await upstreamPromise;
    } catch (err) {
      // If the error is a result of the client disconnecting, that's its own
      // terminal status — not an upstream error. The response is already
      // un-sendable, so just emit the span and return.
      if (clientResponseGone(res, state)) {
        emit(this.opts.logger, "warn", buildSpan({
          event: "model.call.completed",
          traceId: entry.traceId,
          spanId,
          agentId: entry.agentId,
          turnId: entry.turnId,
          extra: {
            provider: entry.provider,
            model: entry.model,
            status: "client_disconnected",
            latencyMs: Date.now() - startedAt,
          },
        }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === "upstream_timeout";
      const errCode =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      emit(this.opts.logger, "error", buildSpan({
        event: "model.call.completed",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: {
          provider: entry.provider,
          status: isTimeout ? "upstream_timeout" : "upstream_error",
          errorClass: isTimeout
            ? "timeout"
            : `${errCode || "network"}_${entry.provider}`,
          latencyMs: Date.now() - startedAt,
          message,
        },
      }));
      const status = isTimeout ? 504 : 502;
      safeRespond(res, status, JSON.stringify({ error: isTimeout ? "upstream_timeout" : "upstream_error" }));
      return;
    }

    // Upstream completed successfully but the client went away before we got
    // here (race: upstream resolved between req-close and now). Discard the
    // response, emit a client_disconnected span, do not write to the socket.
    if (clientResponseGone(res, state)) {
      emit(this.opts.logger, "warn", buildSpan({
        event: "model.call.completed",
        traceId: entry.traceId,
        spanId,
        agentId: entry.agentId,
        turnId: entry.turnId,
        extra: {
          provider: entry.provider,
          model: entry.model,
          status: "client_disconnected",
          httpStatus: upstreamResp.status,
          latencyMs: Date.now() - startedAt,
        },
      }));
      return;
    }

    // OAuth credential-refresh retry: exactly once on 401, OAuth mode only.
    // Per spec §5, the retry is reflected in the final `model.call.completed`
    // span's `retried: true` field rather than as a separate event.
    if (
      upstreamResp.status === 401 &&
      !retried &&
      adapter.authMode === "oauth" &&
      typeof adapter.onUpstreamUnauthorized === "function"
    ) {
      adapter.onUpstreamUnauthorized();
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
    const isOk = upstreamResp.status >= 200 && upstreamResp.status < 300;
    const status = isOk ? "ok" : "upstream_error";

    // Diagnostic: if we got a 2xx but no usage AND no recognizable response
    // shape, include a 200-char body preview so the operator can see what
    // upstream actually returned (e.g., LM Studio returning an `error` body
    // with status 200, or a model id mismatch). Cheaper than re-running with
    // tcpdump.
    const looksLikeError =
      isOk && usage.inputTokens === undefined && usage.outputTokens === undefined;
    const bodyPreview = looksLikeError
      ? upstreamResp.body.toString("utf8").slice(0, 200)
      : undefined;

    emit(this.opts.logger, isOk ? "info" : "error", buildSpan({
      event: "model.call.completed",
      traceId: entry.traceId,
      spanId,
      agentId: entry.agentId,
      turnId: entry.turnId,
      extra: {
        provider: entry.provider,
        model: entry.model,
        status,
        httpStatus: upstreamResp.status,
        ...(isOk ? {} : { errorClass: `${upstreamResp.status}_${entry.provider}` }),
        latencyMs: Date.now() - startedAt,
        ...(retried ? { retried: true } : {}),
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(bodyPreview !== undefined ? { bodyPreview } : {}),
      },
    }));

    // Pass response headers through, stripping hop-by-hop. `writableEnded` is
    // the double-respond guard — if the client's socket was finalised already
    // (e.g., by a concurrent error path or a late disconnect), do nothing.
    if (res.writableEnded) return;
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

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        // Stop buffering, but drain any remaining bytes so the client can
        // finish sending (and we can still return a 413 response on the
        // same connection). Calling req.destroy() here would sever the
        // socket before the response goes out — the client would see a
        // hang-up instead of the error.
        req.removeListener("data", onData);
        req.resume();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
