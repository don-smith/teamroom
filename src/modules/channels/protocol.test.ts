import { describe, expect, it } from "bun:test";
import { parseClientMessage, type ClientMessage, type ServerMessage } from "./protocol.js";

describe("chat WebSocket protocol", () => {
  it("parses register message", () => {
    expect(parseClientMessage(JSON.stringify({ type: "register", channel: "cli", externalId: "don" })))
      .toEqual({ type: "register", channel: "cli", externalId: "don" });
  });

  it("parses publish message with minimal fields", () => {
    const msg = { type: "publish", to: ["agent:a"], body: "hi" };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({
      type: "publish",
      to: ["agent:a"],
      body: "hi",
      threadId: null,
      cc: [],
    });
  });

  it("parses publish message with threadId and cc", () => {
    const msg: Extract<ClientMessage, { type: "publish" }> = {
      type: "publish",
      to: ["agent:a"],
      body: "hi",
      threadId: "T1",
      cc: ["agent:b"],
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("rejects unknown message type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "evil" }))).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseClientMessage("not json")).toThrow();
  });

  it("rejects register without channel or externalId", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "register", channel: "cli" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "register", externalId: "don" }))).toThrow();
  });

  it("rejects publish without to or body", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "publish", body: "hi" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "publish", to: ["agent:a"] }))).toThrow();
  });

  it("rejects publish with non-string elements in cc[] (consistent with to[])", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "publish", to: ["agent:a"], body: "hi", cc: ["agent:b", 42] })),
    ).toThrow(/cc\[\] elements must be strings/);
  });

  it("server message types are discriminated", () => {
    const m: ServerMessage = {
      type: "mail",
      id: "1",
      from: "agent:a",
      to: ["channel:cli:don"],
      cc: [],
      body: "hi",
      threadId: "T",
      ts: "2026-04-21T00:00:00Z",
    };
    expect(m.type).toBe("mail");
  });
});
