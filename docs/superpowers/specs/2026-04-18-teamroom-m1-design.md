# Team Room — Milestone 1 Design

**Date:** 2026-04-18
**Status:** Design approved; implementation plan to follow.
**Supersedes:** §5 (M1) of `team-room-context.md` where they conflict.

---

## 1. Summary

M1 delivers the smallest end-to-end slice of Team Room: a long-running orchestrator daemon, a single hand-configured agent running inside fresh Docker containers, a terminal-only channel, and the observability plumbing needed to see what the stack is doing. It exists to prove the shape of the core runtime so the downstream multi-agent milestones (credential proxy, event store, memory, scheduling, evals) can extend it rather than refactor it.

## 2. Exit criteria

M1 is done when:

- A message typed into `teamroom send "<text>"` is processed by the hand-configured agent inside a fresh Docker container and the agent's reply appears in `teamroom tail`.
- The agent is configured by hand (files on disk). There is no onboarding tooling and no `agent add` command.
- The stack has structured JSON logs with a trace ID per turn spanning CLI → daemon → container → reply.
- The daemon can be killed at any point; on restart, in-flight turns are reconciled deterministically (no silent loss, no double execution).
- Every effectful dependency is accessible via an interface with both a production implementation and an in-memory real test implementation. The full test suite runs without a mocking library.

Out of M1 (see §12 for the full deferred list): keep-alive containers, agent onboarding tooling, multi-model proxy, event store with topics and durable delivery, inter-agent messaging, memory, scheduling, evals, real chat channels.

## 3. Architectural principles

Four principles shape every decision in this spec. They are meant to be applied in M1 and carried forward into later milestones.

**Minimize long-running process dependencies.** The orchestrator has no runtime dependencies on other long-running processes. SQLite is in-process; Docker spawns ephemeral containers only; no separate broker, cache, or queue. When an in-process option can credibly do the job, use it.

**See only as far as needed, not further.** The first instance of anything is allowed to be hand-crafted and imperfect. It exists to surface the shape, not to define the pattern. Formalization (runbooks, scaffolds, tooling, abstractions) arrives at N=2. The first agent is created by editing files; the "add agent" process becomes a runbook once agent #2 lands.

**Nothing silent, nothing inconsistent, nothing crashes.** Every failure surfaces in logs and `tail`. The database is never left with a turn marked `running` that has no live container. Once the daemon or a container has started, it does not die from an unhandled exception; failures become errored turns and warn-level logs, not process exits. Boot-time failures still exit so the OS supervisor can restart the daemon.

**Design for testability via dependency injection.** Every effectful dependency lives behind an interface that the daemon composes at a single startup site. Tests compose the same interfaces using in-memory real implementations. No `jest.mock`, `vi.mock`, or module-level mocking. Testability is an architectural concern, not a testing concern.

## 4. System architecture

### 4.1 Processes

- **Daemon** — long-running Node.js process (`teamroom serve`). Owns SQLite, polls for pending inbound messages, spawns agent containers, routes outbound messages back. Procedural; no LLM in the hot path.
- **CLI** — short-lived Node.js commands (`teamroom send`, `teamroom tail`, `teamroom status`). Talk to SQLite directly. The daemon is not required for `send` to succeed (messages queue); it is required for turns to *process*.
- **Agent container** — Docker, fresh per turn. Receives a prompt envelope on stdin, runs Claude Agent SDK with the persisted session ID, emits reply events on stdout, exits.

### 4.2 Boundaries

- CLI ↔ Daemon: indirect, via SQLite and the `NotifyBus`. No HTTP, no sockets, no IPC.
- Daemon ↔ Container: stdin (one JSON envelope, closed) and stdout (JSONL event stream). Identity and trace context pass through environment variables. File IPC from container to daemon is not used at M1; `agents/<name>/` is the only writable mount.
- Container ↔ External: only the Anthropic API. `ANTHROPIC_API_KEY` is an env var at M1; the credential proxy lands in M2.

### 4.3 Deployment assumptions

Single machine, single filesystem, single SQLite file. Distributed deployment is explicitly not an M1 concern. On macOS the daemon is supervised by launchd; on Linux by systemd. The supervisor is the watchdog; there is no internal restart logic.

## 5. File and folder layout

