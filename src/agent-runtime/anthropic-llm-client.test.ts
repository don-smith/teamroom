import { describe, it, expect } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";

interface RecordedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeServerResponse {
  status: number;
  body: string;
}

interface FakeServer {
  url: string;
  close: () => Promise<void>;
  recorded: RecordedRequest[];
}

function startFake(handler: (req: RecordedRequest) => FakeServerResponse): Promise<FakeServer> {
  return new Promise<FakeServer>((resolve) => {
    const recorded: RecordedRequest[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const r: RecordedRequest = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        recorded.push(r);
        const out = handler(r);
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

describe("AnthropicLlmClient", () => {
  it("createMessage sends a chat request and returns the parsed text", async () => {
    const fake = await startFake(() => ({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{ type: "text", text: "hello back", citations: null }],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    }));
    const client = new AnthropicLlmClient({ baseURL: fake.url, apiKey: "routing-token" });
    const result = await client.createMessage({
      model: "claude-test",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello back");
    expect(fake.recorded[0]?.headers["x-api-key"]).toBe("routing-token");
    expect(fake.recorded[0]?.headers["anthropic-version"]).toBeTruthy();
    await fake.close();
  });

  it("createMessage surfaces upstream errors as exceptions", async () => {
    const fake = await startFake(() => ({
      status: 401,
      body: '{"error":{"type":"authentication_error","message":"bad"}}',
    }));
    const client = new AnthropicLlmClient({ baseURL: fake.url, apiKey: "tok" });
    await expect(
      client.createMessage({
        model: "claude-test",
        system: "",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow();
    await fake.close();
  });
});
