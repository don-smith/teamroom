import { describe, expect, it } from "vitest";
import { FakeRunner, type Script } from "./fake-runner.js";
import type { ContainerStdoutEvent } from "./container-runner.js";

describe("FakeRunner", () => {
  it("replays scripted events in order and returns the scripted exit", async () => {
    const script: Script = {
      events: [
        { type: "reply", body: "hello" },
        { type: "reply", body: "world" },
      ],
      exitCode: 0,
      stderr: "",
    };
    const runner = new FakeRunner(() => script);
    const events: ContainerStdoutEvent[] = [];
    const result = await runner.run({
      spec: { imageTag: "x", mounts: [], env: {} },
      stdinJson: "{}",
      timeoutMs: 5000,
      onEvent: (e) => events.push(e),
    });
    expect(events.map((e) => (e.type === "reply" ? e.body : "?"))).toEqual(["hello", "world"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.containerId).toMatch(/^fake-/);
  });

  it("reports non-zero exit with stderr", async () => {
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 1,
      stderr: "boom",
    }));
    const result = await runner.run({
      spec: { imageTag: "x", mounts: [], env: {} },
      stdinJson: "{}",
      timeoutMs: 5000,
      onEvent: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("boom");
  });

  it("reports timeout when script requests it", async () => {
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 137,
      stderr: "",
      timedOut: true,
    }));
    const result = await runner.run({
      spec: { imageTag: "x", mounts: [], env: {} },
      stdinJson: "{}",
      timeoutMs: 1,
      onEvent: () => {},
    });
    expect(result.timedOut).toBe(true);
  });

  it("passes the request to the script-resolver so scripts can adapt to input", async () => {
    let captured = "";
    const runner = new FakeRunner((req) => {
      captured = req.stdinJson;
      return { events: [], exitCode: 0, stderr: "" };
    });
    await runner.run({
      spec: { imageTag: "x", mounts: [], env: {} },
      stdinJson: '{"prompt":"hi"}',
      timeoutMs: 5000,
      onEvent: () => {},
    });
    expect(captured).toBe('{"prompt":"hi"}');
  });
});

describe("FakeRunner — streaming interface", () => {
  it("records envelopes written before and after attaching listeners", () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    rc.writeEnvelope({ type: "wake", events: ["mail"] });
    rc.writeEnvelope({ n: 2 });
    expect(rc.envelopes).toEqual([
      { type: "wake", events: ["mail"] },
      { n: 2 },
    ]);
  });

  it("writeEnvelope throws after closeStdin", () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    rc.closeStdin();
    expect(() => rc.writeEnvelope({ x: 1 })).toThrow(/after closeStdin/);
  });

  it("simulateEvent fans out to all event handlers", () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    const seen: unknown[] = [];
    rc.onEvent((e) => seen.push(e));
    rc.onEvent((e) => seen.push({ dup: e }));
    rc.simulateEvent({ type: "log", level: "info", msg: "hi" });
    expect(seen).toHaveLength(2);
  });

  it("simulateExit fires onExit handlers once and is idempotent", () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    const exits: unknown[] = [];
    rc.onExit((r) => exits.push(r));
    rc.simulateExit({ exitCode: 0 });
    rc.simulateExit({ exitCode: 137 });
    expect(exits).toHaveLength(1);
    expect((exits[0] as { exitCode: number }).exitCode).toBe(0);
  });

  it("kill simulates a 137 exit", async () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    const exits: unknown[] = [];
    rc.onExit((r) => exits.push(r));
    await rc.kill();
    expect((exits[0] as { exitCode: number }).exitCode).toBe(137);
  });

  it("waitForEnvelope resolves when writeEnvelope runs", async () => {
    const runner = new FakeRunner();
    const rc = runner.start({ imageTag: "x", mounts: [], env: {} });
    const wait = rc.waitForEnvelope();
    rc.writeEnvelope({ answered: true });
    await expect(wait).resolves.toEqual({ answered: true });
  });

  it("tracks sessions on the runner for introspection", () => {
    const runner = new FakeRunner();
    const rc1 = runner.start({ imageTag: "x", mounts: [], env: {} });
    const rc2 = runner.start({ imageTag: "y", mounts: [], env: {} });
    expect(runner.sessions).toEqual([rc1, rc2]);
  });
});
