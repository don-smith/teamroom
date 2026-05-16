import { describe, expect, it } from "bun:test";
import { SessionTimerManager, type TimerFactory, type TimerHandle } from "./session-manager.js";
import { FakeRunner } from "../container/fake-runner.js";

interface ManualTimers extends TimerFactory {
  advance(ms: number): void;
  pending(): number;
}

function manualTimers(): ManualTimers {
  const entries: { fire: () => void; when: number; cancelled: boolean }[] = [];
  let now = 0;
  return {
    schedule(ms, fn): TimerHandle {
      const entry = { fire: fn, when: now + ms, cancelled: false };
      entries.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    advance(ms) {
      now += ms;
      // Process in order of scheduled time; new timers scheduled inside `fire`
      // land in `entries` and will be picked up on subsequent iteration.
      let fired = true;
      while (fired) {
        fired = false;
        for (const e of entries) {
          if (e.cancelled) continue;
          if (e.when <= now) {
            e.cancelled = true;
            e.fire();
            fired = true;
          }
        }
      }
    },
    pending() {
      return entries.filter((e) => !e.cancelled).length;
    },
  };
}

function setup(idleMinutes = 30) {
  const runner = new FakeRunner();
  const timerFactory = manualTimers();
  let seq = 0;
  const manager = new SessionTimerManager({
    runner,
    idleMinutes,
    timerFactory,
    spec: (agentId, mcpToken) => ({
      imageTag: `teamroom-agent-${agentId}:latest`,
      mounts: [],
      env: { TEAMROOM_MCP_TOKEN: mcpToken },
    }),
    genToken: () => `tok-${++seq}`,
  });
  return { manager, runner, timerFactory };
}

describe("SessionTimerManager", () => {
  it("spawns a container on first onMailDelivered and writes the initial wake", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("claude-assistant");
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([{ type: "wake", events: ["mail"] }]);
  });

  it("reuses a live session on subsequent onMailDelivered — only writes a new wake", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    manager.onMailDelivered("A");
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toHaveLength(2);
  });

  it("resets the idle timer on mail.delivered", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered("A");
    timerFactory.advance(29 * 60 * 1000);
    manager.onMailDelivered("A");
    timerFactory.advance(29 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
    timerFactory.advance(1 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });

  it("resets the idle timer on onAgentActivity", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered("A");
    timerFactory.advance(29 * 60 * 1000);
    manager.onAgentActivity("A");
    timerFactory.advance(29 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
  });

  it("fires the timer and closes stdin after idleMinutes of silence", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered("A");
    timerFactory.advance(30 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });

  it("idleMinutes=0 disables the timer", () => {
    const { manager, runner, timerFactory } = setup(0);
    manager.onMailDelivered("A");
    timerFactory.advance(365 * 24 * 60 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
    expect(timerFactory.pending()).toBe(0);
  });

  it("removes the session when the container exits", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    expect(manager.hasSession("A")).toBe(true);
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    expect(manager.hasSession("A")).toBe(false);
  });

  it("respawns on next mail after container exit", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    manager.onMailDelivered("A");
    expect(runner.sessions).toHaveLength(2);
  });

  it("tokenFor / resolveToken round-trip per agent", () => {
    const { manager } = setup();
    expect(manager.tokenFor("A")).toBeNull();
    manager.onMailDelivered("A");
    const token = manager.tokenFor("A");
    expect(token).toMatch(/^tok-/);
    expect(manager.resolveToken(token!)).toBe("A");
    expect(manager.resolveToken("unknown")).toBeNull();
  });

  it("mints a fresh token on respawn", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    const first = manager.tokenFor("A")!;
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    manager.onMailDelivered("A");
    const second = manager.tokenFor("A")!;
    expect(second).not.toBe(first);
    expect(manager.resolveToken(first)).toBeNull();
  });

  it("killAll terminates every live session and clears the maps", async () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    manager.onMailDelivered("B");
    await manager.killAll();
    expect(manager.sessionCount()).toBe(0);
    // FakeRunningContainer.kill → simulateExit(137); both sessions should be gone.
    expect(runner.sessions.every((s) => !manager.hasSession(s.spec.imageTag))).toBe(true);
  });
});
