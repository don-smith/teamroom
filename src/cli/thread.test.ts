import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runThread } from "./thread.js";
import { composeStorage, type Storage } from "../modules/storage/storage.js";
import { composeMail, type Mail } from "../modules/mail/mail.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { ControllableClock } from "../clock/clock.js";

describe("teamroom thread", () => {
  let storage: Storage;
  let mail: Mail;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    storage.agentRepo.create({ id: "bob", configPath: "/b", createdAt: "2026-04-20T00:00:00Z" });
    mail = await composeMail({ storage, logger, port: 0 });
  });

  afterEach(async () => {
    await mail.stop();
    storage.close();
  });

  it("queries the mail WebSocket and returns all rows in the thread as JSON-lines", async () => {
    storage.messageRepo.create({
      id: "m1",
      agentId: "alice",
      body: "hello alice",
      channel: "mail",
      direction: "in",
      createdAt: "2026-04-21T00:00:00Z",
      traceId: "trace-1",
      from: "agent:bob",
      to: ["agent:alice"],
      threadId: "T1",
    });
    storage.messageRepo.create({
      id: "m2",
      agentId: "bob",
      body: "reply from alice",
      channel: "mail",
      direction: "in",
      createdAt: "2026-04-21T00:00:01Z",
      traceId: "trace-2",
      from: "agent:alice",
      to: ["agent:bob"],
      threadId: "T1",
    });

    const lines: string[] = [];
    await runThread({ port: mail.port, threadId: "T1", out: (l) => lines.push(l) });

    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.threadId).toBe("T1");
    expect(second.threadId).toBe("T1");
    const bodies = [first.body, second.body];
    expect(bodies).toContain("hello alice");
    expect(bodies).toContain("reply from alice");
  });

  it("returns empty when thread has no messages", async () => {
    const lines: string[] = [];
    await runThread({ port: mail.port, threadId: "nonexistent-thread", out: (l) => lines.push(l) });
    expect(lines.length).toBe(0);
  });

  it("propagates errors as a thrown Error when the server is unavailable", async () => {
    await mail.stop();
    await expect(
      runThread({ port: mail.port, threadId: "T1", out: () => {} }),
    ).rejects.toThrow();
  });
});
