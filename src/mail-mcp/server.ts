import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MailMcpTools } from "./tools.js";
import type { CliChannelAdapter } from "../channels/cli.js";
import type { Logger } from "../logger/logger.js";

/**
 * Hand-rolled minimal MCP JSON-RPC 2.0 HTTP server.
 *
 * The client we care about is the claude-agent-sdk running inside an agent
 * container: it performs the standard MCP handshake (`initialize` →
 * `notifications/initialized`) then calls `tools/list` + `tools/call`. We
 * don't need SSE streaming, resources, or prompts for M4, so we keep the
 * protocol surface tight and hand-roll instead of pulling in the full MCP
 * SDK server + StreamableHTTPServerTransport machinery (which couples
 * per-request scope with per-session state in ways that don't fit our
 * token-per-spawn model).
 *
 * Every request:
 *   1. POST /mcp only.
 *   2. `x-teamroom-mcp-token: <token>` header (resolves to the caller's
 *       agentId via the injected resolver; 401 otherwise).
 *   3. Body is either a JSON-RPC request, notification, or a batch.
 *   4. Tool calls are dispatched via the shared MailMcpTools instance with
 *      the resolved agentId in the ToolContext.
 *
 * The server binds to 127.0.0.1 by default; containers reach it via
 * host.docker.internal.
 */

const MCP_PROTOCOL_VERSION = "2025-03-26";

