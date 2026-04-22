import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { MailMcpTools } from "./tools.js";
import type { Logger } from "../logger/logger.js";

/**
 * MCP server for the teamroom mail system, implemented on top of the
 * @modelcontextprotocol/sdk McpServer + StreamableHTTPServerTransport.
 *
 * Every request to POST /mcp:
 *   1. `x-teamroom-mcp-token: <token>` header resolved to callerAgentId (401 on failure).
 *   2. A fresh McpServer + StreamableHTTPServerTransport is created per HTTP request.
 *      This is the SDK's "stateless per-request" pattern — each HTTP POST is independent,
 *      which matches our token-per-spawn model where each request already carries identity.
 *   3. Tool calls are dispatched via the shared MailMcpTools instance with the resolved
 *      agentId in the ToolContext.
 *
 * The server binds to 127.0.0.1 by default; containers reach it via host.docker.internal.
 */

const MAIL_TOOL_DESCRIPTORS = [
  {
    name: "mail.list",
    description:
      "List your inbox. Filter by unreadOnly, threadId, includeArchived, and limit.",
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
      "Send a new mail. `to` and `cc` accept `agent:<name>`, `channel:cli:<user>`, or `list:<name>` addresses.",
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

export interface MailMcpServerDeps {
  tools: MailMcpTools;
  /** Resolve an MCP token to an agent id. Return null if the token is invalid. */
  tokenResolver: (token: string) => string | null;
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
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }

    // Validate the bearer token before handing off to the SDK transport.
    const token = (req.headers["x-teamroom-mcp-token"] ?? "") as string;
    const agentId = this.deps.tokenResolver(token);
    if (!agentId) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Per-request McpServer + Transport (SDK stateless pattern).
    // The SDK's StreamableHTTPServerTransport requires a fresh instance per
    // HTTP request in stateless mode — it tracks state per-request internally
    // and cannot be reused across requests.
    const mcp = this.buildMcp(agentId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);

    // Attach auth to the request so the transport propagates it to tool
    // handlers via extra.authInfo. clientId carries the resolved agentId.
    (req as IncomingMessage & { auth: AuthInfo }).auth = {
      token,
      clientId: agentId,
      scopes: [],
    };

    try {
      await transport.handleRequest(req, res);
    } finally {
      // Clean up the per-request McpServer/Transport. Errors in cleanup are
      // non-fatal — the response has already been sent.
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }

  /**
   * Build a per-request McpServer with all tool handlers registered.
   * Called once per MCP HTTP POST, immediately before connecting to a fresh transport.
   */
  private buildMcp(agentId: string): McpServer {
    const mcp = new McpServer({ name: "teamroom-mail", version: "0.1.0" });
    const tools = this.deps.tools;
    const ctx = { callerAgentId: agentId };

    // Register capabilities and install handlers on the low-level server so
    // we can access raw request.params.arguments without Zod schemas.
    mcp.server.registerCapabilities({ tools: {} });

    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: MAIL_TOOL_DESCRIPTORS,
    }));

    mcp.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const name = request.params.name;

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
          throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
      }
    });

    return mcp;
  }
}

/**
 * Wrap a tool result value in the MCP content envelope.
 * Text content carries the full JSON; structuredContent mirrors it for
 * clients that support it (only for plain-object payloads — arrays require
 * a Record wrapper per the MCP spec).
 */
function jsonResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  const text = JSON.stringify(value);
  const isPlainObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const result: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text", text }] };
  if (isPlainObject) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

function okResult(): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: "ok" }] };
}