```
<repo-root>/
├── agents/
│   └── <agent-name>/              # one folder per agent (M1: exactly one)
│       ├── Dockerfile             # per-agent image (base extraction waits for agent #2)
│       ├── agent.yaml             # name, model, image tag, prompt path
│       ├── CLAUDE.md              # system prompt / instructions
│       ├── session-id             # gitignored — Claude session ID, written by container
│       └── store/                 # gitignored — writable scratch, mounted into container
├── src/
│   ├── daemon/                    # orchestrator
│   ├── cli/                       # teamroom send / tail / serve / status
│   └── agent-runtime/             # in-container entrypoint shim; COPY'd into image
├── docs/
│   └── superpowers/specs/         # this document lives here
├── data/                          # gitignored
│   ├── teamroom.db                # SQLite
│   ├── teamroom.pid               # daemon PID file
│   ├── bus/                       # NotifyBus state
│   │   ├── events.jsonl
│   │   └── .notify
│   └── logs/
│       └── teamroom-YYYY-MM-DD.jsonl
├── package.json
└── tsconfig.json
```

The agent folder is the single unit of per-agent state. Everything the agent "has" lives there. Copying the folder is the closest thing to "copy an agent." Checked into git: `Dockerfile`, `agent.yaml`, `CLAUDE.md`. Gitignored: `session-id`, `store/`.

Per-agent Dockerfile (not a shared base). When agent #2 arrives and duplication becomes real, a base image is extracted. `src/agent-runtime/` is copied into the image at build time; the build context is the repo root. The dev-loop cost of rebuilding on runtime change is accepted at M1 and revisited only if it becomes painful.

## 6. Database schema

Three tables. SQLite in WAL mode. All timestamps are ISO-8601 strings.

```sql
-- One row per registered agent. M1 has exactly one.
CREATE TABLE agents (
  id           TEXT PRIMARY KEY,       -- slug, matches folder name
  config_path  TEXT NOT NULL,          -- absolute path to agents/<name>/
  created_at   TEXT NOT NULL
);

-- Every inbound + outbound message, regardless of channel.
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,        -- uuid
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  channel     TEXT NOT NULL,           -- 'cli' at M1
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body        TEXT NOT NULL,
  turn_id     TEXT REFERENCES turns(id),   -- null for inbound until picked up
  trace_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX idx_messages_direction_created ON messages(direction, created_at);

-- A turn = one inbound message → 0..N outbound messages.
CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL REFERENCES agents(id),
  inbound_message_id   TEXT NOT NULL REFERENCES messages(id),
  status               TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  container_id         TEXT,
  error                TEXT,           -- populated on status='error'
  trace_id             TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_turns_status ON turns(status);
```

`turns` is separate from `messages` because they represent different concerns: messages are transport (what text moved), turns are processing (what work ran, where, with what outcome). The split keeps trace context, container lifecycle, and timing on a single row, supports one-inbound-to-many-outbound cleanly (Claude Agent SDK streams + tool-use interleaving), and makes crash recovery a single query. The alternative — status columns on `messages` — was rejected because it mixes transport with processing and would be awkward to retrofit when retries and multi-outbound behavior arrive.

The Claude session ID persists only at `agents/<name>/session-id`. A `sessions` table was considered and dropped: a file is sufficient for M1, and the container writes it atomically from inside the mount without needing DB access. A DB table is introduced later if and when cross-agent session queries or audit history justify it.

Migrations are numbered SQL files under `src/daemon/migrations/NNN_description.sql`, applied on daemon startup. No migration framework at M1.

## 7. Turn lifecycle

