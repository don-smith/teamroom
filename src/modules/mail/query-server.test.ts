import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WebSocket } from "ws";
import { QueryServer } from "./query-server.js";
import { composeStorage, type Storage } from "../storage/storage.js";
import { JsonLinesLogger } from "../../logger/logger.js";
import { ControllableClock } from "../../clock/clock.js";

describe("QueryServer", () => {
  let storage: Storage;
  let server: QueryServer;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    server = new QueryServer({ storage, logger, port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    storage.close();
  });

  it("returns inbox rows for an agent", async () => {
    // Insert a row directly via messageRepo (lower-level than dispatcher, just for test setup)
    storage.messageRepo.create({
      id: "m1",
      agentId: "alice",
      body: "hello",
      channel: "mail",
      direction: "in",
      createdAt: "2026-04-21T00:00:00Z",
      traceId: "trace-1",
      from: "agent:bob",
      to: ["agent:alice"],
      threadId: "T1",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));

    const reply = new Promise<any>((ok) => ws.on("message", (raw) => ok(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({ type: "query", id: "q1", query: "inbox", params: { agent: "alice" } }));

    const res = await reply;
    expect(res.type).toBe("result");
    expect(res.id).toBe("q1");
    expect(Array.isArray(res.rows)).toBe(true);
    expect(res.rows.length).toBe(1);
    ws.close();
  });

  it("returns thread rows for a thread id", async () => {
    storage.messageRepo.create({
      id: "m1", agentId: "alice", body: "hi", channel: "mail", direction: "in",
      createdAt: "2026-04-21T00:00:00Z", traceId: "trace-1",
      from: "agent:bob", to: ["agent:alice"], threadId: "T1",    });
    storage.messageRepo.create({
      id: "m2", agentId: "alice", body: "reply", channel: "mail", direction: "in",
      createdAt: "2026-04-21T00:00:01Z", traceId: "trace-2",
      from: "agent:carol", to: ["agent:alice"], threadId: "T1",    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    const reply = new Promise<any>((ok) => ws.on("message", (raw) => ok(JSON.parse(raw.toString()))));
    ws.send(JSON.stringify({ type: "query", id: "q1", query: "thread", params: { id: "T1" } }));

    const res = await reply;
    expect(res.type).toBe("result");
    expect(res.rows.length).toBe(2);
    ws.close();
  });

  it("returns error on malformed client message", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    const reply = new Promise<any>((ok) => ws.on("message", (raw) => ok(JSON.parse(raw.toString()))));
    ws.send("not json");

    const res = await reply;
    expect(res.type).toBe("error");
    expect(res.code).toBe("invalid_message");
    ws.close();
  });
});
