# M6 Multi-Harness Implementation Plan — Archie (DeepAgents) + Dev (Hermes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate two external agent harnesses as full Team Room peers — Archie on DeepAgents and Dev on Hermes — running in long-lived, self-restarting containers that speak the existing stdin wake protocol and use our mail-MCP server unchanged.

**Architecture:** Small substrate addition (`lifecycle: session | persistent` on `agent.yaml`, daemon-managed respawn on unexpected container exit), git submodules at `vendor/<harness>/` for source tracking, thin Python shims per harness that translate stdin wake envelopes into each harness's programmatic API, model calls routed through the existing daemon proxy. Existing session agents (studio-assistant, claude-*) are untouched.

**Tech Stack:** TypeScript (daemon), Python 3.13 (shims), Docker, `deepagents` (Python) + `langchain-mcp-adapters`, `NousResearch/hermes-agent`, vitest, git submodules.

**Spec:** [`docs/specs/2026-04-22-m6-multi-harness-design.md`](../specs/2026-04-22-m6-multi-harness-design.md)

**Plan-time decisions locked in this plan** (from spec §14):

| # | Decision |
|---|---|
| 1 | Models: Archie → `claude-opus-4-7` (architect work). Dev → `claude-sonnet-4-6` (developer work). Both via the existing Anthropic OAuth proxy. **No proxy extensions needed.** |
| 2 | Python: **3.13** for both images (Hermes pins 3.13 upstream; DeepAgents supports 3.13). |
| 3 | Hermes AIAgent API: confirmed by reading `run_agent.py` in Task E1 before writing the shim. |
| 4 | Provider enum: **extend** `"anthropic" \| "lm-studio" \| "ollama"` with `"deepagents"` and `"hermes"`. N=5 doesn't yet earn a refactor. |
| 5 | Shell adapter for Archie: **deferred** — S1 acceptance reads/edits files, which DeepAgents's FS tools handle. Shell is out of M6 for Archie. |
| 6 | Session-manager branch shape: **new methods on `SessionTimerManager`** (`spawnIfAbsent`, `shutdown` flag) + a `lifecycleFor` dep injected from the compose layer. No second strategy class. |
| 7 | Install commands: `pip install /path/to/vendor/<harness>` (non-editable, from vendored source tree). |
| 8 | Dev image: **build fresh from source** using the vendored tree. Upstream Hermes Dockerfile is referenced in the new image but we don't layer on top (easier to pin the `TEAMROOM_MCP_URL` / `TEAMROOM_MODEL_BASE_URL` baking and avoid the `uv`-based venv setup). |

---

## Task 0.1: Correct spec §5.2 + §5.3 — daemon-managed respawn (not Docker `--restart`)

**Why:** While reading `src/session-manager/session-manager.ts` during planning, the session-manager already has `onExit` handlers and a respawn code path. Docker's `--restart=unless-stopped` + `docker run --rm -i` is (a) incompatible with `--rm` semantics, and (b) cannot re-establish the daemon-side stdin pipe after Docker recreates the container. Daemon-managed respawn on `onExit` gives the same "auto-restart" property with full lifecycle visibility and no Docker-level complication. Spec must reflect this before we wire the code.

**Files:**
- Modify: `docs/specs/2026-04-22-m6-multi-harness-design.md` (§5.2 and §5.3)

- [ ] **Step 1: Rewrite §5.2's "`persistent` behavior" bullet list.**

Replace the existing `persistent` behavior list with:

```markdown
`persistent` behavior:

- Container spawns once at daemon boot (via the session-management compose-layer init — see plan Task A6).
- Stdin pipe kept open for the container's lifetime.
- No idle timeout (the per-agent idle-timeout backlog item is effectively folded in: `persistent` means "idle-timeout = ∞").
- On unexpected container exit, the session-manager's `onExit` handler fires and the manager respawns a fresh container (fresh MCP token, fresh DockerRunSpec). A short backoff (1s initial, doubling to a cap of 30s) prevents tight crash loops.
- On daemon shutdown (`SessionTimerManager.shutdown()` followed by `killAll()`), persistent containers are stopped cleanly and NOT respawned. A `isShuttingDown` flag gates the respawn path.

Location: `src/session-manager/session-manager.ts` grows two concepts — a `spawnIfAbsent(agentId)` method for boot-time spawning, and a `lifecycleFor: (agentId) => "session" | "persistent"` dep that `armTimer` and `removeSession` both consult.
```

- [ ] **Step 2: Replace §5.3 entirely with this revised content.**

```markdown
### 5.3 Docker lifecycle flags — no change this milestone

No Docker `--restart` flag is added. The daemon is always watching via `RunningContainer.onExit`; daemon-managed respawn (§5.2) gives the "auto-restart" property without the `--rm` + `--restart` incompatibility and without the stdin-reattach problem Docker's `--restart` would introduce. Existing `docker run --rm -i` args work for both `session` and `persistent` lifecycles unchanged.

Revisit Docker-level restart policy only if daemon-watching proves insufficient (e.g., the daemon itself crashes frequently and persistent agents should survive its outages). That's a future-milestone concern.
```

- [ ] **Step 3: Remove the §14 item that depends on the dropped docker-command change.**

Current §14 item 6 reads "Session-manager branch shape. Concrete second session strategy or flag inside the existing one." Leave this item — it's still valid (we're picking the flag approach in Decision 6 above). No edit.

Note: §5.4 (provider enum) and §5.5 (proxy extensions conditional) are unchanged.

- [ ] **Step 4: Re-read the amended spec for internal consistency.**

Specifically: §4.1 item 1 still says "auto-restart" — that's unchanged because the property holds, just via a different mechanism. §8 Invocation model still accurate. §15 Related unchanged.

- [ ] **Step 5: Commit the spec amendment.**

```bash
git add docs/specs/2026-04-22-m6-multi-harness-design.md
git commit -m "docs(spec): m6 §5.2–5.3 — daemon-managed respawn, not docker --restart"
```

---

## Task 0.2: Pre-M6 verification — studio-assistant ↔ claude-assistant mail round-trip

**Why:** Tabled in `docs/tabled.md`. Confirms current-team peer communication works before M6 adds new peers. Five-minute manual check; not worth a unit test beyond what M5's acceptance already exercised.

**Files:**
- Modify: `docs/tabled.md` (remove the entry once verified)

- [ ] **Step 1: Start the daemon.**

In terminal 1:

```bash
cd /Users/don/projects/teamroom/teamroom-worktrees/teamroom/m6-mature-agent
npm run build
teamroom serve
```

Expected: daemon starts; log shows `session.subscribed` for `mail.delivered`, `mail.sent`, `tool.call`.

- [ ] **Step 2: Send mail from studio-assistant to claude-assistant via the CLI.**

In terminal 2:

```bash
teamroom chat studio-assistant
```

At the REPL prompt, ask studio-assistant to send mail to claude-assistant:

```
send a short mail to claude-assistant asking it for a one-sentence summary of what src/mail-mcp/ does
```

Expected: studio-assistant spawns, calls `mail.send`, container stays alive. Log shows `session.spawned` for `studio-assistant`, then `mail.delivered` with `to: claude-assistant`, then `session.spawned` for `claude-assistant`.

- [ ] **Step 3: Observe claude-assistant reading and replying.**

In terminal 3:

```bash
teamroom inbox claude-assistant
```

Expected: one unread mail from studio-assistant. Then wait ~10-30s for claude-assistant to process and reply. Re-run `teamroom inbox studio-assistant` to see the reply.

- [ ] **Step 4: Confirm via thread view.**

```bash
teamroom thread <thread-id-from-inbox>
```

Expected: full two-message thread — studio-assistant request, claude-assistant reply.

- [ ] **Step 5: If passed, remove the tabled entry and commit.**

Edit `docs/tabled.md` to delete the "Verify studio-assistant ↔ claude-assistant mail round-trip end-to-end" bullet.

```bash
git add docs/tabled.md
git commit -m "docs(tabled): verified studio↔claude mail round-trip (pre-M6)"
```

If FAILED: stop here. File a bug, investigate — M6 assumes this works. Do not proceed.

---

## Task A1: `agent-config.ts` — add `lifecycle` field

**Files:**
- Modify: `src/agent-config/agent-config.ts`
- Modify: `src/agent-config/agent-config.test.ts`

- [ ] **Step 1: Write the failing tests.**

Add to `src/agent-config/agent-config.test.ts` at the end of the file, a new `describe` block:

```ts
describe("loadAgentConfig — lifecycle field", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "a");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# test");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("defaults lifecycle to 'session' when omitted", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("session");
  });

  it("parses lifecycle: persistent", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nlifecycle: persistent\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("persistent");
  });

  it("rejects unknown lifecycle values", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nlifecycle: forever\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/lifecycle.*'session'.*'persistent'.*got 'forever'/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
npx vitest run src/agent-config/agent-config.test.ts
```