export const MAIL_TOOL_DESCRIPTORS = [
  {
    name: "mail.list",
    description:
      "List your inbox. Filter by unread_only, threadId, includeArchived, and limit.",
    inputSchema: {
      type: "object",
      properties: {
        unreadOnly: { type: "boolean" },
        threadId: { type: "string" },
        includeArchived: { type: "boolean" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mail.get",
    description: "Get a single mail by id from your inbox.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "mail.send",
    description:
      "Send a new mail. `to` and `cc` accept `agent:<name>`, `cli:<user>`, or `list:<name>` addresses.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["to", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "mail.reply",
    description:
      "Reply to a mail in your inbox. Inherits thread_id; `ccAll=true` keeps the whole group on the reply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        ccAll: { type: "boolean" },
      },
      required: ["id", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "mail.mark_read",
    description: "Mark a mail as read.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "mail.archive",
    description: "Archive a mail (still queryable with includeArchived).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "mail.delete",
    description: "Soft-delete a mail (hidden from listInbox).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: JsonValue;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: JsonValue;
  error?: JsonRpcError;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface MailMcpServerDeps {
  tools: MailMcpTools;
  /** Resolve an MCP token to an agent id. Return null if the token is invalid. */
  tokenResolver: (token: string) => string | null;
  /**
   * Optional CLI-channel adapter. When present, a sibling `POST /cli/send`
   * endpoint is exposed — the `teamroom send` CLI posts to it instead of
   * writing directly to the DB, so the dispatcher fires the mail.delivered
   * bus event and the session manager wakes the target agent.
   */
  cliAdapter?: CliChannelAdapter;
  /** Port to bind; 0 for an ephemeral port (tests). */
  port: number;
  /** Bind host; defaults to 127.0.0.1 for local-only trust. */
  host?: string;
  logger?: Logger;
}

export class MailMcpServer {
  private httpServer?: Server;
  constructor(private readonly deps: MailMcpServerDeps) {}

  async start(): Promise<void> {
    const host = this.deps.host ?? "127.0.0.1";
    this.httpServer = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.deps.logger?.error("mail-mcp.unhandled", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    await new Promise<void>((ok, fail) => {
      const server = this.httpServer!;
      server.once("error", fail);
      server.listen(this.deps.port, host, () => {
        server.removeListener("error", fail);
        ok();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((ok) => {
      this.httpServer!.close(() => ok());
    });
    this.httpServer = undefined;
  }

  address(): { port: number; host: string } {
    const addr = this.httpServer?.address();
    if (!addr || typeof addr === "string") {
      throw new Error("mail-mcp.address: not listening");
    }
    return { port: addr.port, host: addr.address };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "POST" && req.url === "/cli/send" && this.deps.cliAdapter) {
      await this.handleCliSend(req, res, this.deps.cliAdapter);
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const token = (req.headers["x-teamroom-mcp-token"] ?? "") as string;
    const agentId = this.deps.tokenResolver(token);
    if (!agentId) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = body.length === 0 ? null : JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses: JsonRpcResponse[] = [];
    for (const msg of messages) {
      const response = this.dispatch(agentId, msg as JsonRpcRequest);
      if (response) responses.push(response);
    }

    res.setHeader("content-type", "application/json");
    if (responses.length === 0) {
      // All messages were notifications — MCP allows 202 Accepted with empty body.
      res.statusCode = 202;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
  }

  private async handleCliSend(
    req: IncomingMessage,
    res: ServerResponse,
    cliAdapter: CliChannelAdapter,
  ): Promise<void> {
    // Trust boundary: the daemon-owned local HTTP socket. We bind to
    // 127.0.0.1 by default and also cross-check the peer address here so
    // a misconfigured bind doesn't accidentally expose /cli/send.
    const remote = req.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "localhost only" }));
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const p = (parsed ?? {}) as {
      user?: unknown;
      target?: unknown;
      body?: unknown;
      threadId?: unknown;
    };
    if (typeof p.user !== "string" || typeof p.target !== "string" || typeof p.body !== "string") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "expected {user, target, body}" }));
      return;
    }
    try {
      const result = cliAdapter.send({
        user: p.user,
        target: p.target,
        body: p.body,
        threadId: typeof p.threadId === "string" ? p.threadId : null,
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  /**
   * Returns a response object for requests (has `id`); returns null for
   * notifications (`id` absent/null).
   */
  private dispatch(agentId: string, rpc: JsonRpcRequest): JsonRpcResponse | null {
    const isNotification = rpc.id === undefined || rpc.id === null;
    const id = isNotification ? null : (rpc.id ?? null);

    try {
      const result = this.call(agentId, rpc.method, rpc.params);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id, result: result as JsonValue };
    } catch (err) {
      if (isNotification) return null;
      const isInvalidParams = err instanceof InvalidParamsError;
      const isUnknown = err instanceof MethodNotFoundError;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: isUnknown ? METHOD_NOT_FOUND : isInvalidParams ? INVALID_PARAMS : INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private call(agentId: string, method: string, params: JsonValue | undefined): unknown {
    if (method === "initialize") {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "teamroom-mail", version: "0.1.0" },
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // MCP notification — no result. Caller handles null-returning.
      return null;
    }
    if (method === "ping") {
      return {};
    }
    if (method === "tools/list") {
      return { tools: MAIL_TOOL_DESCRIPTORS };
    }
    if (method === "tools/call") {
      const p = asObject(params);
      const name = p.name;
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") throw new InvalidParamsError("missing tool name");
      const ctx = { callerAgentId: agentId };
      const tools = this.deps.tools;
      switch (name) {
        case "mail.list":
          return jsonResult(tools.list(ctx, args as Parameters<typeof tools.list>[1]));
        case "mail.get":
          return jsonResult(tools.get(ctx, args as Parameters<typeof tools.get>[1]));
        case "mail.send":
          return jsonResult(tools.send(ctx, args as Parameters<typeof tools.send>[1]));
        case "mail.reply":
          return jsonResult(tools.reply(ctx, args as Parameters<typeof tools.reply>[1]));
        case "mail.mark_read":
          tools.markRead(ctx, args as Parameters<typeof tools.markRead>[1]);
          return okResult();
        case "mail.archive":
          tools.archive(ctx, args as Parameters<typeof tools.archive>[1]);
          return okResult();
        case "mail.delete":
          tools.delete(ctx, args as Parameters<typeof tools.delete>[1]);
          return okResult();
        default:
          throw new MethodNotFoundError(`unknown tool: ${name}`);
      }
    }
    throw new MethodNotFoundError(`unknown method: ${method}`);
  }
}

class InvalidParamsError extends Error {}
class MethodNotFoundError extends Error {}

function asObject(v: JsonValue | undefined): Record<string, JsonValue> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new InvalidParamsError("params must be an object");
  }
  return v as Record<string, JsonValue>;
}

function jsonResult(value: unknown): JsonValue {
  // MCP tool results use a `content` array whose entries are text/image/
  // resource — `{type:"json"}` is not a spec content type (Claude Code
  // rejects the response with a schema error if we try). Stringify into a
  // text block.
  //
  // `structuredContent` is spec-optional AND its schema requires a
  // Record<string, unknown> — an object, not an array. mail.list returns
  // an array, so we wrap anything non-object into { result: ... } before
  // exposing it as structuredContent, or skip the field entirely for
  // non-object payloads. Clients that only look at `content[0].text`
  // still get the full JSON either way.
  const json = value as JsonValue;
  const isPlainObject =
    json !== null && typeof json === "object" && !Array.isArray(json);
  const result: Record<string, JsonValue> = {
    content: [{ type: "text", text: JSON.stringify(json) }],
  };
  if (isPlainObject) {
    result.structuredContent = json as JsonValue;
  }
  return result as JsonValue;
}

function okResult(): JsonValue {
  return { content: [{ type: "text", text: "ok" }] };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}