```
  [CLI: teamroom send "hi"]
        │ 1. generate traceId + messageId
        │ 2. INSERT messages (direction=in, turn_id=null)
        │ 3. return; print traceId for correlation
        ▼
  [SQLite: messages]
        │      (daemon polls: WHERE direction='in' AND turn_id IS NULL)
        ▼
  [Daemon: pick-up]
        │ 4. INSERT turns (status='pending', trace_id=<same>)
        │ 5. UPDATE messages SET turn_id=? WHERE id=?
        │ 6. Read agent.yaml + session-id
        │ 7. UPDATE turns SET status='running', container_id=?, started_at=now
        │ 8. docker run --rm -i <agent-image>
        │      env: TEAMROOM_TRACE_ID, TEAMROOM_TURN_ID, TEAMROOM_AGENT_NAME,
        │           CLAUDE_SESSION_ID, ANTHROPIC_API_KEY
        │      stdin: one JSON line {prompt, messageId, turnId, traceId}; then close
        ▼
  [Container: agent-runtime]
        │ 9.  Invoke Claude SDK with prior session ID
        │ 10. For each reply chunk: emit JSON line on stdout
        │       {"type":"reply","body":"...","messageId":"..."}
        │     Interim status/log events emitted similarly with other type values.
        │ 11. Persist new session ID to /agent/session-id
        │ 12. Exit 0
        ▼
  [Daemon: stdout consumer]
        │ 13. On type=reply: INSERT messages (direction=out, turn_id, trace_id)
        │                  + bus.publish({type:"message.outbound", ...})
        │ 14. On type=log/status: merge into daemon log stream
        │ 15. On container exit 0: UPDATE turns SET status='done', finished_at=now
        │ 15'.On exit≠0 or timeout: UPDATE turns SET status='error', error=<summary>
        ▼
  [CLI: teamroom tail]
        │ 16. subscribed to bus; on event, fetch body from messages and render
        ▼
  [User]
```

A single turn corresponds to one inbound message and produces zero or more outbound messages plus exactly one terminal state (`done` or `error`).

## 8. CLI surface

```
teamroom serve                     # run daemon in foreground
teamroom send <text>               # queue an inbound message; print trace id; exit
teamroom tail [--json] [--verbose] # stream outbound messages as they arrive
teamroom status                    # daemon up?, pending/running turn counts, last turn time
```

`send` and `tail` do not take `--agent` at M1 because there is one agent; both flags are added when agent #2 lands. `send` succeeds regardless of whether the daemon is running (message queues; a warning is printed if the daemon is absent). `tail` works regardless of daemon state — it subscribes to the `NotifyBus` and reads bodies from the DB on notification; with no daemon, it simply receives nothing new.

The CLI is intentionally thin. Each command parses arguments and delegates to a service function. Business logic does not live in `src/cli/`. This is the testability principle applied to the front end: CLI code doesn't need direct tests because it carries no logic.

## 9. Container contract

The interface between daemon and agent runtime.

- **Image:** built from `agents/<name>/Dockerfile`. Tag derived from agent name (e.g., `teamroom-agent-corsa:latest`). Daemon builds on first run if the image is missing. How explicit rebuilds are triggered (a standalone CLI helper vs. `--rebuild` flag vs. manual `docker build`) is resolved in the implementation plan — see §15.
- **Mounts:** `agents/<name>/` mounted at `/agent` writable. Nothing else.
- **Environment:** `TEAMROOM_TRACE_ID`, `TEAMROOM_TURN_ID`, `TEAMROOM_AGENT_NAME`, `CLAUDE_SESSION_ID` (may be empty on first turn), `ANTHROPIC_API_KEY`.
- **Stdin:** exactly one JSON line = `{prompt, messageId, turnId, traceId}`. Daemon closes stdin after writing.
- **Stdout:** JSON Lines. Each line is an event with a `type` discriminator:
  - `{"type":"reply","body":"...","messageId":"..."}` — persisted as an outbound message.
  - `{"type":"status","phase":"tool_use","name":"..."}` — logged by daemon.
  - `{"type":"log","level":"info","msg":"..."}` — merged into daemon logs.
  - Unknown types are warn-logged and dropped.
- **Stderr:** unstructured; captured as log text.
- **Exit:** 0 on clean completion. Non-zero marks the turn errored; the exit code and last ~2KB of stderr are captured in `turns.error`.
- **Timeout:** default 5 minutes per turn, configurable via daemon env. On timeout, the daemon issues `docker kill`; the turn moves to `error` with `error='timeout'`.

## 10. NotifyBus

`tail` does not query the database for new outbound messages directly. It goes through a `NotifyBus` abstraction so that M3's event store is an implementation swap, not a codebase-wide refactor.

**Interface (TypeScript, roughly):**

