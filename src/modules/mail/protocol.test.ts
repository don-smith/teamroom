import { describe, expect, it } from "bun:test";
import { parseClientMessage, type ClientMessage, type ServerMessage } from "./protocol.js";

describe("mail WebSocket protocol", () => {
  it("parses inbox query", () => {
    const msg: Extract<ClientMessage, { query: "inbox" }> = {
      type: "query",
      id: "q1",
      query: "inbox",
      params: { agent: "alice" },
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("parses thread query", () => {
    const msg: Extract<ClientMessage, { query: "thread" }> = {
      type: "query",
      id: "q2",
      query: "thread",
      params: { id: "T1" },
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseClientMessage("not json")).toThrow();
  });

  it("rejects missing query name", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "query", id: "x", params: {} }))).toThrow();
  });

  it("rejects unknown query name", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "query", id: "x", query: "bogus", params: {} })),
    ).toThrow(/unknown query|unknown|bogus/);
  });

  it("rejects inbox query without agent param", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "query", id: "x", query: "inbox", params: {} })),
    ).toThrow();
  });

  it("rejects thread query without id param", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "query", id: "x", query: "thread", params: {} })),
    ).toThrow();
  });

  it("server message types are discriminated", () => {
    const ok: ServerMessage = { type: "result", id: "q1", rows: [] };
    const err: ServerMessage = { type: "error", id: "q1", code: "query_failed", message: "..." };
    expect(ok.type).toBe("result");
    expect(err.type).toBe("error");
  });
});
