import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runInbox } from "./inbox.js";
import { composeStorage, type Storage } from "../modules/storage/storage.js";
import { composeMail, type Mail } from "../modules/mail/mail.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { ControllableClock } from "../clock/clock.js";

describe("teamroom inbox", () => {
  let storage: Storage;
  let mail: Mail;
  const logger = new JsonLinesLogger(new ControllableClock("2026-04-20T00:00:00Z"), () => {}, { component: "test" });

  beforeEach(async () => {
    storage = composeStorage({ dataDir: ":memory:" });
    storage.agentRepo.create({ id: "alice", configPath: "/a", createdAt: "2026-04-20T00:00:00Z" });
    mail = await composeMail({ storage, logger, port: 0 });
  });

  afterEach(async () => {
    await mail.stop();
    storage.close();
  });

  it("queries the mail WebSocket and prints rows as JSON-lines", async () => {
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

    const lines: string[] = [];
    await runInbox({ port: mail.port, agent: "alice", out: (l) => lines.push(l) });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.agentId).toBe("alice");
    expect(parsed.body).toBe("hello alice");
  });

  it("returns empty when inbox is empty", async () => {
    const lines: string[] = [];
    await runInbox({ port: mail.port, agent: "alice", out: (l) => lines.push(l) });
    expect(lines.length).toBe(0);
  });

  it("propagates structured errors from the server as a thrown Error", async () => {
    // Stop the server so the connect attempt fails
    await mail.stop();
    await expect(
      runInbox({ port: mail.port, agent: "alice", out: () => {} }),
    ).rejects.toThrow();
  });
});
