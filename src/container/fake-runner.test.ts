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
