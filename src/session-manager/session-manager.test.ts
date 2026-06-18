import { describe, expect, it } from "bun:test";
import { SessionTimerManager, type TimerFactory, type TimerHandle } from "./session-manager.js";
import { FakeRunner } from "../container/fake-runner.js";
import type { MailDeliveredEvent } from "../types.js";

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

let mailSeq = 0;
function mailDelivered(to: string, overrides: Partial<MailDeliveredEvent> = {}): MailDeliveredEvent {
  const n = ++mailSeq;
  return {
    type: "mail.delivered",
    to,
    messageId: `msg-${to}-${n}`,
    threadId: `thread-${to}`,
    from: "channel:cli:don",
    replyExpected: true,
    ...overrides,
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
    const delivery = mailDelivered("claude-assistant");
    manager.onMailDelivered(delivery);
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([{ type: "wake", events: [delivery] }]);
  });

  it("reuses a live session on subsequent onMailDelivered — only writes a new wake", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    manager.onMailDelivered(mailDelivered("A"));
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toHaveLength(2);
  });

  it("resets the idle timer on mail.delivered", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered(mailDelivered("A"));
    timerFactory.advance(29 * 60 * 1000);
    manager.onMailDelivered(mailDelivered("A"));
    timerFactory.advance(29 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
    timerFactory.advance(1 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });

  it("resets the idle timer on onAgentActivity", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered(mailDelivered("A"));
    timerFactory.advance(29 * 60 * 1000);
    manager.onAgentActivity("A");
    timerFactory.advance(29 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
  });

  it("fires the timer and closes stdin after idleMinutes of silence", () => {
    const { manager, runner, timerFactory } = setup(30);
    manager.onMailDelivered(mailDelivered("A"));
    timerFactory.advance(30 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });

  it("idleMinutes=0 disables the timer", () => {
    const { manager, runner, timerFactory } = setup(0);
    manager.onMailDelivered(mailDelivered("A"));
    timerFactory.advance(365 * 24 * 60 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
    expect(timerFactory.pending()).toBe(0);
  });

  it("removes the session when the container exits", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    expect(manager.hasSession("A")).toBe(true);
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    expect(manager.hasSession("A")).toBe(false);
  });

  it("respawns on next mail after container exit", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    manager.onMailDelivered(mailDelivered("A"));
    expect(runner.sessions).toHaveLength(2);
  });

  it("tokenFor / resolveToken round-trip per agent", () => {
    const { manager } = setup();
    expect(manager.tokenFor("A")).toBeNull();
    manager.onMailDelivered(mailDelivered("A"));
    const token = manager.tokenFor("A");
    expect(token).toMatch(/^tok-/);
    expect(manager.resolveToken(token!)).toBe("A");
    expect(manager.resolveToken("unknown")).toBeNull();
  });

  it("mints a fresh token on respawn", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    const first = manager.tokenFor("A")!;
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    manager.onMailDelivered(mailDelivered("A"));
    const second = manager.tokenFor("A")!;
    expect(second).not.toBe(first);
    expect(manager.resolveToken(first)).toBeNull();
  });

  it("killAll terminates every live session and clears the maps", async () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    manager.onMailDelivered(mailDelivered("B"));
    await manager.killAll();
    expect(manager.sessionCount()).toBe(0);
    // FakeRunningContainer.kill → simulateExit(137); both sessions should be gone.
    expect(runner.sessions.every((s) => !manager.hasSession(s.spec.imageTag))).toBe(true);
  });

  it("spawnIfAbsent creates a session without writing a wake envelope", () => {
    const { manager, runner } = setup();
    manager.spawnIfAbsent("A");
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([]);
    expect(manager.hasSession("A")).toBe(true);
  });

  it("spawnIfAbsent is a no-op when the session already exists", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered(mailDelivered("A"));
    manager.spawnIfAbsent("A");
    expect(runner.sessions).toHaveLength(1);
    // The initial wake is still the only envelope — spawnIfAbsent didn't write one.
    expect(runner.sessions[0]!.envelopes).toHaveLength(1);
  });

  it("onMailDelivered reuses a session created by spawnIfAbsent and writes its first wake", () => {
    const { manager, runner } = setup();
    manager.spawnIfAbsent("A");
    const delivery = mailDelivered("A");
    manager.onMailDelivered(delivery);
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([{ type: "wake", events: [delivery] }]);
  });
});