```ts
interface BusEvent {
  id: string;
  type: string;                    // e.g. "message.outbound", "turn.errored"
  ts: string;                      // ISO-8601
  [k: string]: unknown;
}

interface NotifyBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(filter?: (e: BusEvent) => boolean): AsyncIterable<BusEvent>;
  close(): Promise<void>;
}
```

**M1 production implementation — `FileNotifyBus`:**

- `publish()` appends the event to `data/bus/events.jsonl` and touches `data/bus/.notify`.
- `subscribe()` uses `fs.watch` on the notify file with a 500ms poll fallback (because `fs.watch` misses events on some filesystems). Subscribers read new lines from `events.jsonl` after each signal and deduplicate by `event.id`.
- The log grows; daily rotation mirrors the log files.

**Design contracts worth pinning now:**

- Events are notifications, not payloads. Bodies stay in the DB. Events carry IDs and metadata only. This is the pattern that scales to M3.
- Subscribers filter by `event.type` string locally. No topic registry, no broker-side routing at M1.
- Multiple subscribers are supported (the file is read concurrently, and `fs.watch` fires for each of them).

**Emission points at M1:**

- `message.outbound` — on every new outbound message row.
- `turn.started`, `turn.completed`, `turn.errored` — state transitions for eventual dashboard/inspector use.

The only subscriber at M1 is `tail` (listening for `message.outbound`). The other events are emitted for future consumers and cost essentially nothing to publish.

**Explicit non-goals of the M1 bus:**

