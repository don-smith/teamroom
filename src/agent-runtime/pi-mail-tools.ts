import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface BuildPiMailToolsArgs {
  mcpUrl: string;
  mcpToken: string;
}

type JsonObject = Record<string, unknown>;

interface McpContentItem {
  type: string;
  text?: string;
}

interface McpResponse {
  result?: { content?: McpContentItem[] };
  error?: { message?: string };
}

async function callMcp(args: {
  mcpUrl: string;
  mcpToken: string;
  name: string;
  input: unknown;
  signal: AbortSignal | undefined;
}): Promise<AgentToolResult<McpResponse>> {
  const res = await fetch(args.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teamroom-mcp-token": args.mcpToken,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: args.name, arguments: args.input },
    }),
    signal: args.signal,
  });
  if (!res.ok) throw new Error(`mail MCP ${args.name} failed: HTTP ${res.status}`);
  const payload = await res.json() as McpResponse;
  if (payload.error) throw new Error(payload.error.message ?? `mail MCP ${args.name} failed`);
  const text = payload.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { content: [{ type: "text", text }], details: payload };
}

function tool(
  args: BuildPiMailToolsArgs & {
    name: string;
    mcpName: string;
    label: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  },
): ToolDefinition {
  return {
    name: args.name,
    label: args.label,
    description: args.description,
    parameters: args.parameters,
    execute: (_toolCallId, params, signal) =>
      callMcp({
        mcpUrl: args.mcpUrl,
        mcpToken: args.mcpToken,
        name: args.mcpName,
        input: params as JsonObject,
        signal,
      }),
  };
}

export function buildPiMailTools(args: BuildPiMailToolsArgs): ToolDefinition[] {
  return [
    tool({
      ...args,
      name: "mail_list",
      mcpName: "mail.list",
      label: "List mail",
      description: "List your Team Room inbox. Filter by unreadOnly, threadId, includeArchived, and limit.",
      parameters: Type.Object({
        unreadOnly: Type.Optional(Type.Boolean()),
        threadId: Type.Optional(Type.String()),
        includeArchived: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_get",
      mcpName: "mail.get",
      label: "Get mail",
      description: "Get a single Team Room mail by id from your inbox.",
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_send",
      mcpName: "mail.send",
      label: "Send mail",
      description: "Send a new Team Room mail. Addresses are agent:<name>, channel:cli:<user>, or list:<name>.",
      parameters: Type.Object({
        to: Type.Array(Type.String()),
        cc: Type.Optional(Type.Array(Type.String())),
        subject: Type.Optional(Type.String()),
        body: Type.String(),
        threadId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_reply",
      mcpName: "mail.reply",
      label: "Reply to mail",
      description: "Reply to a Team Room mail in your inbox. Inherits threadId; ccAll=true keeps the group on the reply.",
      parameters: Type.Object({
        id: Type.String(),
        body: Type.String(),
        ccAll: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_mark_read",
      mcpName: "mail.mark_read",
      label: "Mark mail read",
      description: "Mark a Team Room mail as read.",
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_archive",
      mcpName: "mail.archive",
      label: "Archive mail",
      description: "Archive a Team Room mail. It remains queryable with includeArchived.",
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    }),
    tool({
      ...args,
      name: "mail_delete",
      mcpName: "mail.delete",
      label: "Delete mail",
      description: "Soft-delete a Team Room mail so it is hidden from inbox listings.",
      parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    }),
  ];
}