describe("SessionTimerManager — persistent lifecycle", () => {
  function persistentSetup(agentId: string, idleMinutes = 30) {
    const runner = new FakeRunner();
    const timerFactory = manualTimers();
    let seq = 0;
    const manager = new SessionTimerManager({
      runner,
      idleMinutes,
      timerFactory,
      spec: (aid, mcpToken) => ({
        imageTag: `teamroom-agent-${aid}:latest`,
        mounts: [],
        env: { TEAMROOM_MCP_TOKEN: mcpToken },
      }),
      genToken: () => `tok-${++seq}`,
      lifecycleFor: (aid) => (aid === agentId ? "persistent" : "session"),
    });
    return { manager, runner, timerFactory };
  }

  it("does not arm the idle timer for a persistent agent on mail.delivered", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one", 30);
    manager.onMailDelivered(mailDelivered("persistent-one"));
    expect(timerFactory.pending()).toBe(0);
    timerFactory.advance(365 * 24 * 60 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
  });

  it("does arm the idle timer for a session agent even when other agents are persistent", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one", 30);
    manager.onMailDelivered(mailDelivered("session-other"));
    expect(timerFactory.pending()).toBe(1);
    timerFactory.advance(30 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });

  it("respawns a persistent container after an unexpected exit (no wake envelope)", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    const firstToken = manager.tokenFor("persistent-one");
    runner.sessions[0]!.simulateExit({ exitCode: 1 });
    expect(runner.sessions).toHaveLength(1); // respawn scheduled but not yet fired
    timerFactory.advance(5000);
    expect(runner.sessions).toHaveLength(2);
    expect(runner.sessions[1]!.envelopes).toEqual([]); // respawn does NOT write wake
    expect(manager.tokenFor("persistent-one")).not.toBe(firstToken);
  });

  it("does not respawn a session-lifecycle agent after exit", () => {
    const { manager, runner } = persistentSetup("persistent-one");
    manager.onMailDelivered(mailDelivered("session-other"));
    runner.sessions[0]!.simulateExit({ exitCode: 0 });
    expect(runner.sessions).toHaveLength(1);
    expect(manager.hasSession("session-other")).toBe(false);
  });

  it("does not respawn after killAll/shutdown, even for persistent agents", async () => {
    const { manager, runner } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    await manager.killAll();
    expect(manager.hasSession("persistent-one")).toBe(false);
    expect(runner.sessions).toHaveLength(1); // no respawn
  });

  it("stops respawning after MAX_RESPAWNS_PER_AGENT consecutive failures", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    // Drive 11 consecutive exits — after 10 respawns, the 11th exit should not respawn.
    for (let i = 0; i < 11; i++) {
      const last = runner.sessions[runner.sessions.length - 1]!;
      last.simulateExit({ exitCode: 1 });
      timerFactory.advance(5000);
    }
    // 1 initial spawn + 10 respawns = 11 total sessions; next exit stops.
    expect(runner.sessions).toHaveLength(11);
    expect(manager.hasSession("persistent-one")).toBe(false);
  });

  it("resets respawn count after a clean exit", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    // Two failures, then a clean exit, then another failure should still respawn
    // because the counter was reset.
    runner.sessions[0]!.simulateExit({ exitCode: 1 });
    timerFactory.advance(5000);
    runner.sessions[1]!.simulateExit({ exitCode: 1 });
    timerFactory.advance(5000);
    runner.sessions[2]!.simulateExit({ exitCode: 0 });
    manager.spawnIfAbsent("persistent-one");
    runner.sessions[3]!.simulateExit({ exitCode: 1 });
    timerFactory.advance(5000);
    expect(runner.sessions).toHaveLength(5);
  });

  it("deduplicates wake delivery by messageId", () => {
    const { manager, runner } = persistentSetup("persistent-one");
    const delivery = mailDelivered("persistent-one");
    manager.onMailDelivered(delivery);
    manager.onMailDelivered(delivery);
    expect(runner.sessions[0]!.envelopes).toHaveLength(1);
  });
});
