import type { ContainerRunner, RunningContainer } from "../container/container-runner.js";
import type { DockerRunSpec } from "../container/docker-command.js";
import type { Logger } from "../logger/logger.js";

/**
 * TimerHandle returned by TimerFactory.schedule. The timer manager calls
 * `cancel` when it needs to rearm (every bus event that touches an agent
 * extends its idle timer).
 */
export interface TimerHandle {
  cancel(): void;
}

export interface TimerFactory {
  schedule(ms: number, fn: () => void): TimerHandle;
}

/**
 * Production timer factory. Tests swap in a manual factory that lets them
 * `advance(ms)` deterministically.
 */
export const realTimerFactory: TimerFactory = {
  schedule(ms, fn) {
    const id = setTimeout(fn, ms);
    return {
      cancel() {
        clearTimeout(id);
      },
    };
  },
};

export interface SessionTimerManagerDeps {
  runner: ContainerRunner;
  idleMinutes: number;
  timerFactory: TimerFactory;
  /** Build the DockerRunSpec for an agent, given its per-spawn MCP token. */
  spec: (agentId: string, mcpToken: string) => DockerRunSpec;
  /** Mint a fresh MCP token per spawn. */
  genToken: () => string;
  logger?: Logger;
  /**
   * Per-agent lifecycle lookup. `persistent` agents skip the idle timer
   * entirely and are respawned on unexpected exit. `session` (default)
   * keeps today's behavior. Defaults to a function returning "session"
   * if omitted — existing callers keep working.
   */
  lifecycleFor?: (agentId: string) => "session" | "persistent";
}

interface Session {
  agentId: string;
  rc: RunningContainer;
  timer: TimerHandle | null;
  token: string;
}

/**
 * Owns per-agent container lifetime in M4.
 *
 * A session is created on the first `mail.delivered` event for an agent
 * (spawn container + register session + write initial wake). Subsequent
 * `mail.delivered` events reuse the live session — we just push another
 * wake envelope. Any bus activity that names the agent resets the idle
 * timer; when it fires, we close stdin and let the runtime exit cleanly.
 *
 * The manager also stores the reverse token → agentId map so the mail
 * MCP server can resolve the caller from the request header.
 *
 * `idleMinutes = 0` disables the timer (useful in tests where you want a
 * session to stay open until explicitly killed; an alternative is Task-
 * driven killAll at test teardown).
 */
export class SessionTimerManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, string>(); // token → agentId
  private isShuttingDown = false;
  private respawnCounts = new Map<string, number>();
  private static readonly MAX_RESPAWNS_PER_AGENT = 10;

  constructor(private readonly deps: SessionTimerManagerDeps) {}

  onMailDelivered(agentId: string): void {
    let s = this.sessions.get(agentId);
    if (!s) s = this.spawn(agentId);
    try {
      s.rc.writeEnvelope({ type: "wake", events: ["mail"] });
    } catch (err) {
      // A lingering Session pointing at a torn-down container — drop it
      // and respawn. Possible if the runner exited between the bus event
      // firing and our stdin write.
      this.deps.logger?.warn("session-manager.write.failed-respawning", {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.removeSession(agentId, s);
      const fresh = this.spawn(agentId);
      fresh.rc.writeEnvelope({ type: "wake", events: ["mail"] });
      return;
    }
    this.armTimer(s);
  }

  onAgentActivity(agentId: string): void {
    const s = this.sessions.get(agentId);
    if (!s) return;
    this.armTimer(s);
  }

  tokenFor(agentId: string): string | null {
    return this.sessions.get(agentId)?.token ?? null;
  }

  resolveToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  /**
   * Ensure a session exists for this agent without writing a wake envelope.
   * Used at daemon boot for persistent-lifecycle agents so their container
   * is already up when the first mail arrives. No-op if a session already
   * exists.
   *
   * Kept separate from the mail-driven path (`onMailDelivered`) because the
   * two have different triggers and contracts: mail always writes a wake and
   * arms the timer; boot-spawn does neither.
   */
  spawnIfAbsent(agentId: string): void {
    if (this.sessions.has(agentId)) return;
    this.spawn(agentId);
  }

  hasSession(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  async killAll(): Promise<void> {
    this.isShuttingDown = true;
    const all = [...this.sessions.values()];
    await Promise.all(
      all.map(async (s) => {
        try {
          await s.rc.kill();
        } catch (err) {
          this.deps.logger?.warn("session-manager.kill.failed", {
            agentId: s.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    this.sessions.clear();
    this.tokens.clear();
  }

  private spawn(agentId: string): Session {
    const token = this.deps.genToken();
    const spec = this.deps.spec(agentId, token);
    const rc = this.deps.runner.start(spec);
    const session: Session = { agentId, rc, timer: null, token };
    this.sessions.set(agentId, session);
    this.tokens.set(token, agentId);
    rc.onExit(() => {
      this.removeSession(agentId, session);
      if (this.isShuttingDown) return;
      const lifecycle = this.deps.lifecycleFor?.(agentId) ?? "session";
      if (lifecycle === "persistent") {
        const count = (this.respawnCounts.get(agentId) ?? 0) + 1;
        this.respawnCounts.set(agentId, count);
        if (count > SessionTimerManager.MAX_RESPAWNS_PER_AGENT) {
          this.deps.logger?.warn("session.persistent_respawn_cap_reached", {
            agentId,
            count,
            cap: SessionTimerManager.MAX_RESPAWNS_PER_AGENT,
          });
          return;
        }
        this.deps.logger?.info("session.persistent_respawn", { agentId, count });
        this.spawn(agentId);
      }
    });
    this.deps.logger?.info("session.spawned", { agentId });
    return session;
  }

  private removeSession(agentId: string, session: Session): void {
    const current = this.sessions.get(agentId);
    // Only remove if the map still points at this session — a respawn may
    // have replaced it before the old session's exit handler fired.
    if (current === session) {
      this.sessions.delete(agentId);
    }
    this.tokens.delete(session.token);
    session.timer?.cancel();
    session.timer = null;
  }

  private armTimer(s: Session): void {
    s.timer?.cancel();
    const lifecycle = this.deps.lifecycleFor?.(s.agentId) ?? "session";
    if (lifecycle === "persistent" || this.deps.idleMinutes <= 0) {
      s.timer = null;
      return;
    }
    s.timer = this.deps.timerFactory.schedule(this.deps.idleMinutes * 60 * 1000, () => {
      this.deps.logger?.info("session.idle_exit", { agentId: s.agentId });
      s.rc.closeStdin();
    });
  }
}