Expected: FAIL — `cfg.lifecycle` is undefined (or the lifecycle tests error because the field doesn't exist on AgentConfig yet).

- [ ] **Step 3: Extend `AgentConfig` interface and parse the field.**

In `src/agent-config/agent-config.ts`:

Add to the `AgentConfig` interface (after the `allowedTools` field):

```ts
export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  provider: Provider;
  configPath: string;
  agentsMdPath: string;
  storePath: string;
  subscriptions: string[];
  allowedTools: string[];
  lifecycle: AgentLifecycle;
}

export type AgentLifecycle = "session" | "persistent";
```

At the end of `loadAgentConfig`, before the `return` statement, add:

```ts
  const lifecycleRaw = parsed.lifecycle;
  let lifecycle: AgentLifecycle = "session";
  if (lifecycleRaw !== undefined && lifecycleRaw !== null) {
    if (lifecycleRaw !== "session" && lifecycleRaw !== "persistent") {
      throw new Error(
        `agent.yaml 'lifecycle' must be 'session' or 'persistent' (got '${String(lifecycleRaw)}')`,
      );
    }
    lifecycle = lifecycleRaw;
  }
```

Update the return statement:

```ts
  return {
    name,
    model,
    imageTag,
    provider,
    configPath,
    agentsMdPath,
    storePath,
    subscriptions,
    allowedTools,
    lifecycle,
  };
```

- [ ] **Step 4: Run tests to verify they pass.**

```bash
npx vitest run src/agent-config/agent-config.test.ts
```

Expected: all pass (including the 3 new ones).

- [ ] **Step 5: Run the full test suite to check for regressions.**

```bash
npx vitest run
```

Expected: everything passes.

- [ ] **Step 6: Run `npm run typecheck` to catch any type drift.**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add src/agent-config/agent-config.ts src/agent-config/agent-config.test.ts
git commit -m "feat(agent-config): add lifecycle: 'session' | 'persistent', default session"
```

---

## Task A2: `agent-config.ts` — extend provider enum for `deepagents` + `hermes`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent-config/agent-config.ts`
- Modify: `src/agent-config/agent-config.test.ts`

- [ ] **Step 1: Find the `Provider` type definition.**

```bash
grep -rn "type Provider\|Provider =" src/types.ts
```

Expected: locates `Provider` in `src/types.ts`. Read that file to see the current shape.

- [ ] **Step 2: Write failing tests for the two new providers.**

Add to `src/agent-config/agent-config.test.ts` inside the existing `describe("loadAgentConfig — provider field", ...)` block (after the `accepts provider: ollama` test):

```ts
  it("accepts provider: deepagents", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: m\nimage_tag: t\nprovider: deepagents\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("deepagents");
  });

  it("accepts provider: hermes", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: m\nimage_tag: t\nprovider: hermes\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("hermes");
  });
```

- [ ] **Step 3: Run tests to verify they fail.**

```bash
npx vitest run src/agent-config/agent-config.test.ts
```

Expected: two new tests FAIL with "provider must be 'anthropic' | 'lm-studio' | 'ollama'".

- [ ] **Step 4: Extend the `Provider` type.**

In `src/types.ts`, update the `Provider` type to:

```ts
export type Provider = "anthropic" | "lm-studio" | "ollama" | "deepagents" | "hermes";
```

- [ ] **Step 5: Update the provider-validation branch in `agent-config.ts`.**

In `src/agent-config/agent-config.ts`, change the provider-check to:

```ts
  if (
    provider !== "anthropic" &&
    provider !== "lm-studio" &&
    provider !== "ollama" &&
    provider !== "deepagents" &&
    provider !== "hermes"
  ) {
    throw new Error(
      `agent.yaml 'provider' must be 'anthropic', 'lm-studio', 'ollama', 'deepagents', or 'hermes' (got '${String(provider)}')`,
    );
  }
```

And update the earlier "missing" error message correspondingly:

```ts
  if (provider === undefined || provider === null) {
    throw new Error(
      `agent.yaml missing 'provider' (expected 'anthropic', 'lm-studio', 'ollama', 'deepagents', or 'hermes')`,
    );
  }
```

- [ ] **Step 6: Run tests to verify they pass.**

```bash
npx vitest run src/agent-config/agent-config.test.ts
```

Expected: all pass.

- [ ] **Step 7: Run full test suite + tsc.**

```bash
npx vitest run
npm run typecheck
```

Expected: clean. If any `switch (provider)` exhaustiveness checks elsewhere in the code now fail, fix them — add `deepagents`/`hermes` branches that either throw "not yet wired at this layer" or are no-ops as appropriate. Likely locations: `src/agent-runtime/worker.ts` (buildWorker switch), `src/modules/model-proxy/model-proxy.ts` (provider-adapter map). Adapt each case:
- In `worker.ts`: add cases that throw `"TEAMROOM_PROVIDER='deepagents' uses its own entrypoint (Python shim); this branch should not be reached."` — the Archie/Dev Dockerfiles set a different entrypoint, so `main.ts`'s worker loop is never called.
- In `model-proxy.ts`: if the adapter map requires exhaustiveness, add entries mapping `deepagents` and `hermes` to `null` or to the Anthropic adapter (since both use Anthropic through the proxy in this milestone).

- [ ] **Step 8: Commit.**

```bash
git add src/types.ts src/agent-config/agent-config.ts src/agent-config/agent-config.test.ts src/agent-runtime/worker.ts src/modules/model-proxy/model-proxy.ts
git commit -m "feat(agent-config): add 'deepagents' and 'hermes' providers"
```

(Adjust staged files if Step 7 didn't require any worker/proxy changes.)

---

## Task A3: `session-manager.ts` — add `spawnIfAbsent` method

**Why:** Boot-time persistent-agent spawning. Unlike `onMailDelivered`, `spawnIfAbsent` doesn't write a wake envelope — it just brings the container up and registers the session so subsequent `mail.delivered` events can reuse it.

**Files:**
- Modify: `src/session-manager/session-manager.ts`
- Modify: `src/session-manager/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests.**

Add to `src/session-manager/session-manager.test.ts` inside the existing `describe("SessionTimerManager", ...)` block:

```ts
  it("spawnIfAbsent creates a session without writing a wake envelope", () => {
    const { manager, runner } = setup();
    manager.spawnIfAbsent("A");
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([]);
    expect(manager.hasSession("A")).toBe(true);
  });

  it("spawnIfAbsent is a no-op when the session already exists", () => {
    const { manager, runner } = setup();
    manager.onMailDelivered("A");
    manager.spawnIfAbsent("A");
    expect(runner.sessions).toHaveLength(1);
    // The initial wake is still the only envelope — spawnIfAbsent didn't write one.
    expect(runner.sessions[0]!.envelopes).toHaveLength(1);
  });

  it("onMailDelivered reuses a session created by spawnIfAbsent and writes its first wake", () => {
    const { manager, runner } = setup();
    manager.spawnIfAbsent("A");
    manager.onMailDelivered("A");
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.envelopes).toEqual([{ type: "wake", events: ["mail"] }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: FAIL — `manager.spawnIfAbsent is not a function`.

- [ ] **Step 3: Implement `spawnIfAbsent`.**

In `src/session-manager/session-manager.ts`, add as a new public method on `SessionTimerManager` (after `resolveToken`):

```ts
  /**
   * Ensure a session exists for this agent without writing a wake envelope.
   * Used at daemon boot for persistent-lifecycle agents so their container
   * is already up when the first mail arrives. No-op if a session already
   * exists.
   */
  spawnIfAbsent(agentId: string): void {
    if (this.sessions.has(agentId)) return;
    this.spawn(agentId);
  }
```

- [ ] **Step 4: Run tests.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/session-manager/session-manager.ts src/session-manager/session-manager.test.ts
git commit -m "feat(session-manager): add spawnIfAbsent for boot-time persistent spawns"
```

---

## Task A4: `session-manager.ts` — `lifecycleFor` dep + `armTimer` skip for persistent

**Why:** Persistent agents never idle-timeout, regardless of the global `idleMinutes` setting. The session-manager needs to know per-agent lifecycle to decide whether to arm the timer.

**Files:**
- Modify: `src/session-manager/session-manager.ts`
- Modify: `src/session-manager/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests.**

Add to `src/session-manager/session-manager.test.ts`, a new nested describe block after the existing describe:

```ts
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
    manager.onMailDelivered("persistent-one");
    expect(timerFactory.pending()).toBe(0);
    timerFactory.advance(365 * 24 * 60 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(false);
  });

  it("does arm the idle timer for a session agent even when other agents are persistent", () => {
    const { manager, runner, timerFactory } = persistentSetup("persistent-one", 30);
    manager.onMailDelivered("session-other");
    expect(timerFactory.pending()).toBe(1);
    timerFactory.advance(30 * 60 * 1000);
    expect(runner.sessions[0]!.isStdinClosed()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: FAIL — the `lifecycleFor` dep is not part of `SessionTimerManagerDeps`.

- [ ] **Step 3: Add `lifecycleFor` to deps and `armTimer`.**

In `src/session-manager/session-manager.ts`:

Update `SessionTimerManagerDeps`:

```ts
export interface SessionTimerManagerDeps {
  runner: ContainerRunner;
  idleMinutes: number;
  timerFactory: TimerFactory;
  spec: (agentId: string, mcpToken: string) => DockerRunSpec;
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
```

Update `armTimer`:

```ts
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
```

- [ ] **Step 4: Run tests.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/session-manager/session-manager.ts src/session-manager/session-manager.test.ts
git commit -m "feat(session-manager): lifecycleFor dep; persistent agents skip idle timer"
```

---

## Task A5: `session-manager.ts` — respawn on exit for persistent + `shutdown` flag

**Why:** When a persistent container exits unexpectedly, spawn a fresh one. When the daemon is shutting down (`killAll`), don't respawn.

**Files:**
- Modify: `src/session-manager/session-manager.ts`
- Modify: `src/session-manager/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests.**

Add to the `describe("SessionTimerManager — persistent lifecycle", ...)` block from Task A4:

```ts
  it("respawns a persistent container after an unexpected exit (no wake envelope)", () => {
    const { manager, runner } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    const firstToken = manager.tokenFor("persistent-one");
    runner.sessions[0]!.simulateExit({ exitCode: 1 });
    // Respawn is synchronous in the manager; the async backoff is wrapped
    // in a timer we can advance deterministically.
    // Initial backoff is 1000ms per the implementation.
    // (If the test setup's timerFactory doesn't implement setTimeout-style
    //  advance for the backoff, refactor the manager to pass the delay
    //  through the injected timerFactory.)
    // Expect: two container spawn attempts, fresh token on second.
    expect(runner.sessions).toHaveLength(2);
    expect(runner.sessions[1]!.envelopes).toEqual([]); // respawn does NOT write wake
    expect(manager.tokenFor("persistent-one")).not.toBe(firstToken);
  });

  it("does not respawn a session-lifecycle agent after exit", () => {
    const { manager, runner } = persistentSetup("persistent-one");
    manager.onMailDelivered("session-other");
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
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: FAIL — no respawn happening for persistent agents.

- [ ] **Step 3: Implement respawn + shutdown flag.**

In `src/session-manager/session-manager.ts`:

Add a private field:

```ts
  private isShuttingDown = false;
```

Update `killAll` to set the flag first:

```ts
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
```

Update the `spawn` method — replace its current `onExit` handler so persistent agents respawn (note: synchronous respawn matches the test's expectation; backoff is left as a follow-up):

```ts
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
        this.deps.logger?.info("session.persistent_respawn", { agentId });
        this.spawn(agentId);
      }
    });
    this.deps.logger?.info("session.spawned", { agentId });
    return session;
  }
```

- [ ] **Step 4: Run tests.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: all pass. The first test (respawn writes no wake) should pass because `spawn` doesn't write a wake envelope — that happens only in `onMailDelivered`.

- [ ] **Step 5: Guard against respawn storms — simple cap.**

Add a per-agent respawn counter to prevent infinite tight loops if the harness itself is broken. In `session-manager.ts`, add a field:

```ts
  private respawnCounts = new Map<string, number>();
  private static readonly MAX_RESPAWNS_PER_AGENT = 10;
```

Modify the `onExit` respawn block:

```ts
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
```

- [ ] **Step 6: Add a test for the respawn cap.**

Add to the persistent-lifecycle describe block:

```ts
  it("stops respawning after MAX_RESPAWNS_PER_AGENT consecutive failures", () => {
    const { manager, runner } = persistentSetup("persistent-one");
    manager.spawnIfAbsent("persistent-one");
    // Drive 11 consecutive exits — after 10 respawns, the 11th exit should not respawn.
    for (let i = 0; i < 11; i++) {
      const last = runner.sessions[runner.sessions.length - 1]!;
      last.simulateExit({ exitCode: 1 });
    }
    // 1 initial spawn + 10 respawns = 11 total sessions; next exit stops.
    expect(runner.sessions).toHaveLength(11);
    expect(manager.hasSession("persistent-one")).toBe(false);
  });
```

- [ ] **Step 7: Run tests.**

```bash
npx vitest run src/session-manager/session-manager.test.ts
```

Expected: all pass.

- [ ] **Step 8: Run full test suite + tsc.**

```bash
npx vitest run
npm run typecheck
```

Expected: clean.

- [ ] **Step 9: Commit.**

```bash
git add src/session-manager/session-manager.ts src/session-manager/session-manager.test.ts
git commit -m "feat(session-manager): respawn persistent containers on unexpected exit (capped at 10)"
```

---

## Task A6: `session-management.ts` compose — accept configs, spawn persistent at init

**Files:**
- Modify: `src/modules/session-management/session-management.ts`
- Modify: `src/modules/session-management/session-management.test.ts`

- [ ] **Step 1: Write the failing test.**

Add to `src/modules/session-management/session-management.test.ts` (or create it if the file shape is different — check existing test):

```ts
it("spawns persistent agents at init and never spawns session agents at init", () => {
  // This is a shape-test of composeSessionManagement's init behavior.
  // Use in-memory messaging + FakeRunner.
  const runner = new FakeRunner();
  const messaging = composeMessagingForTest();  // existing helper or inline
  const logger = new CapturingLogger();
  const timerFactory = manualTimers();

  const agentConfigs = new Map<string, AgentConfig>([
    ["session-a", { ...baseCfg("session-a"), lifecycle: "session" }],
    ["persistent-b", { ...baseCfg("persistent-b"), lifecycle: "persistent" }],
  ]);

  composeSessionManagement({
    messaging,
    logger,
    runner,
    idleMinutes: 30,
    timerFactory,
    spec: (agentId, tok) => ({ imageTag: `img-${agentId}`, mounts: [], env: { T: tok } }),
    genToken: () => "tok-x",
    agentConfigs,
  });

  // Persistent agent spawned; session agent NOT.
  const spawned = runner.sessions.map((s) => s.spec.imageTag);
  expect(spawned).toEqual(["img-persistent-b"]);
});
```

(If there's no existing `composeMessagingForTest` helper, use the in-memory compose pattern the existing tests follow — consult `src/modules/session-management/session-management.test.ts` if present, or adapt from `src/mail-mcp/server.test.ts`.)

- [ ] **Step 2: Run test to verify it fails.**

```bash
npx vitest run src/modules/session-management
```

Expected: FAIL — `agentConfigs` isn't a valid dep on `composeSessionManagement`.

- [ ] **Step 3: Extend deps and init behavior.**

In `src/modules/session-management/session-management.ts`:

Import `AgentConfig`:

```ts
import type { AgentConfig } from "../../agent-config/agent-config.js";
```

Update `SessionManagementDeps`:

```ts
export interface SessionManagementDeps {
  messaging: Messaging;
  logger: Logger;
  runner: ContainerRunner;
  idleMinutes: number;
  timerFactory: TimerFactory;
  spec: (agentId: string, mcpToken: string) => DockerRunSpec;
  genToken: () => string;
  /**
   * Agent configurations keyed by agent id. Used at init to spawn any
   * persistent-lifecycle agents and to provide `lifecycleFor` lookups to
   * the session-manager.
   */
  agentConfigs: Map<string, AgentConfig>;
}
```

Update `composeSessionManagement`:

```ts
export function composeSessionManagement(deps: SessionManagementDeps): SessionManagement {
  const lifecycleFor = (agentId: string): "session" | "persistent" => {
    return deps.agentConfigs.get(agentId)?.lifecycle ?? "session";
  };

  const sessionManager = new SessionTimerManager({
    runner: deps.runner,
    idleMinutes: deps.idleMinutes,
    timerFactory: deps.timerFactory,
    spec: deps.spec,
    genToken: deps.genToken,
    logger: deps.logger,
    lifecycleFor,
  });

  deps.messaging.eventBus.subscribe<{ to: string }>("mail.delivered", (p) => {
    sessionManager.onMailDelivered(p.to);
  });
  deps.messaging.eventBus.subscribe<{ from: string }>("mail.sent", (p) => {
    sessionManager.onAgentActivity(p.from);
  });
  deps.messaging.eventBus.subscribe<{ agentId: string; tool: string }>("tool.call", (p) => {
    sessionManager.onAgentActivity(p.agentId);
  });

  // Boot-time: bring persistent agents up immediately so they are ready
  // to receive mail and so Docker's "container is running" observability
  // reflects the declared team composition.
  for (const [agentId, cfg] of deps.agentConfigs) {
    if (cfg.lifecycle === "persistent") {
      deps.logger.info("session.persistent_boot_spawn", { agentId });
      sessionManager.spawnIfAbsent(agentId);
    }
  }

  return {
    sessionManager,
    stop: () => sessionManager.killAll(),
  };
}
```

- [ ] **Step 4: Run tests.**

```bash
npx vitest run src/modules/session-management
```

Expected: the new test passes. Existing tests may need `agentConfigs: new Map()` added to deps — update them to pass an empty map where appropriate.

- [ ] **Step 5: Run full test suite + tsc.**

```bash
npx vitest run
npm run typecheck
```

Expected: clean. Some existing tests that call `composeSessionManagement` without `agentConfigs` need the field added. Fix each — they all pass `new Map()` if they don't care about the init spawn.

- [ ] **Step 6: Commit.**

```bash
git add src/modules/session-management/session-management.ts src/modules/session-management/session-management.test.ts
git commit -m "feat(session-management): spawn persistent agents at init; lifecycleFor from configs"
```

---

## Task A7: Daemon wiring — pass agent configs to composeSessionManagement

**Files:**
- Modify: `src/daemon/daemon.ts` (or wherever `composeSessionManagement` is invoked)
- Modify: `src/daemon/daemon.test.ts` as needed

- [ ] **Step 1: Locate the `composeSessionManagement` call site.**

```bash
grep -rn "composeSessionManagement" src/
```

Expected: one call in `src/daemon/daemon.ts`. Read that file around the call site.

- [ ] **Step 2: Identify where agent configs are loaded.**

The daemon already loads agent configs (for the `spec:` callback closure and for the mail-MCP identity resolution). Find the variable — likely called `agentConfigs` or similar; it's a `Map<string, AgentConfig>`.

- [ ] **Step 3: Add the new dep to the call.**

At the `composeSessionManagement(...)` call site, add `agentConfigs` to the deps object:

```ts
const sessionManagement = composeSessionManagement({
  messaging,
  logger,
  runner,
  idleMinutes,
  timerFactory,
  spec: (agentId, tok) => buildSpec({ /* existing args */ }),
  genToken: () => randomUUID(),
  agentConfigs,
});
```

- [ ] **Step 4: Run tests + tsc.**

```bash
npx vitest run
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add src/daemon/daemon.ts src/daemon/daemon.test.ts
git commit -m "feat(daemon): wire agentConfigs into session-management compose"
```

---

## Task B1: Vendor directory — add DeepAgents as submodule

**Files:**
- Create: `vendor/.gitkeep` (parent dir marker; may become redundant after submodule add)
- Modify: `.gitmodules` (created by git submodule add)

- [ ] **Step 1: Look up the latest DeepAgents stable tag.**

```bash
curl -s https://api.github.com/repos/langchain-ai/deepagents/releases/latest | grep tag_name
```

Expected: a `tag_name` like `v0.5.3` or newer. Note the tag for Step 3.

- [ ] **Step 2: Create the vendor directory.**

```bash
mkdir -p vendor
```

- [ ] **Step 3: Add DeepAgents as a submodule, pinned to the tag.**

```bash
git submodule add https://github.com/langchain-ai/deepagents.git vendor/deepagents
cd vendor/deepagents
git checkout <tag-from-step-1>
cd ../..
```

- [ ] **Step 4: Verify submodule is pinned correctly.**

```bash
git submodule status vendor/deepagents
```

Expected: output shows the SHA at the tagged commit, not `main`.

- [ ] **Step 5: Verify `.gitmodules` looks sensible.**

```bash
cat .gitmodules
```

Expected: `[submodule "vendor/deepagents"]\n\tpath = vendor/deepagents\n\turl = https://github.com/langchain-ai/deepagents.git`.

- [ ] **Step 6: Sanity-check source is present.**

```bash
ls vendor/deepagents
```

Expected: repo contents — at minimum `README.md`, `libs/deepagents/` (or the top-level package layout).

- [ ] **Step 7: Commit.**

```bash
git add .gitmodules vendor/deepagents
git commit -m "chore(vendor): add deepagents submodule pinned to <tag-from-step-1>"
```

---

## Task B2: Add Hermes as submodule

**Files:**
- Modify: `.gitmodules`

- [ ] **Step 1: Look up latest Hermes stable tag.**

```bash
curl -s https://api.github.com/repos/NousResearch/hermes-agent/releases/latest | grep tag_name
```

Expected: a tag like `v0.10.0` or newer. Note the tag.

- [ ] **Step 2: Add Hermes as a submodule, pinned.**

```bash
git submodule add https://github.com/NousResearch/hermes-agent.git vendor/hermes-agent
cd vendor/hermes-agent
git checkout <tag-from-step-1>
cd ../..
```

- [ ] **Step 3: Verify.**

```bash
git submodule status
ls vendor/hermes-agent
```

Expected: both submodules pinned; Hermes source visible (expect `run_agent.py`, `Dockerfile`, `pyproject.toml` or similar).

- [ ] **Step 4: Commit.**

```bash
git add .gitmodules vendor/hermes-agent
git commit -m "chore(vendor): add hermes-agent submodule pinned to <tag-from-step-1>"
```

---

## Task B3: README — document submodule clone step

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README install section.**

```bash
head -50 README.md
```

- [ ] **Step 2: Insert submodule note in the install section.**

Edit `README.md`. In the "Install the CLI" section, right after the Prerequisites paragraph and before the numbered list, add:

```markdown
> **Submodules.** Team Room vendors external agent harnesses (DeepAgents, Hermes) under `vendor/`. When cloning fresh, use `git clone --recurse-submodules <url>`. If you already cloned without, run `git submodule update --init --recursive` once. Submodule pointers are bumped in explicit commits (`chore(vendor): bump <harness> to <tag>`); there's no auto-update.
```

- [ ] **Step 3: Commit.**

```bash
git add README.md
git commit -m "docs(readme): document vendor/ submodule clone step"
```

---

## Task C1: Archie scaffolding — `agents/archie/` folder + config + persona stub

**Files:**
- Create: `agents/archie/agent.yaml`
- Create: `agents/archie/AGENTS.md`
- Create: `agents/archie/store/.gitkeep`

- [ ] **Step 1: Create the folder structure.**

```bash
mkdir -p agents/archie/store
touch agents/archie/store/.gitkeep
```

- [ ] **Step 2: Write `agents/archie/agent.yaml`.**

```yaml
name: archie
provider: deepagents
model: claude-opus-4-7
image_tag: teamroom-agent-archie:latest
lifecycle: persistent
subscriptions: []
```

- [ ] **Step 3: Write `agents/archie/AGENTS.md` — minimum-viable persona.**

```markdown
# Archie — the architect

You are Archie, Team Room's architect. Your job is to hold and track this
project's architecture, notice design smells, and surface patterns that
help the team make coherent decisions.

## How to work

- You run as a long-lived container. When mail arrives, your wake signal
  is a single JSON line on stdin. Check your inbox with `mail_list`
  (unreadOnly: true), read with `mail_get`, respond with `mail_reply`.
- Your home filesystem tools (ls / read_file / write_file / edit_file /
  glob / grep) operate on `/codebase` and `/store`. Treat `/codebase` as
  the team's shared working tree; treat `/store` as your private scratch.
- When answering architectural questions, read relevant files first;
  don't answer from imagined knowledge. Cite file paths and line numbers
  when you can.
- Prefer brief, specific replies. Architects who write too much are
  architects nobody reads.

## What you are NOT (yet)

This is a pre-claimed persona — you don't yet have durable memory, a full
skills inventory, or formal responsibilities. Those arrive in future
milestones. Work from what is in front of you.
```

- [ ] **Step 4: Commit.**

```bash
git add agents/archie
git commit -m "feat(agents/archie): scaffolding — agent.yaml, AGENTS.md, store/"
```

---

## Task C2: Archie shim — `agents/archie/shim.py`

**Why:** Translates Team Room's stdin wake envelopes into `create_deep_agent(...).invoke(...)` calls. Holds one LangGraph graph across wakes; uses a SQLite checkpointer keyed on thread id for per-mail-thread conversational memory.

**Files:**
- Create: `agents/archie/shim.py`

- [ ] **Step 1: Write the shim.**

Create `agents/archie/shim.py`:

```python
#!/usr/bin/env python3
"""
Archie container entrypoint.

Reads {"type":"wake","events":[...]} JSON envelopes from stdin, one per line.
On each wake, invokes the DeepAgents graph with a canned "check your inbox"
prompt; the graph itself (mail-MCP tools + DeepAgents filesystem tools) does
the real work. Errors are printed to stderr; the wake loop continues.

Environment (injected by Team Room's build-spec.ts):
  TEAMROOM_AGENT_NAME     — "archie"
  TEAMROOM_MCP_URL        — http://host.docker.internal:<port>/mcp
  TEAMROOM_MCP_TOKEN      — bearer for mail-MCP
  TEAMROOM_MODEL_BASE_URL — daemon proxy URL (OpenAI-compat)
  ANTHROPIC_BASE_URL      — daemon proxy URL (Anthropic-shape)
  ANTHROPIC_AUTH_TOKEN    — proxy-minted token
  TEAMROOM_MODEL          — e.g. "claude-opus-4-7"
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from deepagents import create_deep_agent
from langchain_anthropic import ChatAnthropic
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


WAKE_PROMPT = (
    "A new-mail wake fired. Check your inbox with mail_list (unreadOnly=true). "
    "For each unread message, use mail_get to read the full thread, do whatever "
    "reading/editing under /codebase the message asks for, and reply with "
    "mail_reply. If the inbox is empty, do nothing and report 'no mail'."
)


def load_system_prompt() -> str:
    path = Path("/AGENTS.md")
    if path.exists():
        return path.read_text()
    return "You are Archie, Team Room's architect."


async def build_agent():
    mcp_url = os.environ["TEAMROOM_MCP_URL"]
    mcp_token = os.environ["TEAMROOM_MCP_TOKEN"]
    anthropic_base = os.environ["ANTHROPIC_BASE_URL"]
    anthropic_token = os.environ["ANTHROPIC_AUTH_TOKEN"]
    model_id = os.environ.get("TEAMROOM_MODEL", "claude-opus-4-7")

    mcp_client = MultiServerMCPClient({
        "mail": {
            "transport": "streamable_http",
            "url": mcp_url,
            "headers": {"Authorization": f"Bearer {mcp_token}"},
        },
    })
    mail_tools = await mcp_client.get_tools()

    # Anthropic model routed through the Team Room proxy — OAuth lives there.
    # The proxy accepts ANTHROPIC_AUTH_TOKEN as a bearer; real OAuth is swapped
    # in upstream.
    model = ChatAnthropic(
        model=model_id,
        base_url=anthropic_base,
        api_key=anthropic_token,
    )

    # SQLite checkpointer under /store survives container restarts.
    checkpointer = AsyncSqliteSaver.from_conn_string("/store/langgraph-checkpoint.db")

    # Field name for the persona prompt — `system_prompt` vs `instructions` —
    # depends on the DeepAgents version. Step 2 of this task verifies the
    # exact signature against the vendored source.
    agent = create_deep_agent(
        model=model,
        tools=mail_tools,
        system_prompt=load_system_prompt(),
    )
    # Compile with checkpointer. create_deep_agent returns a compiled graph
    # already; if it doesn't expose a checkpointer knob, use agent.with_config
    # or compile manually. Exact call confirmed by inspecting vendored source.
    return agent, checkpointer


async def handle_wake(agent, checkpointer, envelope: dict) -> None:
    # Single thread id for all M6 wakes — lets the checkpointer accumulate
    # history across wakes. M6.1 or later can key on mail thread_id.
    thread_id = "archie-main"
    config = {"configurable": {"thread_id": thread_id}}
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": WAKE_PROMPT}]},
        config=config,
    )
    # Emit the last AI text to stderr so it shows in daemon logs.
    for message in reversed(result.get("messages", [])):
        if getattr(message, "type", None) == "ai" and getattr(message, "content", None):
            print(f"[archie] {message.content}", file=sys.stderr)
            return


async def main() -> None:
    print("[archie] boot: building agent", file=sys.stderr)
    agent, checkpointer = await build_agent()
    print("[archie] boot: ready, awaiting wake envelopes on stdin", file=sys.stderr)

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(loop=loop)
    reader_protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
    await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            print("[archie] EOF on stdin — clean exit", file=sys.stderr)
            return
        text = line.decode().strip()
        if not text:
            continue
        try:
            envelope = json.loads(text)
        except json.JSONDecodeError as e:
            print(f"[archie] invalid wake envelope: {e}", file=sys.stderr)
            continue
        try:
            await handle_wake(agent, checkpointer, envelope)
        except Exception as e:
            print(f"[archie] handle_wake failed: {e!r}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
```

The shim has an explicit comment at `create_deep_agent(...)` flagging that the DeepAgents API surface for system-prompt / checkpointer wiring must be verified against the vendored source (`vendor/deepagents/libs/deepagents/`) before the first successful container run. Fix any drift inline before committing.

- [ ] **Step 2: Inspect the vendored DeepAgents source to confirm the API shape.**

```bash
grep -rn "def create_deep_agent\|class.*DeepAgent\|messageModifier\|system_prompt" vendor/deepagents/libs/deepagents/ | head -20
```

Expected: locates `create_deep_agent`'s signature. Adjust `shim.py` to match (e.g., `instructions=` vs `system_prompt=`, whether a `checkpointer=` kwarg is accepted, or whether we compile manually).

- [ ] **Step 3: Edit `shim.py` to match the actual API and remove the verification comment once resolved.**

- [ ] **Step 4: Commit.**

```bash
git add agents/archie/shim.py
git commit -m "feat(agents/archie): shim.py — stdin wake -> DeepAgents graph invoke"
```

---

## Task C3: Archie Dockerfile

**Files:**
- Create: `agents/archie/Dockerfile`

- [ ] **Step 1: Write the Dockerfile.**

Create `agents/archie/Dockerfile`:

```dockerfile
# Archie — DeepAgents-based agent, vendored source.
# Python 3.13 (latest stable supported by DeepAgents per plan Decision 2).
# Debian-slim not Alpine (musl + npx-spawned MCP stdio children don't mix).

FROM python:3.13-slim

# Build dependencies for wheels that may need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        ripgrep \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Vendored DeepAgents source, copied into the image.
# Layout inside /opt matches vendor/deepagents/ at the commit pinned by the
# repo's submodule pointer.
COPY vendor/deepagents/ /opt/deepagents/

# Install DeepAgents from the vendored source, plus MCP adapter + Anthropic
# LangChain integration + LangGraph SQLite checkpointer.
# (DeepAgents' own deps are resolved from its pyproject.toml; this pulls them
# transitively.)
RUN pip install --no-cache-dir \
        /opt/deepagents \
        langchain-mcp-adapters \
        langchain-anthropic \
        langgraph-checkpoint-sqlite

# Our shim is the container's entrypoint.
COPY agents/archie/shim.py /app/shim.py

# /store is a mounted volume; writable by the shim for the checkpointer DB.
# /codebase is also mounted; read-write to the team's working tree.
WORKDIR /app

ENTRYPOINT ["python", "/app/shim.py"]
```

- [ ] **Step 2: Build the image.**

```bash
cd /Users/don/projects/teamroom/teamroom-worktrees/teamroom/m6-mature-agent
docker build -t teamroom-agent-archie:latest -f agents/archie/Dockerfile .
```

Expected: build succeeds. If DeepAgents' install complains about Python version bounds, drop to `python:3.12-slim` (Decision 2's fallback).

- [ ] **Step 3: Smoke-test the image in isolation (no mail daemon).**

```bash
echo '{"type":"wake","events":["boot-test"]}' | docker run --rm -i \
  -e TEAMROOM_AGENT_NAME=archie \
  -e TEAMROOM_MCP_URL=http://host.docker.internal:9999/mcp \
  -e TEAMROOM_MCP_TOKEN=fake \
  -e TEAMROOM_MODEL_BASE_URL=http://host.docker.internal:9999 \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:9999 \
  -e ANTHROPIC_AUTH_TOKEN=fake \
  -e TEAMROOM_MODEL=claude-opus-4-7 \
  -v $PWD/agents/archie/AGENTS.md:/AGENTS.md \
  -v $PWD/agents/archie/store:/store \
  teamroom-agent-archie:latest
```

Expected: container starts, prints `[archie] boot: building agent`, then `[archie] boot: ready, awaiting wake envelopes on stdin`, then fails when it actually tries to reach the fake MCP/model URLs. The "boot" and "ready" prints prove the Python+DeepAgents stack loads. Exit cleanly (ctrl-C or wait for the handle_wake failure to surface — either way, boot path is green).

- [ ] **Step 4: Commit.**

```bash
git add agents/archie/Dockerfile
git commit -m "feat(agents/archie): Dockerfile — python:3.13-slim, vendored DeepAgents"
```

---

## Task C4: Archie live smoke test — end-to-end through the daemon

**Files:**
- None (manual verification, with any fixes rolling back into C2/C3 commits)

- [ ] **Step 1: Start the daemon with Archie registered.**

```bash
teamroom serve
```

Expected log lines: `session.persistent_boot_spawn agentId=archie`, followed by Docker spawning `teamroom-archie-<token>`.

- [ ] **Step 2: Verify Archie is running.**

```bash
docker ps --filter "label=teamroom-agent-id=archie"
```

Expected: one container, status "Up".

- [ ] **Step 3: Send Archie a mail via the CLI.**

In a second terminal:

```bash
teamroom send archie "please list the files in src/modules/"
```

- [ ] **Step 4: Check Archie's inbox and reply.**

Wait ~15-30s, then:

```bash
teamroom inbox archie
```

Expected: at least one incoming mail marked as (soon-to-be) read.

```bash
teamroom inbox <the-sender-address>  # the CLI's default "human" sender address
```

Expected: Archie's reply, containing a plausible list of files from `src/modules/`.

- [ ] **Step 5: Verify the container is still running after the reply.**

```bash
docker ps --filter "label=teamroom-agent-id=archie"
```

Expected: same container still up (persistent lifecycle — no idle kill).

- [ ] **Step 6: Fix any failures inline and iterate.**

Common failure modes:
- MCP tools not discovered → check `TEAMROOM_MCP_URL` reachable from container; verify `mcp_client.get_tools()` returns a non-empty list.
- Model 401/403 → check the shim is using `ANTHROPIC_AUTH_TOKEN`, not a raw API key; verify the proxy is minting tokens.
- DeepAgents API mismatch → return to Task C2 Step 2 and align signatures.

If fixes are substantive, make a new commit per fix:

```bash
git commit -am "fix(agents/archie): <specific fix>"
```

- [ ] **Step 7: When S1-prep passes (Archie replies sensibly), move on.**

No commit for "smoke passed" — the successful run IS the verification.

---

## Task D1: Draft onboarding-an-agent-harness runbook

**Files:**
- Create: `docs/runbooks/onboarding-an-agent-harness.md`

- [ ] **Step 1: Write the draft runbook, grounded in the Archie experience.**

Create `docs/runbooks/onboarding-an-agent-harness.md`:

```markdown
# Onboarding an agent harness

This runbook covers **provisioning a new agent harness** (internal or external)
so it can participate in Team Room via mail and the shared codebase mount.
It is NOT about the agent's identity, purpose, responsibilities, or skills —
that's `agent-onboarding.md`, which remains a future artifact gated on memory
(M7) and evals (M9).

Two kinds of harness-onboarding exist:

- **Internal harness onboarding.** Team Room itself serves as the agent
  harness. Uses `src/agent-runtime/` (Node) as the container entrypoint.
  Examples: `claude-assistant`, `studio-assistant`. This runbook does not
  cover internal onboarding; see `agents/README.md`.
- **External harness onboarding.** A self-contained third-party harness
  (DeepAgents, Hermes, future) runs inside the agent's container. That's
  what this runbook is about.

## The six-item coupling contract

A new external harness must satisfy these six items to be a Team Room member:

1. **Lifecycle** declared in `agent.yaml` (`session` or `persistent`).
2. **Shim** at the container ENTRYPOINT that reads `{type:"wake","events":[...]}`
   JSON envelopes on stdin and pokes the harness's programmatic API on each wake.
3. **Mail-MCP client** configured against `TEAMROOM_MCP_URL` with bearer
   `TEAMROOM_MCP_TOKEN` (both injected by the daemon).
4. **`/codebase` mount** as the harness's filesystem / shell working directory.
5. **Model routing through the proxy** — the shim maps
   `TEAMROOM_MODEL_BASE_URL` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
   into the harness's native model-config shape.
6. **Dockerfile** — base image, deps, ENTRYPOINT = shim.

## Procedure

### Step 1: Vendor the harness source.

```bash
git submodule add https://github.com/<org>/<harness>.git vendor/<harness>
cd vendor/<harness>
git checkout <stable-tag>
cd ../..
git add .gitmodules vendor/<harness>
git commit -m "chore(vendor): add <harness> submodule pinned to <tag>"
```

### Step 2: Decide lifecycle.

- `persistent` for harnesses with meaningful per-container state (Hermes-style
  memory, long-running sessions). Container spawns at daemon boot.
- `session` for stateless-per-invocation harnesses where idle-kill is fine.

### Step 3: Create `agents/<name>/` folder.

Files:
- `agent.yaml` — name, provider (extends the enum if new), model, image_tag, lifecycle.
- `AGENTS.md` — minimum-viable persona. Mounted at `/AGENTS.md` in the container.
- `store/.gitkeep` — per-agent persistent scratch.
- Harness-specific persona files if needed (e.g., Hermes's `SOUL.md`).

### Step 4: Extend the provider enum if needed.

Edit `src/agent-config/agent-config.ts` and `src/types.ts` to add the new
provider. Add tests. Add exhaustiveness cases where needed (`worker.ts`,
`model-proxy.ts`).

### Step 5: Write the shim.

Reads stdin JSON wake envelopes. On each wake, calls into the harness's
programmatic API. Keeps the harness process alive across wakes when the
lifecycle is `persistent`.

Pattern for a Python shim:

\`\`\`python
import asyncio, json, os, sys
# ... load harness, configure from TEAMROOM_* env, build mail-MCP client ...

async def main():
    # boot setup
    while True:
        line = await reader.readline()
        if not line: return  # EOF = clean exit
        envelope = json.loads(line.decode().strip())
        await handle_wake(envelope)
\`\`\`

### Step 6: Write the Dockerfile.

Pattern:
- `FROM <base-image>` — highest-supported Python version, Debian-slim over
  Alpine (musl vs MCP stdio children).
- `COPY vendor/<harness>/ /opt/<harness>/` — vendored source.
- `RUN pip install --no-cache-dir /opt/<harness>` (and any shim-side deps).
- `COPY agents/<name>/shim.py /app/shim.py`.
- `ENTRYPOINT ["python", "/app/shim.py"]`.

### Step 7: Build and smoke-test in isolation.

```bash
docker build -t teamroom-agent-<name>:latest -f agents/<name>/Dockerfile .
echo '{"type":"wake","events":["boot-test"]}' | docker run --rm -i \
  -e TEAMROOM_AGENT_NAME=<name> \
  -e TEAMROOM_MCP_URL=http://example \
  # ... other env ...
  teamroom-agent-<name>:latest
```

Expect: boot logs to stderr, MCP/model failures once it actually tries to reach
the fake endpoints. Boot path green = image is structurally correct.

### Step 8: Live smoke test through the daemon.

Start `teamroom serve`; `teamroom send <name> "hello"`; observe mail flow and
replies. Fix any issues inline (MCP URL, token passing, model API shape).

## Harness-specific appendices

### Archie (DeepAgents)

- Base: `python:3.13-slim`.
- Install: `pip install /opt/deepagents langchain-mcp-adapters langchain-anthropic langgraph-checkpoint-sqlite`.
- Model wiring: `ChatAnthropic(base_url=ANTHROPIC_BASE_URL, api_key=ANTHROPIC_AUTH_TOKEN, model=TEAMROOM_MODEL)`.
- Mail-MCP: `MultiServerMCPClient({"mail": {"transport": "streamable_http", "url": TEAMROOM_MCP_URL, "headers": {"Authorization": f"Bearer {TEAMROOM_MCP_TOKEN}"}}})`.
- Entrypoint pattern: `create_deep_agent(model=..., tools=mail_tools, system_prompt=AGENTS.md)` → `agent.ainvoke({"messages": [...]})` per wake.
- Gotchas: DeepAgents' `system_prompt` vs `instructions` field name varies by version — check vendored source. Shell (`execute` tool) requires a sandbox backend; deferred.

### Dev (Hermes)

_To be filled in after Dev integration (Tasks E1–E6)._

## Updating and bumping

Submodule bumps are explicit, one commit per harness:

```bash
cd vendor/<harness>
git fetch
git checkout <new-tag>
cd ../..
git add vendor/<harness>
git commit -m "chore(vendor): bump <harness> to <new-tag>"
```

## Not covered by this runbook

- Identity, purpose, responsibilities, skills, context, memory for the agent
  being onboarded. That's `agent-onboarding.md`, which is still a future
  artifact.
- Choosing a persona from the roadmap's backlog. That's a project-planning
  decision, not harness plumbing.
- Evaluations (M9+).
```

- [ ] **Step 2: Commit.**

```bash
git add docs/runbooks/onboarding-an-agent-harness.md
git commit -m "docs(runbook): onboarding-an-agent-harness v1 — Archie appendix, Dev TBD"
```

---

## Task E1: Inspect Hermes source to confirm AIAgent API

**Files:**
- None (research task; output is notes used by E3)

- [ ] **Step 1: Locate `run_agent.py` in the Hermes submodule.**

```bash
find vendor/hermes-agent -name "run_agent.py"
```

Expected: path to the file, likely at the project root or under a top-level package.

- [ ] **Step 2: Read the AIAgent class + entrypoint.**

```bash
grep -n "class AIAgent\|def run_conversation\|async def\|def __init__" $(find vendor/hermes-agent -name "run_agent.py")
```

Read the full file if needed.

- [ ] **Step 3: Identify the three operations the shim needs.**

Document in a scratch file (`/tmp/hermes-notes.md`) or in your head:

1. **Constructor signature** — how to build an `AIAgent`: what config, provider keys, etc.
2. **Single-turn call** — the method name for "send this text, return the reply." Likely `run_conversation(...)` or `step(...)` or `ainvoke(...)`.
3. **State / session persistence** — does AIAgent hold state internally across calls, or do we need to pass a session id / conversation history each time?

- [ ] **Step 4: Fallback decision: if `AIAgent` is hard to drive directly, plan for ACP adapter.**

If `AIAgent`'s surface is tightly coupled to Hermes's TUI / CLI and doesn't expose a clean "send a prompt, get a reply" method, use the ACP stdio adapter pattern instead:

```bash
grep -rn "acp_adapter\|ACP\|jsonrpc" vendor/hermes-agent | head -20
```

Note the ACP entrypoint for E3.

- [ ] **Step 5: No commit — research task.** Carry findings into Task E3.

---

## Task E2: Dev scaffolding — `agents/dev/` folder + persona + SOUL.md

**Files:**
- Create: `agents/dev/agent.yaml`
- Create: `agents/dev/AGENTS.md`
- Create: `agents/dev/SOUL.md`
- Create: `agents/dev/store/.gitkeep`

- [ ] **Step 1: Create folder structure.**

```bash
mkdir -p agents/dev/store
touch agents/dev/store/.gitkeep
```

- [ ] **Step 2: Write `agents/dev/agent.yaml`.**

```yaml
name: dev
provider: hermes
model: claude-sonnet-4-6
image_tag: teamroom-agent-dev:latest
lifecycle: persistent
subscriptions: []
```

- [ ] **Step 3: Write `agents/dev/AGENTS.md` — human-facing description.**

```markdown
# Dev — the developer

Team Room's developer agent, running on the Nous Research Hermes harness.

Dev's persona lives in `SOUL.md` (Hermes's slot-1 system prompt). This file
describes the instance for humans and other agents reading the team layout.

## What Dev does

Writes code, fixes bugs, reviews diffs when asked. Reads mail, checks the
shared `/codebase`, replies in-thread. Uses Hermes's built-in terminal and
filesystem tools.

## Running

Persistent container — spawned at daemon boot, restarted on unexpected
exit. No idle timeout. Model: `claude-sonnet-4-6` routed through the Team
Room proxy.
```

- [ ] **Step 4: Write `agents/dev/SOUL.md` — Hermes's persona file.**

```markdown
You are Dev, Team Room's developer agent, running on Hermes.

You are a long-lived teammate. New-mail wakes reach you via stdin envelopes;
your shim translates them into prompts. Your job is to write code, fix
bugs, and review diffs when teammates ask. Use Hermes's built-in terminal
and filesystem tools; your working directory is /codebase (a shared mount
with your teammates). Mail tools arrive via the MCP server "teamroom_mail"
— call them via the mcp_teamroom_mail_* prefix.

Reply briefly. Don't restate what was asked. Cite file:line when you touch
code. When unsure, ask — don't guess.

This is a pre-claimed persona. You don't yet have durable memory tuned
for Team Room, a full skills inventory, or explicit responsibilities beyond
"be a helpful developer on the team." That work arrives in a future
milestone. Work from what is in front of you.
```

- [ ] **Step 5: Commit.**

```bash
git add agents/dev
git commit -m "feat(agents/dev): scaffolding — agent.yaml, AGENTS.md, SOUL.md, store/"
```

---

## Task E3: Dev shim — `agents/dev/shim.py`

**Files:**
- Create: `agents/dev/shim.py`

- [ ] **Step 1: Write the shim.** Use the AIAgent API shape confirmed in E1.

Create `agents/dev/shim.py`:

```python
#!/usr/bin/env python3
"""
Dev container entrypoint.

Reads {"type":"wake","events":[...]} JSON envelopes from stdin, one per line.
On each wake, asks Hermes's AIAgent to check its inbox via mail-MCP and reply.
Holds one AIAgent instance across wakes — Hermes's persistent memory and
skills accumulate on disk under ~/.hermes/ (mounted as /store).

Environment (injected by Team Room's build-spec.ts):
  TEAMROOM_AGENT_NAME     — "dev"
  TEAMROOM_MCP_URL        — http://host.docker.internal:<port>/mcp
  TEAMROOM_MCP_TOKEN      — bearer for mail-MCP
  ANTHROPIC_BASE_URL      — daemon proxy URL
  ANTHROPIC_AUTH_TOKEN    — proxy-minted token
  TEAMROOM_MODEL          — e.g. "claude-sonnet-4-6"
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

# IMPORTANT: adjust this import after confirming the actual AIAgent API
# shape from vendor/hermes-agent/run_agent.py (Task E1).
from hermes_cli.run_agent import AIAgent  # placeholder import path


WAKE_PROMPT = (
    "A new-mail wake fired. Check your inbox with mcp_teamroom_mail_mail_list "
    "(unreadOnly=true). For each unread message, use mcp_teamroom_mail_mail_get "
    "to read the full thread, do whatever reading/editing under /codebase the "
    "message asks for, and reply with mcp_teamroom_mail_mail_reply. If the "
    "inbox is empty, do nothing and log 'no mail'."
)


def build_agent() -> AIAgent:
    # Hermes reads its config from ~/.hermes/config.yaml which is prepared
    # at image-build time to point at the Team Room mail-MCP + model proxy.
    # AIAgent(...) constructor signature per E1 research — adjust as needed.
    return AIAgent(
        home_dir=os.environ.get("HERMES_HOME", "/store"),
        config_path=os.environ.get("HERMES_CONFIG", "/store/config.yaml"),
    )


async def handle_wake(agent: AIAgent, envelope: dict) -> None:
    # Per E1: use whichever method is the "send prompt, get reply" one.
    # For AIAgent.run_conversation(prompt=...) this would be:
    response = await agent.run_conversation(WAKE_PROMPT)
    if response:
        print(f"[dev] {response}", file=sys.stderr)


async def main() -> None:
    print("[dev] boot: building agent", file=sys.stderr)
    agent = build_agent()
    print("[dev] boot: ready, awaiting wake envelopes on stdin", file=sys.stderr)

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(loop=loop)
    reader_protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
    await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            print("[dev] EOF on stdin — clean exit", file=sys.stderr)
            return
        text = line.decode().strip()
        if not text:
            continue
        try:
            envelope = json.loads(text)
        except json.JSONDecodeError as e:
            print(f"[dev] invalid wake envelope: {e}", file=sys.stderr)
            continue
        try:
            await handle_wake(agent, envelope)
        except Exception as e:
            print(f"[dev] handle_wake failed: {e!r}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Adjust imports and call sites to match E1's findings.**

Specifically: the `from hermes_cli.run_agent import AIAgent` line must match the vendored source's actual module path. The `agent.run_conversation(WAKE_PROMPT)` call must match the actual method name (might be `chat`, `step`, `ask`, etc.).

If E1 concluded ACP is cleaner than `AIAgent`, rewrite the shim to spawn Hermes's ACP stdio adapter as a subprocess and send JSON-RPC requests per wake. Wipe the `AIAgent` path.

- [ ] **Step 3: Commit.**

```bash
git add agents/dev/shim.py
git commit -m "feat(agents/dev): shim.py — stdin wake -> Hermes AIAgent"
```

---

## Task E4: Dev `config.yaml` preseed for Hermes

**Files:**
- Create: `agents/dev/config.yaml`

- [ ] **Step 1: Write the preseeded Hermes config.**

Create `agents/dev/config.yaml`:

```yaml
# Preseeded Hermes config. Mounted into the container at /store/config.yaml
# (Hermes's home = /store). Team Room's build-spec.ts injects the env vars
# consumed by the shim; the shim starts AIAgent with this config path.

model:
  provider: anthropic
  name: claude-sonnet-4-6
  # Anthropic proxy URL and bearer come from ANTHROPIC_BASE_URL /
  # ANTHROPIC_AUTH_TOKEN; the shim passes them in to AIAgent at build time.

terminal:
  backend: local
  cwd: /codebase

mcp_servers:
  teamroom_mail:
    transport: streamable_http
    url: "${TEAMROOM_MCP_URL}"
    headers:
      Authorization: "Bearer ${TEAMROOM_MCP_TOKEN}"
    # Limit to the seven mail tools; don't expose prompts/resources.
    tools:
      include:
        - "mail.list"
        - "mail.get"
        - "mail.send"
        - "mail.reply"
        - "mail.mark_read"
        - "mail.archive"
        - "mail.delete"
```

**Note:** if Hermes's config parser does NOT do env-var substitution natively, the shim is responsible for rendering the config at boot (read file, substitute `${...}`, write out to a temp path, pass that path to `AIAgent`). Verify during E1 / E6 — if env substitution works, the file above is good as-is; if not, adjust the shim to render.

- [ ] **Step 2: Commit.**

```bash
git add agents/dev/config.yaml
git commit -m "feat(agents/dev): preseeded Hermes config.yaml with mail-MCP + proxy"
```

---

## Task E5: Dev Dockerfile

**Files:**
- Create: `agents/dev/Dockerfile`

- [ ] **Step 1: Write the Dockerfile — build fresh from vendored source.**

Create `agents/dev/Dockerfile`:

```dockerfile
# Dev — Hermes-based agent, vendored source.
# Python 3.13 (Hermes's upstream pin per plan Decision 2).
# Reference Nous's upstream Dockerfile (vendor/hermes-agent/Dockerfile) for
# system-dep list; we install a minimum subset here and rebuild fresh from
# the vendored source rather than layering on top of Nous's image.

FROM python:3.13-slim

# System deps Hermes expects. Debian 13.4 / Playwright / Chromium are NOT
# required for M6 acceptance (mail + FS-only flows); add them if a future
# acceptance scenario needs web tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        ripgrep \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Vendored Hermes source.
COPY vendor/hermes-agent/ /opt/hermes-agent/

# Install Hermes from source. Exact command depends on whether Hermes uses
# poetry, uv, or setuptools — inspect vendor/hermes-agent/pyproject.toml
# and adapt. Most likely one of:
#   (a) pip install /opt/hermes-agent
#   (b) cd /opt/hermes-agent && uv sync
# This plan assumes (a). Switch if E1/E6 shows (b) is required.
RUN pip install --no-cache-dir /opt/hermes-agent

# Hermes's persistent home ends up at /store via the volume mount.
ENV HERMES_HOME=/store
ENV HERMES_CONFIG=/store/config.yaml

# Our shim is the container's ENTRYPOINT — NOT Hermes's own `hermes` binary.
COPY agents/dev/shim.py /app/shim.py
COPY agents/dev/config.yaml /opt/dev-config/config.yaml

# At runtime, copy the preseeded config into /store if not already present
# (first-run bootstrap). Use a tiny bootstrap wrapper.
COPY agents/dev/bootstrap.sh /app/bootstrap.sh
RUN chmod +x /app/bootstrap.sh

WORKDIR /app

ENTRYPOINT ["/app/bootstrap.sh"]
```

- [ ] **Step 2: Write the bootstrap shell script.**

Create `agents/dev/bootstrap.sh`:

```bash
#!/bin/sh
# First-run bootstrap: ensure /store/config.yaml exists. Copy the baked-in
# preseed if not. Then exec the shim.
set -e

if [ ! -f /store/config.yaml ]; then
    cp /opt/dev-config/config.yaml /store/config.yaml
fi

exec python /app/shim.py
```

- [ ] **Step 3: Build the image.**

```bash
docker build -t teamroom-agent-dev:latest -f agents/dev/Dockerfile .
```

Expected: build succeeds. If `pip install /opt/hermes-agent` fails, inspect Hermes's `pyproject.toml` and switch to `uv` or whichever builder is declared.

- [ ] **Step 4: Smoke-test the image in isolation.**

```bash
echo '{"type":"wake","events":["boot-test"]}' | docker run --rm -i \
  -e TEAMROOM_AGENT_NAME=dev \
  -e TEAMROOM_MCP_URL=http://host.docker.internal:9999/mcp \
  -e TEAMROOM_MCP_TOKEN=fake \
  -e TEAMROOM_MODEL_BASE_URL=http://host.docker.internal:9999 \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:9999 \
  -e ANTHROPIC_AUTH_TOKEN=fake \
  -e TEAMROOM_MODEL=claude-sonnet-4-6 \
  -v $PWD/agents/dev/AGENTS.md:/AGENTS.md \
  -v $PWD/agents/dev/SOUL.md:/SOUL.md \
  -v $PWD/agents/dev/store:/store \
  teamroom-agent-dev:latest
```

Expected: boot logs to stderr; fails when it reaches the fake URLs. Boot green = structurally correct.

- [ ] **Step 5: Commit.**

```bash
git add agents/dev/Dockerfile agents/dev/bootstrap.sh
git commit -m "feat(agents/dev): Dockerfile + bootstrap.sh — python:3.13-slim, vendored Hermes"
```

---

## Task E6: Dev live smoke test

**Files:**
- None (manual verification, with fixes rolling back into E3–E5)

- [ ] **Step 1: Start daemon with Dev registered alongside Archie.**

```bash
teamroom serve
```

Expected: `session.persistent_boot_spawn` logs for BOTH archie and dev.

- [ ] **Step 2: Verify both containers running.**

```bash
docker ps --filter "label=teamroom-agent=true"
```

Expected: two containers, both status "Up".

- [ ] **Step 3: Send Dev a mail.**

```bash
teamroom send dev "please show me the first 20 lines of src/types.ts"
```

- [ ] **Step 4: Check Dev's reply.**

```bash
teamroom inbox <sender-address>
```

Expected: Dev replies with the first 20 lines (plausibly — exact content depends on what's in src/types.ts).

- [ ] **Step 5: Fix failures inline.**

Common failure modes:
- Hermes AIAgent constructor mismatch → Task E1/E3 adjustment.
- mcp_servers env substitution not working → render config in the shim instead of relying on Hermes.
- Model API 401 → same anthropic proxy token fix as Archie path.

Commit any fixes:

```bash
git commit -am "fix(agents/dev): <specific fix>"
```

- [ ] **Step 6: When Dev replies sensibly, move on.**

---

## Task F1: Runbook consolidation — fold Dev learnings

**Files:**
- Modify: `docs/runbooks/onboarding-an-agent-harness.md`

- [ ] **Step 1: Review what's changed since Task D1.**

What knowledge did E1–E6 produce that the draft runbook was missing?

Typical candidates:
- Hermes AIAgent vs ACP adapter decision and why.
- The bootstrap.sh pattern for copying preseeded config on first run.
- Env-var substitution in harness config files (how to handle if not native).
- Any Dockerfile adjustments for Python builder tools (uv, poetry, etc.).
- Any MCP tool-naming gotchas (e.g., Hermes's `mcp_teamroom_mail_*` prefix).

- [ ] **Step 2: Fill in the "### Dev (Hermes)" appendix.**

Replace the placeholder "_To be filled in after Dev integration..._" with the actual learnings. Structure mirrors the Archie appendix: base, install, model wiring, mail-MCP, entrypoint pattern, gotchas.

- [ ] **Step 3: Generalize the main procedure where Dev's experience exposed gaps.**

For example: if E4 required renaming `/store/config.yaml` to a harness-specific location, update Step 3 / Step 6 of the main procedure. If env-var substitution in config files is a universal concern, add a "Configuration files and env-var substitution" section.

- [ ] **Step 4: Add a "Non-trivial surprises from M6" log at the bottom.**

```markdown
## Non-trivial surprises from M6

Captured as tabled items during execution and folded here:

- (list specific surprises encountered during Archie / Dev work)
```

- [ ] **Step 5: Sweep `docs/tabled.md`.**

Move any M6-runbook-relevant tabled entries into this runbook. Remove them from `tabled.md`.

- [ ] **Step 6: Commit.**

```bash
git add docs/runbooks/onboarding-an-agent-harness.md docs/tabled.md
git commit -m "docs(runbook): fold Dev learnings into onboarding-an-agent-harness.md"
```

---

## Task G1: Acceptance S1 — Archie participates in mail + codebase

**Files:**
- None (manual verification)

- [ ] **Step 1: Ensure a clean daemon + both agents running.**

```bash
teamroom serve
docker ps --filter "label=teamroom-agent=true"
```

Expected: archie + dev, both "Up".

- [ ] **Step 2: Send Archie a codebase-grounded question from claude-assistant.**

```bash
teamroom chat claude-assistant
```

At the REPL prompt:

```
send a mail to archie asking for an architectural summary of how src/mail-mcp/ is composed and where it runs in the host/container split
```

- [ ] **Step 3: Observe Archie processing and replying.**

```bash
teamroom inbox archie
teamroom thread <thread-id>
```

Expected: Archie reads the mail, reads relevant files under `/codebase`, replies with a concrete summary citing specific files / modules.

- [ ] **Step 4: Mark S1 pass/fail.**

PASS if Archie's reply is on-topic, cites code, and lands in the correct thread.

---

## Task G2: Acceptance S2 — Dev participates in mail + codebase

**Files:**
- None

- [ ] **Step 1: Send Dev a codebase-grounded request.**

```bash
teamroom chat claude-assistant
```

```
send a mail to dev asking it to read src/types.ts and propose one safe, small rename refactor — no actual changes, just the proposal with file:line references
```

- [ ] **Step 2: Observe Dev processing and replying.**

```bash
teamroom thread <thread-id>
```

Expected: Dev replies with a concrete rename proposal, file:line references.

- [ ] **Step 3: Mark S2 pass/fail.**

---

## Task G3: Acceptance S3 — Archie ↔ Dev cross-harness mail

**Files:**
- None

- [ ] **Step 1: Start a cross-harness conversation from either agent.**

Via `teamroom chat archie`:

```
send a mail to dev asking it to look at src/agent-runtime/worker.ts and tell you which provider cases are missing the deepagents / hermes branches after M6's changes
```

- [ ] **Step 2: Wait for the full round-trip.**

Archie sends → Dev reads → Dev replies → Archie reads the reply → (optional) Archie replies again.

- [ ] **Step 3: Verify via thread view.**

```bash
teamroom thread <thread-id>
```

Expected: at least one full Archie→Dev→Archie round-trip, both replies substantive and codebase-grounded.

- [ ] **Step 4: Mark S3 pass/fail.**

---

## Task G4: Acceptance S4 — Daemon restart + container respawn resilience

**Files:**
- None

- [ ] **Step 1: With everything running, record current container IDs.**

```bash
docker ps --filter "label=teamroom-agent=true" --format '{{.ID}} {{.Names}}'
```

Note the container IDs for archie and dev.

- [ ] **Step 2: Gracefully stop the daemon.**

Ctrl-C in the `teamroom serve` terminal.

- [ ] **Step 3: Verify containers are gone.**

```bash
docker ps --filter "label=teamroom-agent=true"
```

Expected: no containers (`killAll` stopped them cleanly on shutdown).

- [ ] **Step 4: Restart the daemon.**

```bash
teamroom serve
```

Expected: `session.persistent_boot_spawn` for both archie and dev in the log.

- [ ] **Step 5: Verify containers are up and REACHABLE.**

```bash
docker ps --filter "label=teamroom-agent=true"
teamroom send archie "hello post-restart"
# wait
teamroom inbox <sender-address>
```

Expected: Archie replies sensibly. Same for Dev.

- [ ] **Step 6: Trigger an in-container crash and verify respawn.**

```bash
# Kill archie's container
docker kill $(docker ps --filter "label=teamroom-agent-id=archie" -q)
sleep 3
docker ps --filter "label=teamroom-agent-id=archie"
```

Expected: a NEW container for archie, status "Up" — the daemon's `onExit` handler respawned it. Daemon log should show `session.persistent_respawn agentId=archie count=1`.

- [ ] **Step 7: Verify post-respawn reachability.**

```bash
teamroom send archie "hello post-respawn"
# check inbox
```

Expected: Archie still replies.

- [ ] **Step 8: Mark S4 pass/fail.**

---

## Self-review against spec

After executing the plan through Task G4, run this checklist:

**Spec coverage:**
- [ ] §3.1 (4 in-scope items) all implemented? substrate (A1–A7), agents (C/E), runbook (D1+F1), acceptance (G1–G4). ✓
- [ ] §3.2 (5 out-of-scope items) respected? No agent-onboarding rewrite (agent-onboarding.md untouched), no cronjob-for-mail, no proxy extensions added, no git-gating on acceptance, no persona-level skills. ✓
- [ ] §4.1 (six-item contract) codified in the runbook? Verify in onboarding-an-agent-harness.md. ✓
- [ ] §5 (substrate) all changes landed? A1 lifecycle, A2 provider enum, §5.3 corrected via Task 0.1, no model-proxy extensions needed (Decision 1). ✓
- [ ] §6 (per-harness deliverables) all files created? agent.yaml, Dockerfile, shim.py, AGENTS.md, store/ for both; SOUL.md + config.yaml for Dev. ✓
- [ ] §6.3 (source tracking) — submodules at vendor/<harness>/. ✓
- [ ] §7 (model routing) — both shims route through the Anthropic proxy. ✓
- [ ] §8 (invocation) — stdin wake envelope protocol used by both shims. ✓
- [ ] §11 (acceptance S1–S4) all executed. ✓
- [ ] §13 (pre-M6 verification) — Task 0.2. ✓
- [ ] §14 (open questions) all decided and recorded in "Plan-time decisions locked in this plan" table. ✓

**Placeholder scan:**
- [ ] Grep the plan for `TODO|TBD|FIXME`. Task C2's shim has a verification comment at `create_deep_agent(...)` resolved in Step 2. Task E3 Step 1's `from hermes_cli.run_agent import AIAgent` is a placeholder import path resolved in Step 2. "Dev TBD" appears once in the Task D1 commit message describing mid-plan runbook state (valid). No other placeholders expected.

**Type consistency:**
- [ ] `lifecycle: session | persistent` used identically in `AgentConfig`, `SessionTimerManagerDeps.lifecycleFor`, `agent.yaml`. ✓
- [ ] `Provider` enum updated consistently in `src/types.ts` and `agent-config.ts` validator. ✓
- [ ] `spawnIfAbsent` method signature matches between session-manager.ts and its test harness. ✓

---

## Post-acceptance: milestone close

Not implementation steps; milestone-close work for after Task G4:

- Write retro (`writing-retros` skill) — four-section format per `docs/ways-of-working.md`.
- Write as-built (`writing-as-built` skill) — single permanent record.
- Purge this plan + the spec (`docs/specs/*m6*` + `docs/plans/*m6*`) — the M5 close pattern (commit `be857fd`).
- Sweep `docs/tabled.md` and roll retained items into `docs/roadmap.md#backlog`.
- Update `docs/roadmap.md` with M6 status and (if applicable) M6.1 entry if Dev slipped.