- No topics / subscription registry.
- No event schemas beyond TypeScript types.
- No durable delivery guarantees (if `tail` isn't running, it misses live events; it recovers history by querying the DB).
- No cross-process subscription coordination.
- No retention or compaction.

## 11. Observability

**Correlation.** Every log line carries `traceId` (generated at `send`), plus `turnId` and `agentName` where applicable. The trace ID flows CLI → DB → daemon → container env → container logs → reply rows.

**Logs.** JSON Lines. Daemon writes to stdout (captured by launchd/systemd) and to `data/logs/teamroom-YYYY-MM-DD.jsonl` with daily rotation (rename + reopen on date boundary). Container logs enter the daemon via `type:"log"` events on the stdout protocol and merge into the daemon log stream. Shape:

```
{ts, level, component, traceId?, turnId?, agentName?, msg, ...}
```

**Events as observability.** Turn state transitions publish `turn.started`, `turn.completed`, `turn.errored` events on the `NotifyBus`. A future `teamroom inspect` or dashboard just subscribes.

**Metrics.** None at M1. Query the `turns` table for duration / error counts. A metrics backend arrives in M2 alongside the credential proxy.

**Health.** `teamroom status` prints daemon PID (from `data/teamroom.pid`), pending and running turn counts, last successful turn timestamp, agent list. Exits 0 if daemon alive, non-zero if not. No HTTP health endpoint.

## 12. Error handling

The three invariants from §3 (nothing silent, nothing inconsistent, nothing crashes) are enforced as follows.

**Container failures:**

| Situation | Behavior |
|---|---|
| Container exits non-zero | `turns.status='error'`, `turns.error` = exit code + last ~2KB stderr; `turn.errored` event; user-visible reply in `tail` |
| Turn timeout (5 min default) | Daemon `docker kill`s; same treatment, `error='timeout'` |
| Malformed stdout JSON line | Logged at `warn`; turn continues; line dropped |
| Docker daemon unreachable | Turn immediately errored with `error='docker_unavailable'` |

**Claude API failures (from inside container):** transient retries happen inside the container (Claude SDK policy) before giving up. Auth and exhausted-retry failures produce a non-zero exit with a distinct stderr line; the daemon treats them as any other container failure. No special-casing outside the container.

**Daemon crash / restart — reconcile pass:** on startup, the daemon (1) marks any turn with `status='running'` as errored with `error='daemon_restart'` and publishes `turn.errored`; (2) picks up `direction='in' AND turn_id IS NULL` messages in order and resumes processing. Daemon death is recoverable at any point; worst-case user impact is one errored turn. No silent loss, no double execution.

**CLI failures:** `send` with daemon down queues the message and prints a warning. `tail` with daemon down runs normally, receives nothing new. Stack traces go to a debug log under `--verbose`; the default output is a clean human message.

**SQLite:** `SQLITE_BUSY` on write retries with exponential backoff up to 5s; in WAL mode with the M1 writer set this should not fire. Disk-full or corruption causes a fatal boot log and exit; no self-healing.

**Bus:** `fs.watch` dropouts are caught by the 500ms poll fallback. Subscribers dedupe by `event.id`. `data/bus/` is created on startup if missing.

**Global safety nets:** the daemon installs `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log at `fatal` and **do not exit**. Every async boundary (container spawn, DB write, bus publish, fs ops) is wrapped in a `try/catch` that routes to a single turn-errored helper. The agent runtime inside the container wraps the whole session in `try/catch` and exits with a known code on failure, never leaking an unhandled rejection. Boot-time failures (can't open DB, can't create `data/bus/`, can't reach Docker) still exit so the OS supervisor can restart.

**Explicit non-goals:**

- No automatic retry of errored turns. Resubmit via `teamroom send`. Retry behavior lands with evals in M6.
- No circuit breaker.
- No external alerting. Errors surface in logs and `tail`.

## 13. Testing strategy

**The interfaces (composition root of the daemon):**

| Interface | Production | Test |
|---|---|---|
| `AgentRepo`, `MessageRepo`, `TurnRepo` | SQLite file + WAL | SQLite `:memory:` — same code path |
| `NotifyBus` | `FileNotifyBus` | `InMemoryBus` (EventEmitter-backed) |
| `ContainerRunner` | `DockerRunner` | `FakeRunner` — scripted stdout / timing / exit codes |
| `Clock` | `SystemClock` | `ControllableClock` — tests advance time |
| `Logger` | JSON Lines → stdout + file | Capture-to-array for assertion |

**Test tiers:**

- **Unit / integration (single tier).** Because DB is in-memory and containers are fakes, the distinction dissolves. Every module is tested by composing the interfaces with test implementations. Target: full suite under a few seconds.
- **Smoke tests.** A small explicitly-marked set that uses real SQLite on disk, real Docker, and the real Anthropic API. Not in CI (cost, flakiness). Run manually; one of these proves "the hand-crafted agent responds."
- **End-to-end tests with a real agent.** Deferred. Likely absorbed into the M6 evals as scenario runs.

**Coverage priority:** DB layer (migrations, CRUD, reconcile), `NotifyBus` (fs.watch, poll fallback, dedupe), container lifecycle (envelope, stdout parse, timeout, error classification), turn state machine (all transitions incl. crash reconcile). Explicit non-targets: CLI arg parsing, log formatting, trivial glue.

**Mocking libraries are a non-goal.** No `jest.mock`, `vi.mock`, or module-level mocking. If you feel the urge, the code's seam is wrong — fix the seam.

## 14. Non-goals for M1 (deferred list)

| Deferred | When |
|---|---|
| Keep-alive containers (warm between turns) | Post-M1 performance work — acknowledged as directionally valuable |
| `teamroom agent add` / onboarding tooling / agent scaffolds | Triggered by agent #2 (runbook first, then tooling) |
| Multi-model credential proxy | M2 |
| Event store with topics, durable delivery, subscription registry | M3 (the `NotifyBus` interface is the seam) |
| Inter-agent messaging | M3 |
| Shared filesystem for codebase + worktrees | M3 |
| Per-agent memory | M4 |
| Scheduling / cron | M5 |
| Per-agent evaluations | M6 |
| Team ceremonies / self-learning | M7 |
| Retries on errored turns | M6 |
| Real chat channel (Telegram, WhatsApp, Slack, etc.) | Post-M1 via channel runbook |
| Metrics backend (OTEL / Prometheus) | M2 alongside credential proxy |
| HTTP health endpoint | Not planned; `teamroom status` suffices |
| Multiple agents at M1 | Out of scope — M1 exits with exactly one hand-crafted agent |
| Mocking libraries | Non-goal by principle, not milestone |

## 15. Open questions deferred to planning

These surfaced during brainstorming but do not block the design. The implementation plan will resolve them:

- Test runner choice (Jest vs Vitest).
- Exact Alpine vs slim Node base image for the agent Dockerfile.
- Whether `teamroom agent build <name>` is implemented as a standalone command in M1 or as implicit "build on first run" only.
- Daemon supervisor unit files (launchd plist, systemd unit) — likely land with the implementation plan's packaging step.
