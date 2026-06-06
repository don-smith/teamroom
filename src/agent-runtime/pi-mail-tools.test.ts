import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "bun:test";
import { buildPiMailTools } from "./pi-mail-tools.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("buildPiMailTools", () => {
  it("calls the Team Room MCP endpoint with token and mapped tool name", async () => {
    const seen: Array<{ token: string | undefined; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      seen.push({
        token: req.headers["x-teamroom-mcp-token"] as string | undefined,
        body: await readJson(req),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const tools = buildPiMailTools({ mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: "mcp-token" });
      const list = tools.find((t) => t.name === "mail_list");
      expect(list).toBeDefined();
      const result = await list!.execute(
        "call-1",
        { unreadOnly: true },
        new AbortController().signal,
        () => undefined,
        {} as never,
      );
      expect(result.content[0]).toMatchObject({ type: "text", text: JSON.stringify({ ok: true }) });
      expect(seen[0]?.token).toBe("mcp-token");
      expect(seen[0]?.body).toMatchObject({
        method: "tools/call",
        params: { name: "mail.list", arguments: { unreadOnly: true } },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
