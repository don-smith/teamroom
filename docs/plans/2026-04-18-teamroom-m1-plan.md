# Team Room M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Milestone 1 of Team Room — a long-running Node.js daemon that processes messages from a terminal-only CLI through a single hand-configured agent running in a fresh Docker container per turn, with a DI architecture, a notify-bus seam, structured observability, and crash-safe turn reconciliation.

**Architecture:** Composition-root pattern. Every effectful dependency (DB, bus, container runner, clock, logger, Anthropic client) sits behind a TypeScript interface. Daemon composes production implementations at boot; tests compose in-memory real implementations. Three SQLite tables (`agents`, `messages`, `turns`), a `FileNotifyBus` for cross-process notification, and a minimal Node.js agent-runtime shim inside each container that calls the Anthropic API and persists conversation history to the writable mount.

**Tech Stack:** Node.js 20 LTS • TypeScript (strict) • `better-sqlite3` • `@anthropic-ai/sdk` • `commander` (CLI) • `chokidar` (fs watching) • `yaml` • `vitest` (test runner) • Docker (ephemeral per-turn containers) • `node:20-alpine` as the agent image base.

---

## Spec amendments made by this plan

Two small refinements from `docs/specs/2026-04-18-teamroom-m1-design.md`. Apply these in Task 1 and propagate through the plan.

1. **Agent system-prompt filename.** The spec uses `agents/<name>/CLAUDE.md`. This plan uses `agents/<name>/AGENTS.md` for model-agnostic consistency with the repo-root convention. Mount point inside the container becomes `/AGENTS.md`.
2. **Session state filename.** The spec uses `agents/<name>/store/session-id`. This plan uses `agents/<name>/store/conversation.jsonl`. The plain Anthropic Messages API is stateless (history is client-held), so the file holds conversation history as a JSONL stream of `{role, content}` entries — one line per turn-side. The environment variable `CLAUDE_SESSION_ID` is dropped; state lives entirely in the writable mount.

Both changes are noted in the first task and carried through every task that references these paths.

## Decisions locked by this plan (refining §15 of the spec)

- **Test runner:** `vitest`. Chosen over Jest for faster startup, ESM support, simpler config.
- **Agent image base:** `node:20-alpine`. Small, stable LTS; agent-runtime is Node.js today, LangGraph.js later if the user chooses that path.
- **Explicit rebuild path:** for M1, agents are rebuilt with `docker build` directly (documented in the smoke-test script). No `teamroom agent build` CLI command at M1; the daemon auto-builds an image on first run if it is missing.
- **First agent name:** `assistant`. Matches the phase-1 evolution narrative in `docs/ways-of-working.md` — the user's first collaborator. Rename later if role specialization forces it.
- **No ESLint/Prettier at M1.** TypeScript strict mode carries most safety value. Add linters later if friction warrants.

## File and folder structure (target state at M1 close)

```
<repo-root>/
├── AGENTS.md                              # standing instructions for AI assistants in this repo
├── README.md                              # repo-root orientation + quick start
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── types.ts                           # shared domain types (Message, Turn, Agent, BusEvent, ...)
│   ├── clock/
│   │   └── clock.ts                       # Clock interface + SystemClock + ControllableClock
│   ├── logger/
│   │   └── logger.ts                      # Logger interface + JsonLinesLogger + CapturingLogger
│   ├── db/
│   │   ├── database.ts                    # createDatabase(dsn) → better-sqlite3 Database
│   │   ├── migrator.ts                    # applies numbered SQL migrations on boot
│   │   ├── migrations/
│   │   │   └── 001_initial.sql
│   │   ├── agent-repo.ts
│   │   ├── message-repo.ts
│   │   └── turn-repo.ts
│   ├── bus/
│   │   ├── notify-bus.ts                  # NotifyBus interface + BusEvent type helpers
│   │   ├── file-notify-bus.ts             # production impl (chokidar + JSONL log)
│   │   └── in-memory-bus.ts               # test impl (EventEmitter)
│   ├── container/
│   │   ├── container-runner.ts            # ContainerRunner interface
│   │   ├── docker-runner.ts               # production impl (spawns `docker run`)
│   │   ├── docker-command.ts              # pure argv builder (unit-testable)
│   │   └── fake-runner.ts                 # test impl
│   ├── agent-config/
│   │   └── agent-config.ts                # loadAgentConfig(path) — yaml parse + validate
│   ├── anthropic/
│   │   └── anthropic-client.ts            # AnthropicClient interface + real impl
│   ├── daemon/
│   │   ├── daemon.ts                      # composition root — buildDaemon(deps) / startDaemon()
│   │   ├── orchestrator.ts                # polling loop for pending inbound messages
│   │   ├── turn-processor.ts              # processes one inbound → 0..N outbound
│   │   ├── reconcile.ts                   # startup reconcile pass
│   │   ├── safety-nets.ts                 # global process-level error handlers
│   │   └── main.ts                        # ENTRY — `teamroom serve` dispatches here
│   ├── cli/
│   │   ├── main.ts                        # ENTRY — `teamroom` binary
│   │   ├── serve.ts                       # serve command (spawns daemon)
│   │   ├── send.ts                        # send command
│   │   ├── tail.ts                        # tail command
│   │   └── status.ts                      # status command
│   └── agent-runtime/
│       ├── main.ts                        # ENTRY (inside container): read stdin, run turn, write stdout
│       ├── session-store.ts               # read/append/rewrite conversation.jsonl
│       └── runtime.ts                     # the core turn function (DI-testable)
├── tests/
│   ├── clock.test.ts
│   ├── logger.test.ts
│   ├── db/
│   │   ├── migrator.test.ts
│   │   ├── agent-repo.test.ts
│   │   ├── message-repo.test.ts
│   │   └── turn-repo.test.ts
│   ├── bus/
│   │   ├── in-memory-bus.test.ts
│   │   └── file-notify-bus.test.ts
│   ├── container/
│   │   ├── docker-command.test.ts
│   │   └── fake-runner.test.ts
│   ├── agent-config/
│   │   └── agent-config.test.ts
│   ├── agent-runtime/
│   │   ├── session-store.test.ts
│   │   └── runtime.test.ts
│   ├── daemon/
│   │   ├── turn-processor.test.ts
│   │   ├── orchestrator.test.ts
│   │   └── reconcile.test.ts
│   └── integration/
│       └── end-to-end.test.ts
├── agents/
│   └── assistant/                          # the hand-crafted M1 agent
│       ├── AGENTS.md                       # this agent's system prompt
│       ├── Dockerfile
│       ├── agent.yaml                      # {name, model, image_tag}
│       └── store/                          # gitignored; contains conversation.jsonl at runtime
│           └── .gitkeep
├── scripts/
│   └── smoke-test.sh                       # manual end-to-end smoke
└── docs/                                   # already established
    ├── ways-of-working.md
    ├── tabled.md
    ├── specs/2026-04-18-teamroom-m1-design.md
    └── plans/2026-04-18-teamroom-m1-plan.md   (this file)
```

Module boundaries follow the DI principle: each subfolder exports exactly one interface (or a small coherent set) plus implementations. The composition root in `src/daemon/daemon.ts` is the only place that wires concrete implementations together.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `README.md`
- Create: `AGENTS.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "teamroom",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "teamroom": "dist/cli/main.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0",
    "better-sqlite3": "^11.5.0",
    "chokidar": "^4.0.1",
    "commander": "^12.1.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.8.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
coverage/
agents/*/store/
!agents/*/store/.gitkeep
*.log
.DS_Store
```

- [ ] **Step 5: Create `README.md`**

```markdown
# Team Room

A multi-agent harness modeled after a software delivery team. See `docs/specs/2026-04-18-teamroom-m1-design.md` for the M1 design and `docs/ways-of-working.md` for how we build this.

## Quick start (M1)

```bash
npm install
npm run build
npm test
```

## Structure

- `src/` — daemon, CLI, agent-runtime
- `agents/<name>/` — per-agent folder (M1: just `assistant/`)
- `data/` — runtime state (gitignored): SQLite DB, logs, bus
- `docs/` — specs, plans, retros, runbooks, ways-of-working

## Milestone 1

Ship the smallest end-to-end slice: terminal message in → one hand-configured agent processes it in a Docker container → reply out via `teamroom tail`. See the spec for details.
```

- [ ] **Step 6: Create `AGENTS.md`**

```markdown
# AGENTS.md — Standing instructions for AI assistants working on Team Room

Read in this order when joining a session:

1. `docs/ways-of-working.md` — how we build Team Room (reflection rhythms, knowledge base model, memory-type mapping, document inventory).
2. `docs/specs/2026-04-18-teamroom-m1-design.md` — current milestone design.
3. `docs/plans/2026-04-18-teamroom-m1-plan.md` — current implementation plan and progress.
4. `docs/tabled.md` — tabled epiphanies awaiting processing.

## Principles locked in the M1 spec

- **Deliberate coupling and extensibility.** State what is shared vs. isolated for every boundary.
- **Minimize long-running process dependencies.** Prefer in-process / embedded over separate services.
- **See only as far as needed, not further.** Formalize at N=2, not N=1.
- **Nothing silent, nothing inconsistent, nothing crashes.** Global safety nets in the daemon; containers run to completion or the daemon kills them.
- **Design for testability via DI.** Every effectful dependency behind an interface; tests use in-memory real implementations, never `vi.mock` / `jest.mock`.

## Working practices

- **Epiphanies** are tabled to `docs/tabled.md`, not pursued mid-task.
- **Once is a moment; twice is a pattern.** Don't formalize on first occurrence.
- **Proliferation test** before creating new markdown files: does the content fit in an existing doc?

## Language and style

- TypeScript strict mode. `any` is a smell.
- Small files, one responsibility each. Interfaces at the boundary.
- Every module under `src/` has an entry file matching its folder name (or `index.ts` only if that reads better in context).
```

- [ ] **Step 7: Run `npm install` to materialize the lockfile**

Run: `npm install`
Expected: installs cleanly; produces `node_modules/` and `package-lock.json`.

- [ ] **Step 8: Run the typecheck to prove the skeleton compiles**

Run: `npm run typecheck`
Expected: exits 0 with no output (no TS files yet to check, but tsc runs cleanly).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore README.md AGENTS.md
git commit -m "feat(m1): project scaffold — package.json, tsconfig, vitest, AGENTS.md, README"
```

---

## Task 2: Shared domain types

**Files:**
- Create: `src/types.ts`
- Create: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Agent, Message, Turn, BusEvent } from "../src/types.js";

describe("shared types", () => {
  it("compiles with all expected fields", () => {
    const agent: Agent = {
      id: "assistant",
      configPath: "/abs/path/agents/assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const message: Message = {
      id: "msg-1",
      agentId: "assistant",
      channel: "cli",
      direction: "in",
      body: "hi",
      turnId: null,
      traceId: "trace-1",
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const turn: Turn = {
      id: "turn-1",
      agentId: "assistant",
      inboundMessageId: "msg-1",
      status: "pending",
      containerId: null,
      error: null,
      traceId: "trace-1",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    };

    const event: BusEvent = {
      id: "evt-1",
      type: "message.outbound",
      ts: "2026-04-18T00:00:00.000Z",
    };

    expect(agent.id).toBe("assistant");
    expect(message.direction).toBe("in");
    expect(turn.status).toBe("pending");
    expect(event.type).toBe("message.outbound");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — module `../src/types.js` not found.

- [ ] **Step 3: Create `src/types.ts`**

```ts
export type MessageDirection = "in" | "out";
export type TurnStatus = "pending" | "running" | "done" | "error";

export interface Agent {
  id: string;
  configPath: string;
  createdAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  channel: string;
  direction: MessageDirection;
  body: string;
  turnId: string | null;
  traceId: string;
  createdAt: string;
}

export interface Turn {
  id: string;
  agentId: string;
  inboundMessageId: string;
  status: TurnStatus;
  containerId: string | null;
  error: string | null;
  traceId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BusEvent {
  id: string;
  type: string;
  ts: string;
  [k: string]: unknown;
}

export interface MessageOutboundEvent extends BusEvent {
  type: "message.outbound";
  agentId: string;
  messageId: string;
  turnId: string;
  traceId: string;
}

export interface TurnLifecycleEvent extends BusEvent {
  type: "turn.started" | "turn.completed" | "turn.errored";
  agentId: string;
  turnId: string;
  traceId: string;
  error?: string;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(m1): shared domain types (Agent, Message, Turn, BusEvent)"
```

---

## Task 3: Clock module

**Files:**
- Create: `src/clock/clock.ts`
- Create: `tests/clock.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SystemClock, ControllableClock } from "../src/clock/clock.js";

describe("SystemClock", () => {
  it("returns a valid ISO timestamp near Date.now()", () => {
    const before = Date.now();
    const iso = new SystemClock().nowIso();
    const after = Date.now();
    const parsed = Date.parse(iso);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("returns numeric epoch ms", () => {
    const before = Date.now();
    const ms = new SystemClock().nowMs();
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

describe("ControllableClock", () => {
  it("returns the initial time until advanced", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-04-18T00:00:00.000Z");
    expect(clock.nowMs()).toBe(Date.parse("2026-04-18T00:00:00.000Z"));
  });

  it("advances by the given milliseconds", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.nowIso()).toBe("2026-04-18T00:00:01.500Z");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/clock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/clock/clock.ts`**

```ts
export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class ControllableClock implements Clock {
  private currentMs: number;

  constructor(startIso: string) {
    this.currentMs = Date.parse(startIso);
    if (Number.isNaN(this.currentMs)) {
      throw new Error(`ControllableClock: invalid ISO string ${startIso}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/clock.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/clock/clock.ts tests/clock.test.ts
git commit -m "feat(m1): Clock interface with SystemClock and ControllableClock"
```

---

## Task 4: Logger module

**Files:**
- Create: `src/logger/logger.ts`
- Create: `tests/logger.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/logger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CapturingLogger, JsonLinesLogger } from "../src/logger/logger.js";
import { ControllableClock } from "../src/clock/clock.js";

describe("CapturingLogger", () => {
  it("captures log entries in order", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const log = new CapturingLogger(clock);
    log.info("hello", { component: "test" });
    clock.advance(1000);
    log.error("boom", { traceId: "t-1" });
    expect(log.entries).toEqual([
      { ts: "2026-04-18T00:00:00.000Z", level: "info", msg: "hello", component: "test" },
      { ts: "2026-04-18T00:00:01.000Z", level: "error", msg: "boom", traceId: "t-1" },
    ]);
  });

  it("supports child loggers that inherit and extend fields", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const log = new CapturingLogger(clock).child({ component: "daemon", traceId: "t-1" });
    log.warn("slow", { ms: 1200 });
    const parent = (log as CapturingLogger);
    expect(parent.entries.at(-1)).toEqual({
      ts: "2026-04-18T00:00:00.000Z",
      level: "warn",
      msg: "slow",
      component: "daemon",
      traceId: "t-1",
      ms: 1200,
    });
  });
});

describe("JsonLinesLogger", () => {
  it("writes one JSON line per call to the provided sink", () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const lines: string[] = [];
    const log = new JsonLinesLogger(clock, (line) => lines.push(line));
    log.info("hi", { component: "x" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual({
      ts: "2026-04-18T00:00:00.000Z",
      level: "info",
      msg: "hi",
      component: "x",
    });
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/logger/logger.ts`**

```ts
import type { Clock } from "../clock/clock.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  fatal(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

abstract class BaseLogger implements Logger {
  constructor(protected readonly clock: Clock, protected readonly bindings: Record<string, unknown> = {}) {}

  protected abstract emit(entry: LogEntry): void;

  private log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: this.clock.nowIso(),
      level,
      msg,
      ...this.bindings,
      ...(extra ?? {}),
    };
    this.emit(entry);
  }

  debug(msg: string, extra?: Record<string, unknown>): void { this.log("debug", msg, extra); }
  info(msg: string, extra?: Record<string, unknown>): void { this.log("info", msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>): void { this.log("warn", msg, extra); }
  error(msg: string, extra?: Record<string, unknown>): void { this.log("error", msg, extra); }
  fatal(msg: string, extra?: Record<string, unknown>): void { this.log("fatal", msg, extra); }

  abstract child(bindings: Record<string, unknown>): Logger;
}

export class CapturingLogger extends BaseLogger {
  public readonly entries: LogEntry[];

  constructor(clock: Clock, bindings: Record<string, unknown> = {}, shared?: LogEntry[]) {
    super(clock, bindings);
    this.entries = shared ?? [];
  }

  protected emit(entry: LogEntry): void {
    this.entries.push(entry);
  }

  child(bindings: Record<string, unknown>): CapturingLogger {
    return new CapturingLogger(this.clock, { ...this.bindings, ...bindings }, this.entries);
  }
}

export type LogSink = (line: string) => void;

export class JsonLinesLogger extends BaseLogger {
  constructor(clock: Clock, private readonly sink: LogSink, bindings: Record<string, unknown> = {}) {
    super(clock, bindings);
  }

  protected emit(entry: LogEntry): void {
    this.sink(JSON.stringify(entry));
  }

  child(bindings: Record<string, unknown>): JsonLinesLogger {
    return new JsonLinesLogger(this.clock, this.sink, { ...this.bindings, ...bindings });
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/logger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logger/logger.ts tests/logger.test.ts
git commit -m "feat(m1): Logger interface with JsonLinesLogger and CapturingLogger, child bindings"
```

---

## Task 5: Database connection + migrator

**Files:**
- Create: `src/db/database.ts`
- Create: `src/db/migrator.ts`
- Create: `src/db/migrations/001_initial.sql`
- Create: `tests/db/migrator.test.ts`

- [ ] **Step 1: Write the migration**

`src/db/migrations/001_initial.sql`:

```sql
CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  config_path  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  channel     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body        TEXT NOT NULL,
  turn_id     TEXT,
  trace_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX idx_messages_direction_created ON messages(direction, created_at);

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL REFERENCES agents(id),
  inbound_message_id   TEXT NOT NULL REFERENCES messages(id),
  status               TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  container_id         TEXT,
  error                TEXT,
  trace_id             TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_turns_status ON turns(status);
```

- [ ] **Step 2: Write failing tests**

`tests/db/migrator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations, getAppliedMigrations } from "../../src/db/migrator.js";

describe("migrator", () => {
  it("creates the schema on a fresh in-memory DB", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("agents");
    expect(names).toContain("messages");
    expect(names).toContain("turns");
    expect(names).toContain("_migrations");
  });

  it("is idempotent — running twice leaves applied state unchanged", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const first = getAppliedMigrations(db);
    runMigrations(db);
    const second = getAppliedMigrations(db);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run — expect fail**

Run: `npx vitest run tests/db/migrator.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Create `src/db/database.ts`**

```ts
import Database from "better-sqlite3";
import type { Database as BetterDb } from "better-sqlite3";

export type Db = BetterDb;

export function createDatabase(dsn: string): Db {
  const db = new Database(dsn);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
```

- [ ] **Step 5: Create `src/db/migrator.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./database.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface AppliedMigration {
  name: string;
  applied_at: string;
}

export function getAppliedMigrations(db: Db): AppliedMigration[] {
  ensureMigrationsTable(db);
  return db
    .prepare("SELECT name, applied_at FROM _migrations ORDER BY name")
    .all() as AppliedMigration[];
}

export function runMigrations(db: Db): void {
  ensureMigrationsTable(db);
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const applyOne = db.transaction(() => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    });
    applyOne();
  }
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`);
}
```

- [ ] **Step 6: Run — expect pass**

Run: `npx vitest run tests/db/migrator.test.ts`
Expected: PASS (2 tests).

Note: vitest must be able to resolve the migrations directory relative to the source file. For this to work in tests, the migration SQL file is read from `src/db/migrations/`. Vitest runs `.ts` files directly, so `import.meta.url` points into `src/`. No build step needed for tests.

- [ ] **Step 7: Commit**

```bash
git add src/db/database.ts src/db/migrator.ts src/db/migrations/001_initial.sql tests/db/migrator.test.ts
git commit -m "feat(m1): SQLite DB factory and migrator with initial schema (agents, messages, turns)"
```

---

## Task 6: Agent repository

**Files:**
- Create: `src/db/agent-repo.ts`
- Create: `tests/db/agent-repo.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/db/agent-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("AgentRepo", () => {
  let db: Db;
  let repo: AgentRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new AgentRepo(db);
  });

  it("creates an agent and returns it", () => {
    repo.create({
      id: "assistant",
      configPath: "/abs/path/agents/assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const found = repo.findById("assistant");
    expect(found).toEqual({
      id: "assistant",
      configPath: "/abs/path/agents/assistant",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });

  it("returns null when agent is missing", () => {
    expect(repo.findById("nope")).toBeNull();
  });

  it("lists all agents ordered by id", () => {
    repo.create({ id: "b", configPath: "/b", createdAt: "2026-04-18T00:00:00.000Z" });
    repo.create({ id: "a", configPath: "/a", createdAt: "2026-04-18T00:00:00.000Z" });
    const all = repo.findAll();
    expect(all.map((a) => a.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/db/agent-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/db/agent-repo.ts`**

```ts
import type { Agent } from "../types.js";
import type { Db } from "./database.js";

interface AgentRow {
  id: string;
  config_path: string;
  created_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return { id: row.id, configPath: row.config_path, createdAt: row.created_at };
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  create(agent: Agent): void {
    this.db
      .prepare("INSERT INTO agents (id, config_path, created_at) VALUES (?, ?, ?)")
      .run(agent.id, agent.configPath, agent.createdAt);
  }

  findById(id: string): Agent | null {
    const row = this.db
      .prepare("SELECT id, config_path, created_at FROM agents WHERE id = ?")
      .get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  findAll(): Agent[] {
    const rows = this.db
      .prepare("SELECT id, config_path, created_at FROM agents ORDER BY id")
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/db/agent-repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/agent-repo.ts tests/db/agent-repo.test.ts
git commit -m "feat(m1): AgentRepo (create / findById / findAll)"
```

---

## Task 7: Message repository

**Files:**
- Create: `src/db/message-repo.ts`
- Create: `tests/db/message-repo.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/db/message-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({
    id: "assistant",
    configPath: "/abs/agents/assistant",
    createdAt: "2026-04-18T00:00:00.000Z",
  });
  return db;
}

describe("MessageRepo", () => {
  let db: Db;
  let repo: MessageRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new MessageRepo(db);
  });

  it("creates an inbound message and finds it as pending", () => {
    repo.create({
      id: "m1",
      agentId: "assistant",
      channel: "cli",
      direction: "in",
      body: "hello",
      turnId: null,
      traceId: "trace-1",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const pending = repo.findPendingInbound();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("m1");
  });

  it("excludes inbound messages that already have a turnId", () => {
    repo.create({
      id: "m1", agentId: "assistant", channel: "cli", direction: "in",
      body: "a", turnId: "t-1", traceId: "tr", createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.findPendingInbound()).toEqual([]);
  });

  it("attaches a turnId to a message", () => {
    repo.create({
      id: "m1", agentId: "assistant", channel: "cli", direction: "in",
      body: "a", turnId: null, traceId: "tr", createdAt: "2026-04-18T00:00:00.000Z",
    });
    repo.attachTurn("m1", "turn-abc");
    expect(repo.findPendingInbound()).toEqual([]);
    const found = repo.findById("m1");
    expect(found?.turnId).toBe("turn-abc");
  });

  it("finds outbound messages after a given message id (for tail)", () => {
    const base = "2026-04-18T00:00:00.000Z";
    repo.create({
      id: "o1", agentId: "assistant", channel: "cli", direction: "out",
      body: "r1", turnId: "t-1", traceId: "tr", createdAt: base,
    });
    repo.create({
      id: "o2", agentId: "assistant", channel: "cli", direction: "out",
      body: "r2", turnId: "t-1", traceId: "tr",
      createdAt: "2026-04-18T00:00:01.000Z",
    });
    const after = repo.findOutboundAfter("o1");
    expect(after.map((m) => m.id)).toEqual(["o2"]);
  });

  it("findOutboundAfter(null) returns all outbound", () => {
    const base = "2026-04-18T00:00:00.000Z";
    repo.create({
      id: "o1", agentId: "assistant", channel: "cli", direction: "out",
      body: "r1", turnId: "t-1", traceId: "tr", createdAt: base,
    });
    expect(repo.findOutboundAfter(null).map((m) => m.id)).toEqual(["o1"]);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/db/message-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/db/message-repo.ts`**

```ts
import type { Message } from "../types.js";
import type { Db } from "./database.js";

interface MessageRow {
  id: string;
  agent_id: string;
  channel: string;
  direction: "in" | "out";
  body: string;
  turn_id: string | null;
  trace_id: string;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    turnId: row.turn_id,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  create(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, agent_id, channel, direction, body, turn_id, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.agentId, m.channel, m.direction, m.body, m.turnId, m.traceId, m.createdAt);
  }

  findById(id: string): Message | null {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  findPendingInbound(): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'in' AND turn_id IS NULL
         ORDER BY created_at`,
      )
      .all() as MessageRow[];
    return rows.map(rowToMessage);
  }

  attachTurn(messageId: string, turnId: string): void {
    this.db.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, messageId);
  }

  findOutboundAfter(lastSeenId: string | null): Message[] {
    const sql = lastSeenId
      ? `SELECT * FROM messages
         WHERE direction = 'out'
           AND created_at > (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at, id`
      : `SELECT * FROM messages WHERE direction = 'out' ORDER BY created_at, id`;
    const rows = lastSeenId
      ? (this.db.prepare(sql).all(lastSeenId) as MessageRow[])
      : (this.db.prepare(sql).all() as MessageRow[]);
    return rows.map(rowToMessage);
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/db/message-repo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/message-repo.ts tests/db/message-repo.test.ts
git commit -m "feat(m1): MessageRepo (create, findById, findPendingInbound, attachTurn, findOutboundAfter)"
```

---

## Task 8: Turn repository

**Files:**
- Create: `src/db/turn-repo.ts`
- Create: `tests/db/turn-repo.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/db/turn-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";

function freshDb(): Db {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({
    id: "assistant",
    configPath: "/abs",
    createdAt: "2026-04-18T00:00:00.000Z",
  });
  new MessageRepo(db).create({
    id: "m1",
    agentId: "assistant",
    channel: "cli",
    direction: "in",
    body: "hi",
    turnId: null,
    traceId: "tr",
    createdAt: "2026-04-18T00:00:00.000Z",
  });
  return db;
}

describe("TurnRepo", () => {
  let db: Db;
  let repo: TurnRepo;

  beforeEach(() => {
    db = freshDb();
    repo = new TurnRepo(db);
  });

  it("creates a pending turn", () => {
    repo.create({
      id: "t1",
      agentId: "assistant",
      inboundMessageId: "m1",
      status: "pending",
      containerId: null,
      error: null,
      traceId: "tr",
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const t = repo.findById("t1");
    expect(t?.status).toBe("pending");
  });

  it("marks running with container id and startedAt", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr", startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    repo.markRunning("t1", "container-abc", "2026-04-18T00:00:01.000Z");
    const t = repo.findById("t1");
    expect(t?.status).toBe("running");
    expect(t?.containerId).toBe("container-abc");
    expect(t?.startedAt).toBe("2026-04-18T00:00:01.000Z");
  });

  it("marks done with finishedAt", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    repo.markDone("t1", "2026-04-18T00:00:02.000Z");
    expect(repo.findById("t1")?.status).toBe("done");
    expect(repo.findById("t1")?.finishedAt).toBe("2026-04-18T00:00:02.000Z");
  });

  it("marks error with error text and finishedAt", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    repo.markError("t1", "timeout", "2026-04-18T00:00:03.000Z");
    const t = repo.findById("t1");
    expect(t?.status).toBe("error");
    expect(t?.error).toBe("timeout");
    expect(t?.finishedAt).toBe("2026-04-18T00:00:03.000Z");
  });

  it("finds turns by status", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "running",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    const running = repo.findByStatus("running");
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe("t1");
  });

  it("counts by status", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "pending",
      containerId: null, error: null, traceId: "tr",
      startedAt: null, finishedAt: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.countByStatus("pending")).toBe(1);
    expect(repo.countByStatus("done")).toBe(0);
  });

  it("returns latest done turn", () => {
    repo.create({
      id: "t1", agentId: "assistant", inboundMessageId: "m1", status: "done",
      containerId: "c", error: null, traceId: "tr",
      startedAt: "2026-04-18T00:00:00.000Z", finishedAt: "2026-04-18T00:00:10.000Z",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    expect(repo.latestDone()?.id).toBe("t1");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/db/turn-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/db/turn-repo.ts`**

```ts
import type { Turn, TurnStatus } from "../types.js";
import type { Db } from "./database.js";

interface TurnRow {
  id: string;
  agent_id: string;
  inbound_message_id: string;
  status: TurnStatus;
  container_id: string | null;
  error: string | null;
  trace_id: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    agentId: row.agent_id,
    inboundMessageId: row.inbound_message_id,
    status: row.status,
    containerId: row.container_id,
    error: row.error,
    traceId: row.trace_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export class TurnRepo {
  constructor(private readonly db: Db) {}

  create(t: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, agent_id, inbound_message_id, status, container_id, error, trace_id,
            started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.agentId, t.inboundMessageId, t.status, t.containerId, t.error, t.traceId,
        t.startedAt, t.finishedAt, t.createdAt,
      );
  }

  findById(id: string): Turn | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  markRunning(id: string, containerId: string, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE turns SET status='running', container_id=?, started_at=? WHERE id=?`,
      )
      .run(containerId, startedAt, id);
  }

  markDone(id: string, finishedAt: string): void {
    this.db
      .prepare(`UPDATE turns SET status='done', finished_at=? WHERE id=?`)
      .run(finishedAt, id);
  }

  markError(id: string, error: string, finishedAt: string): void {
    this.db
      .prepare(`UPDATE turns SET status='error', error=?, finished_at=? WHERE id=?`)
      .run(error, finishedAt, id);
  }

  findByStatus(status: TurnStatus): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE status=? ORDER BY created_at`)
      .all(status) as TurnRow[];
    return rows.map(rowToTurn);
  }

  countByStatus(status: TurnStatus): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE status=?`)
      .get(status) as { c: number };
    return row.c;
  }

  latestDone(): Turn | null {
    const row = this.db
      .prepare(`SELECT * FROM turns WHERE status='done' ORDER BY finished_at DESC LIMIT 1`)
      .get() as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/db/turn-repo.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/turn-repo.ts tests/db/turn-repo.test.ts
git commit -m "feat(m1): TurnRepo (create, markRunning/Done/Error, findByStatus, count, latestDone)"
```

---

## Task 9: NotifyBus interface + InMemoryBus

**Files:**
- Create: `src/bus/notify-bus.ts`
- Create: `src/bus/in-memory-bus.ts`
- Create: `tests/bus/in-memory-bus.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/bus/in-memory-bus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import type { BusEvent } from "../../src/types.js";

function evt(id: string, type: string): BusEvent {
  return { id, type, ts: "2026-04-18T00:00:00.000Z" };
}

describe("InMemoryBus", () => {
  it("delivers published events to a subscriber", async () => {
    const bus = new InMemoryBus();
    const received: BusEvent[] = [];
    const iter = bus.subscribe();
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 2) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await bus.publish(evt("2", "b"));
    await reader;

    expect(received.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("applies the filter predicate to delivery", async () => {
    const bus = new InMemoryBus();
    const iter = bus.subscribe((e) => e.type === "b");
    const received: BusEvent[] = [];
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await bus.publish(evt("2", "b"));
    await reader;

    expect(received.map((e) => e.id)).toEqual(["2"]);
  });

  it("close() ends all active subscriptions", async () => {
    const bus = new InMemoryBus();
    const iter = bus.subscribe();
    const run = (async () => {
      for await (const _ of iter) {
        /* consume */
      }
      return "done";
    })();
    await bus.close();
    await expect(run).resolves.toBe("done");
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/bus/in-memory-bus.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `src/bus/notify-bus.ts`**

```ts
import type { BusEvent } from "../types.js";

export type EventFilter = (event: BusEvent) => boolean;

export interface NotifyBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(filter?: EventFilter): AsyncIterable<BusEvent>;
  close(): Promise<void>;
}
```

- [ ] **Step 4: Create `src/bus/in-memory-bus.ts`**

```ts
import type { BusEvent } from "../types.js";
import type { EventFilter, NotifyBus } from "./notify-bus.js";

interface Subscriber {
  filter: EventFilter | undefined;
  queue: BusEvent[];
  resolver: (() => void) | null;
  closed: boolean;
}

export class InMemoryBus implements NotifyBus {
  private subscribers: Subscriber[] = [];
  private closedFlag = false;

  async publish(event: BusEvent): Promise<void> {
    if (this.closedFlag) return;
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      if (sub.filter && !sub.filter(event)) continue;
      sub.queue.push(event);
      if (sub.resolver) {
        const r = sub.resolver;
        sub.resolver = null;
        r();
      }
    }
  }

  subscribe(filter?: EventFilter): AsyncIterable<BusEvent> {
    const sub: Subscriber = { filter, queue: [], resolver: null, closed: false };
    this.subscribers.push(sub);

    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            if (sub.queue.length > 0) {
              yield sub.queue.shift()!;
              continue;
            }
            if (sub.closed || self.closedFlag) return;
            await new Promise<void>((resolve) => {
              sub.resolver = resolve;
            });
          }
        } finally {
          sub.closed = true;
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    for (const sub of this.subscribers) {
      sub.closed = true;
      if (sub.resolver) {
        sub.resolver();
        sub.resolver = null;
      }
    }
  }
}
```

- [ ] **Step 5: Run — expect pass**

Run: `npx vitest run tests/bus/in-memory-bus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/bus/notify-bus.ts src/bus/in-memory-bus.ts tests/bus/in-memory-bus.test.ts
git commit -m "feat(m1): NotifyBus interface and InMemoryBus (publish/subscribe/close)"
```

---

## Task 10: FileNotifyBus (production)

**Files:**
- Create: `src/bus/file-notify-bus.ts`
- Create: `tests/bus/file-notify-bus.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/bus/file-notify-bus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNotifyBus } from "../../src/bus/file-notify-bus.js";
import type { BusEvent } from "../../src/types.js";

function evt(id: string, type: string): BusEvent {
  return { id, type, ts: "2026-04-18T00:00:00.000Z" };
}

describe("FileNotifyBus", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-bus-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers events published after subscribe starts", async () => {
    const bus = new FileNotifyBus(dir);
    const received: BusEvent[] = [];
    const iter = bus.subscribe();
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 2) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await bus.publish(evt("2", "b"));
    await reader;
    await bus.close();

    expect(received.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("deduplicates events that re-appear in the log", async () => {
    const bus = new FileNotifyBus(dir);
    const received: BusEvent[] = [];
    const iter = bus.subscribe();
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "a"));
    await reader;

    // simulate a re-read: publish same id again — subscriber should already have seen it
    await bus.publish(evt("1", "a"));
    await bus.close();
    expect(received.map((e) => e.id)).toEqual(["1"]);
  });

  it("applies a filter", async () => {
    const bus = new FileNotifyBus(dir);
    const received: BusEvent[] = [];
    const iter = bus.subscribe((e) => e.type === "keep");
    const reader = (async () => {
      for await (const e of iter) {
        received.push(e);
        if (received.length === 1) break;
      }
    })();

    await bus.publish(evt("1", "drop"));
    await bus.publish(evt("2", "keep"));
    await reader;
    await bus.close();

    expect(received.map((e) => e.id)).toEqual(["2"]);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/bus/file-notify-bus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/bus/file-notify-bus.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import type { BusEvent } from "../types.js";
import type { EventFilter, NotifyBus } from "./notify-bus.js";

export class FileNotifyBus implements NotifyBus {
  private readonly eventsFile: string;
  private readonly notifyFile: string;
  private closedFlag = false;
  private watchers: chokidar.FSWatcher[] = [];

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.eventsFile = join(dir, "events.jsonl");
    this.notifyFile = join(dir, ".notify");
    if (!existsSync(this.eventsFile)) writeFileSync(this.eventsFile, "");
    if (!existsSync(this.notifyFile)) writeFileSync(this.notifyFile, "");
  }

  async publish(event: BusEvent): Promise<void> {
    if (this.closedFlag) return;
    appendFileSync(this.eventsFile, JSON.stringify(event) + "\n");
    // touch the notify file so fs.watch subscribers wake up
    writeFileSync(this.notifyFile, String(Date.now()));
  }

  subscribe(filter?: EventFilter): AsyncIterable<BusEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const seenIds = new Set<string>();
        let buffered: BusEvent[] = [];
        let resolver: (() => void) | null = null;
        let watcherClosed = false;

        const readNew = () => {
          const contents = readFileSync(self.eventsFile, "utf8");
          const lines = contents.split("\n").filter((l) => l.length > 0);
          for (const line of lines) {
            let parsed: BusEvent;
            try {
              parsed = JSON.parse(line) as BusEvent;
            } catch {
              continue;
            }
            if (seenIds.has(parsed.id)) continue;
            seenIds.add(parsed.id);
            if (filter && !filter(parsed)) continue;
            buffered.push(parsed);
          }
          if (resolver && buffered.length > 0) {
            const r = resolver;
            resolver = null;
            r();
          }
        };

        const watcher = chokidar.watch(self.notifyFile, {
          persistent: true,
          ignoreInitial: true,
          usePolling: true,
          interval: 500,
        });
        self.watchers.push(watcher);
        watcher.on("change", () => {
          if (!watcherClosed) readNew();
        });
        watcher.on("add", () => {
          if (!watcherClosed) readNew();
        });

        // initial drain — events already on disk
        readNew();

        try {
          while (true) {
            if (buffered.length > 0) {
              const next = buffered.shift()!;
              yield next;
              continue;
            }
            if (self.closedFlag) return;
            await new Promise<void>((resolve) => {
              resolver = resolve;
              // ensure close wakes us
              if (self.closedFlag) resolve();
            });
          }
        } finally {
          watcherClosed = true;
          await watcher.close();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    for (const w of this.watchers) {
      await w.close();
    }
    this.watchers = [];
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/bus/file-notify-bus.test.ts`
Expected: PASS (3 tests). These tests are slower due to chokidar setup; they should still complete within the 10s default timeout.

- [ ] **Step 5: Commit**

```bash
git add src/bus/file-notify-bus.ts tests/bus/file-notify-bus.test.ts
git commit -m "feat(m1): FileNotifyBus — chokidar-polled events.jsonl with id dedup"
```

---

## Task 11: Container runner — interface, FakeRunner, argv builder

**Files:**
- Create: `src/container/container-runner.ts`
- Create: `src/container/docker-command.ts`
- Create: `src/container/fake-runner.ts`
- Create: `tests/container/docker-command.test.ts`
- Create: `tests/container/fake-runner.test.ts`

- [ ] **Step 1: Write failing tests for the pure argv builder**

`tests/container/docker-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../../src/container/docker-command.js";

describe("buildDockerRunArgs", () => {
  it("produces the expected argv for a standard turn", () => {
    const argv = buildDockerRunArgs({
      imageTag: "teamroom-agent-assistant:latest",
      mounts: [
        { hostPath: "/abs/agents/assistant/AGENTS.md", containerPath: "/AGENTS.md", readOnly: true },
        { hostPath: "/abs/agents/assistant/store", containerPath: "/store", readOnly: false },
      ],
      env: {
        TEAMROOM_TRACE_ID: "trace-1",
        TEAMROOM_TURN_ID: "turn-1",
        TEAMROOM_AGENT_NAME: "assistant",
        ANTHROPIC_API_KEY: "sk-x",
      },
    });

    expect(argv).toEqual([
      "run", "--rm", "-i",
      "-v", "/abs/agents/assistant/AGENTS.md:/AGENTS.md:ro",
      "-v", "/abs/agents/assistant/store:/store",
      "-e", "TEAMROOM_TRACE_ID=trace-1",
      "-e", "TEAMROOM_TURN_ID=turn-1",
      "-e", "TEAMROOM_AGENT_NAME=assistant",
      "-e", "ANTHROPIC_API_KEY=sk-x",
      "teamroom-agent-assistant:latest",
    ]);
  });

  it("orders env deterministically (sorted by key)", () => {
    const argv = buildDockerRunArgs({
      imageTag: "img:latest",
      mounts: [],
      env: { B: "2", A: "1" },
    });
    const bIndex = argv.indexOf("A=1");
    const aIndex = argv.indexOf("B=2");
    expect(bIndex).toBeLessThan(aIndex);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/container/docker-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/container/docker-command.ts`**

```ts
export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface DockerRunSpec {
  imageTag: string;
  mounts: Mount[];
  env: Record<string, string>;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const args: string[] = ["run", "--rm", "-i"];
  for (const m of spec.mounts) {
    const suffix = m.readOnly ? ":ro" : "";
    args.push("-v", `${m.hostPath}:${m.containerPath}${suffix}`);
  }
  const keys = Object.keys(spec.env).sort();
  for (const key of keys) {
    args.push("-e", `${key}=${spec.env[key]}`);
  }
  args.push(spec.imageTag);
  return args;
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/container/docker-command.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the ContainerRunner interface**

`src/container/container-runner.ts`:

```ts
import type { DockerRunSpec } from "./docker-command.js";

export type ContainerStdoutEvent =
  | { type: "reply"; body: string; messageId?: string }
  | { type: "status"; phase: string; [k: string]: unknown }
  | { type: "log"; level: string; msg: string; [k: string]: unknown }
  | { type: "unknown"; raw: string };

export interface ContainerRunResult {
  exitCode: number;
  containerId: string;
  stderr: string;
  timedOut: boolean;
}

export interface ContainerRunRequest {
  spec: DockerRunSpec;
  stdinJson: string;            // a single JSON line
  timeoutMs: number;
  onEvent: (event: ContainerStdoutEvent) => void;
}

export interface ContainerRunner {
  run(req: ContainerRunRequest): Promise<ContainerRunResult>;
}
```

- [ ] **Step 6: Write failing tests for FakeRunner**

`tests/container/fake-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeRunner, type Script } from "../../src/container/fake-runner.js";
import type { ContainerStdoutEvent } from "../../src/container/container-runner.js";

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
```

- [ ] **Step 7: Run — expect fail**

Run: `npx vitest run tests/container/fake-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Create `src/container/fake-runner.ts`**

```ts
import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
} from "./container-runner.js";

export interface Script {
  events: ContainerStdoutEvent[];
  exitCode: number;
  stderr: string;
  timedOut?: boolean;
}

export class FakeRunner implements ContainerRunner {
  private counter = 0;
  constructor(private readonly resolver: (req: ContainerRunRequest) => Script) {}

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const script = this.resolver(req);
    for (const evt of script.events) {
      req.onEvent(evt);
    }
    this.counter += 1;
    return {
      exitCode: script.exitCode,
      containerId: `fake-${this.counter}`,
      stderr: script.stderr,
      timedOut: script.timedOut ?? false,
    };
  }
}
```

- [ ] **Step 9: Run — expect pass**

Run: `npx vitest run tests/container/fake-runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Commit**

```bash
git add src/container/ tests/container/
git commit -m "feat(m1): ContainerRunner interface + FakeRunner + pure Docker argv builder"
```

---

## Task 12: DockerRunner (production impl)

**Files:**
- Create: `src/container/docker-runner.ts`

- [ ] **Step 1: Create `src/container/docker-runner.ts`**

This impl talks to the real Docker CLI. Unit-testable pieces live in `docker-command.ts` (Task 11); the spawn wiring itself is covered only by the smoke test at the end of the plan. Keep this file thin.

```ts
import { spawn } from "node:child_process";
import { buildDockerRunArgs } from "./docker-command.js";
import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
} from "./container-runner.js";

export class DockerRunner implements ContainerRunner {
  constructor(private readonly dockerBinary: string = "docker") {}

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const args = buildDockerRunArgs(req.spec);
    const child = spawn(this.dockerBinary, args, { stdio: ["pipe", "pipe", "pipe"] });

    const stderrChunks: string[] = [];
    let stdoutBuffer = "";
    let timedOut = false;

    child.stderr.on("data", (buf: Buffer) => stderrChunks.push(buf.toString("utf8")));

    child.stdout.on("data", (buf: Buffer) => {
      stdoutBuffer += buf.toString("utf8");
      let nl = stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.length > 0) req.onEvent(parseEvent(line));
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    child.stdin.write(req.stdinJson + "\n");
    child.stdin.end();

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, req.timeoutMs);

    const exitCode: number = await new Promise((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        resolve(code ?? -1);
      });
    });

    if (stdoutBuffer.length > 0) {
      // flush a trailing line with no newline
      req.onEvent(parseEvent(stdoutBuffer));
      stdoutBuffer = "";
    }

    return {
      exitCode,
      containerId: `docker-${child.pid ?? "unknown"}`,
      stderr: stderrChunks.join(""),
      timedOut,
    };
  }
}

function parseEvent(line: string): ContainerStdoutEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = obj.type;
    if (type === "reply" && typeof obj.body === "string") {
      return { type: "reply", body: obj.body, messageId: typeof obj.messageId === "string" ? obj.messageId : undefined };
    }
    if (type === "status" && typeof obj.phase === "string") {
      return { type: "status", phase: obj.phase, ...obj };
    }
    if (type === "log" && typeof obj.level === "string" && typeof obj.msg === "string") {
      return { type: "log", level: obj.level, msg: obj.msg, ...obj };
    }
    return { type: "unknown", raw: line };
  } catch {
    return { type: "unknown", raw: line };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/container/docker-runner.ts
git commit -m "feat(m1): DockerRunner — spawns docker run with JSONL stdout parsing and timeout kill"
```

---

## Task 13: Agent config loader

**Files:**
- Create: `src/agent-config/agent-config.ts`
- Create: `tests/agent-config/agent-config.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/agent-config/agent-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "../../src/agent-config/agent-config.js";

describe("loadAgentConfig", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "assistant");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# Assistant prompt");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: assistant\nmodel: claude-opus-4-7\nimage_tag: teamroom-agent-assistant:latest\n",
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("loads a valid agent config", () => {
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.name).toBe("assistant");
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.imageTag).toBe("teamroom-agent-assistant:latest");
    expect(cfg.configPath).toBe(agentDir);
    expect(cfg.agentsMdPath).toBe(join(agentDir, "AGENTS.md"));
    expect(cfg.storePath).toBe(join(agentDir, "store"));
  });

  it("rejects when agent.yaml is missing", () => {
    rmSync(join(agentDir, "agent.yaml"));
    expect(() => loadAgentConfig(agentDir)).toThrow(/agent\.yaml/);
  });

  it("rejects when AGENTS.md is missing", () => {
    rmSync(join(agentDir, "AGENTS.md"));
    expect(() => loadAgentConfig(agentDir)).toThrow(/AGENTS\.md/);
  });

  it("rejects when store/ is missing", () => {
    rmSync(join(agentDir, "store"), { recursive: true });
    expect(() => loadAgentConfig(agentDir)).toThrow(/store/);
  });

  it("rejects when required yaml fields are missing", () => {
    writeFileSync(join(agentDir, "agent.yaml"), "name: assistant\n");
    expect(() => loadAgentConfig(agentDir)).toThrow(/model|image_tag/);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/agent-config/agent-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/agent-config/agent-config.ts`**

```ts
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  configPath: string;     // absolute path to the agent folder
  agentsMdPath: string;   // absolute path to AGENTS.md inside the folder
  storePath: string;      // absolute path to store/
}

export function loadAgentConfig(agentDir: string): AgentConfig {
  const configPath = resolve(agentDir);
  const yamlPath = join(configPath, "agent.yaml");
  const agentsMdPath = join(configPath, "AGENTS.md");
  const storePath = join(configPath, "store");

  if (!existsSync(yamlPath)) throw new Error(`missing agent.yaml at ${yamlPath}`);
  if (!existsSync(agentsMdPath)) throw new Error(`missing AGENTS.md at ${agentsMdPath}`);
  if (!existsSync(storePath) || !statSync(storePath).isDirectory()) {
    throw new Error(`missing store/ directory at ${storePath}`);
  }

  const parsed = YAML.parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const name = parsed.name;
  const model = parsed.model;
  const imageTag = parsed.image_tag;
  if (typeof name !== "string") throw new Error(`agent.yaml missing 'name'`);
  if (typeof model !== "string") throw new Error(`agent.yaml missing 'model'`);
  if (typeof imageTag !== "string") throw new Error(`agent.yaml missing 'image_tag'`);

  return { name, model, imageTag, configPath, agentsMdPath, storePath };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/agent-config/agent-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent-config/ tests/agent-config/
git commit -m "feat(m1): agent config loader — validates AGENTS.md, agent.yaml, store/"
```

---

## Task 14: Turn processor

**Files:**
- Create: `src/daemon/turn-processor.ts`
- Create: `tests/daemon/turn-processor.test.ts`

The turn processor is the heart of the daemon. Given a pending inbound message, it: creates a turn, marks it running, spawns the container via ContainerRunner, captures stdout events, writes outbound messages, publishes bus events, and marks terminal state.

- [ ] **Step 1: Write failing tests**

`tests/daemon/turn-processor.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import { ControllableClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { processTurn } from "../../src/daemon/turn-processor.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";
import type { BusEvent, Message } from "../../src/types.js";

function setup(): {
  db: Db;
  agentRepo: AgentRepo;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  clock: ControllableClock;
  bus: InMemoryBus;
  logger: CapturingLogger;
  inbound: Message;
  agentConfig: AgentConfig;
} {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
  const bus = new InMemoryBus();
  const logger = new CapturingLogger(clock);

  agentRepo.create({ id: "assistant", configPath: "/abs", createdAt: clock.nowIso() });
  const inbound: Message = {
    id: "m-1",
    agentId: "assistant",
    channel: "cli",
    direction: "in",
    body: "hello",
    turnId: null,
    traceId: "trace-1",
    createdAt: clock.nowIso(),
  };
  messageRepo.create(inbound);

  const agentConfig: AgentConfig = {
    name: "assistant",
    model: "claude-opus-4-7",
    imageTag: "teamroom-agent-assistant:latest",
    configPath: "/abs/agents/assistant",
    agentsMdPath: "/abs/agents/assistant/AGENTS.md",
    storePath: "/abs/agents/assistant/store",
  };

  return { db, agentRepo, messageRepo, turnRepo, clock, bus, logger, inbound, agentConfig };
}

describe("processTurn", () => {
  it("writes outbound messages for each reply event and marks turn done", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [
        { type: "reply", body: "first" },
        { type: "reply", body: "second" },
      ],
      exitCode: 0,
      stderr: "",
    }));

    const received: BusEvent[] = [];
    (async () => {
      for await (const e of s.bus.subscribe()) received.push(e);
    })();

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      anthropicApiKey: "sk-test",
      timeoutMs: 5000,
      genId: () => "generated-id",
    });

    // two outbound messages should exist
    const outbound = s.messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["first", "second"]);

    // inbound should have a turn attached
    const reread = s.messageRepo.findById("m-1");
    expect(reread?.turnId).not.toBeNull();

    // turn should be done
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("done");
    expect(turn?.finishedAt).toBeTruthy();

    // bus should have turn.started, 2x message.outbound, turn.completed
    // wait a tick so the subscriber drains
    await new Promise((r) => setTimeout(r, 10));
    const types = received.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types.filter((t) => t === "message.outbound")).toHaveLength(2);
    expect(types).toContain("turn.completed");
  });

  it("marks turn error when the container exits non-zero", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 1,
      stderr: "catastrophic",
    }));

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      anthropicApiKey: "sk-test",
      timeoutMs: 5000,
      genId: () => "generated-id",
    });

    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
    expect(turn?.error).toMatch(/exit=1/);
  });

  it("marks turn error with 'timeout' when the runner reports timeout", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [],
      exitCode: 137,
      stderr: "",
      timedOut: true,
    }));

    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      anthropicApiKey: "sk-test",
      timeoutMs: 100,
      genId: () => "generated-id",
    });
    const reread = s.messageRepo.findById("m-1");
    const turn = s.turnRepo.findById(reread!.turnId!);
    expect(turn?.status).toBe("error");
    expect(turn?.error).toBe("timeout");
  });

  it("does not crash on unknown stdout events — warns and drops", async () => {
    const s = setup();
    const runner = new FakeRunner(() => ({
      events: [
        { type: "unknown", raw: "gibberish" },
        { type: "reply", body: "real reply" },
      ],
      exitCode: 0,
      stderr: "",
    }));
    await processTurn({
      inbound: s.inbound,
      agentConfig: s.agentConfig,
      messageRepo: s.messageRepo,
      turnRepo: s.turnRepo,
      runner,
      bus: s.bus,
      logger: s.logger,
      clock: s.clock,
      anthropicApiKey: "sk-test",
      timeoutMs: 5000,
      genId: () => "generated-id",
    });
    const outbound = s.messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["real reply"]);
    const warns = s.logger.entries.filter((e) => e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/daemon/turn-processor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/daemon/turn-processor.ts`**

```ts
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { ContainerRunner } from "../container/container-runner.js";
import type { DockerRunSpec, Mount } from "../container/docker-command.js";
import type { Logger } from "../logger/logger.js";
import type { MessageRepo } from "../db/message-repo.js";
import type { TurnRepo } from "../db/turn-repo.js";
import type { Message } from "../types.js";

export interface ProcessTurnDeps {
  inbound: Message;
  agentConfig: AgentConfig;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  runner: ContainerRunner;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  anthropicApiKey: string;
  timeoutMs: number;
  genId: () => string;
}

export async function processTurn(deps: ProcessTurnDeps): Promise<void> {
  const {
    inbound, agentConfig, messageRepo, turnRepo, runner, bus, logger, clock,
    anthropicApiKey, timeoutMs, genId,
  } = deps;

  const turnId = genId();
  const now = clock.nowIso();
  const turnLogger = logger.child({
    component: "turn-processor",
    turnId,
    traceId: inbound.traceId,
    agentName: agentConfig.name,
  });

  // 1. Create the turn row
  turnRepo.create({
    id: turnId,
    agentId: inbound.agentId,
    inboundMessageId: inbound.id,
    status: "pending",
    containerId: null,
    error: null,
    traceId: inbound.traceId,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
  });
  messageRepo.attachTurn(inbound.id, turnId);
  turnLogger.info("turn created");

  // 2. Mark running (container id set after we get it back from the runner)
  // We mark running before spawning with a placeholder id, then update.
  // Simpler: emit turn.started now, call runner, then UPDATE on completion.

  await bus.publish({
    id: genId(),
    type: "turn.started",
    ts: clock.nowIso(),
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
  });

  const mounts: Mount[] = [
    { hostPath: agentConfig.agentsMdPath, containerPath: "/AGENTS.md", readOnly: true },
    { hostPath: agentConfig.storePath, containerPath: "/store", readOnly: false },
  ];
  const spec: DockerRunSpec = {
    imageTag: agentConfig.imageTag,
    mounts,
    env: {
      TEAMROOM_TRACE_ID: inbound.traceId,
      TEAMROOM_TURN_ID: turnId,
      TEAMROOM_AGENT_NAME: agentConfig.name,
      TEAMROOM_MODEL: agentConfig.model,
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
  };

  const stdinEnvelope = JSON.stringify({
    prompt: inbound.body,
    messageId: inbound.id,
    turnId,
    traceId: inbound.traceId,
  });

  let replyCount = 0;

  const result = await runner.run({
    spec,
    stdinJson: stdinEnvelope,
    timeoutMs,
    onEvent: (evt) => {
      try {
        if (evt.type === "reply") {
          const outId = genId();
          messageRepo.create({
            id: outId,
            agentId: inbound.agentId,
            channel: inbound.channel,
            direction: "out",
            body: evt.body,
            turnId,
            traceId: inbound.traceId,
            createdAt: clock.nowIso(),
          });
          replyCount += 1;
          void bus.publish({
            id: genId(),
            type: "message.outbound",
            ts: clock.nowIso(),
            agentId: inbound.agentId,
            messageId: outId,
            turnId,
            traceId: inbound.traceId,
          });
        } else if (evt.type === "status") {
          turnLogger.info("status", { phase: evt.phase });
        } else if (evt.type === "log") {
          turnLogger.info("agent-log", { level: evt.level, msg: evt.msg });
        } else {
          turnLogger.warn("unknown stdout event", { raw: (evt as { raw?: string }).raw });
        }
      } catch (err) {
        turnLogger.error("error handling stdout event", { error: String(err) });
      }
    },
  });

  // Attach containerId we got back (started_at is now set too)
  turnRepo.markRunning(turnId, result.containerId, clock.nowIso());

  if (result.timedOut) {
    turnRepo.markError(turnId, "timeout", clock.nowIso());
    await bus.publish({
      id: genId(),
      type: "turn.errored",
      ts: clock.nowIso(),
      agentId: inbound.agentId,
      turnId,
      traceId: inbound.traceId,
      error: "timeout",
    });
    turnLogger.warn("turn timed out");
    return;
  }

  if (result.exitCode !== 0) {
    const snippet = result.stderr.slice(-2048);
    const errorText = `exit=${result.exitCode}; stderr=${snippet}`;
    turnRepo.markError(turnId, errorText, clock.nowIso());
    await bus.publish({
      id: genId(),
      type: "turn.errored",
      ts: clock.nowIso(),
      agentId: inbound.agentId,
      turnId,
      traceId: inbound.traceId,
      error: errorText,
    });
    turnLogger.warn("turn errored", { exitCode: result.exitCode });
    return;
  }

  turnRepo.markDone(turnId, clock.nowIso());
  await bus.publish({
    id: genId(),
    type: "turn.completed",
    ts: clock.nowIso(),
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
  });
  turnLogger.info("turn done", { replyCount });
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/daemon/turn-processor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/turn-processor.ts tests/daemon/turn-processor.test.ts
git commit -m "feat(m1): processTurn — orchestrates one inbound → outbound via ContainerRunner, emits bus events"
```

---

## Task 15: Orchestrator (polling loop)

**Files:**
- Create: `src/daemon/orchestrator.ts`
- Create: `tests/daemon/orchestrator.test.ts`

The orchestrator polls for pending inbound messages and dispatches them to `processTurn`. It serializes per-agent (no parallel turns for the same agent at M1).

- [ ] **Step 1: Write failing tests**

`tests/daemon/orchestrator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import { ControllableClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";

const agentConfig: AgentConfig = {
  name: "assistant",
  model: "claude-opus-4-7",
  imageTag: "teamroom-agent-assistant:latest",
  configPath: "/abs/agents/assistant",
  agentsMdPath: "/abs/agents/assistant/AGENTS.md",
  storePath: "/abs/agents/assistant/store",
};

describe("Orchestrator", () => {
  it("picks up a pending inbound message and processes it", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner(() => ({
      events: [{ type: "reply", body: "pong" }],
      exitCode: 0,
      stderr: "",
    }));

    agentRepo.create({ id: "assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
      body: "ping", turnId: null, traceId: "tr-1", createdAt: clock.nowIso(),
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
    });

    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["pong"]);
  });

  it("processes pending messages in created_at order", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner((req) => {
      const envelope = JSON.parse(req.stdinJson) as { prompt: string };
      return {
        events: [{ type: "reply", body: `echo:${envelope.prompt}` }],
        exitCode: 0,
        stderr: "",
      };
    });

    agentRepo.create({ id: "assistant", configPath: "/abs", createdAt: clock.nowIso() });
    messageRepo.create({
      id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
      body: "first", turnId: null, traceId: "tr-1", createdAt: "2026-04-18T00:00:00.000Z",
    });
    messageRepo.create({
      id: "m-2", agentId: "assistant", channel: "cli", direction: "in",
      body: "second", turnId: null, traceId: "tr-2", createdAt: "2026-04-18T00:00:01.000Z",
    });

    let idCounter = 0;
    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => `gen-${++idCounter}`,
    });
    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["echo:first", "echo:second"]);
  });

  it("does nothing on tick when no pending messages", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const logger = new CapturingLogger(clock);
    const runner = new FakeRunner(() => {
      throw new Error("should not be called");
    });
    const orch = new Orchestrator({
      messageRepo: new MessageRepo(db),
      turnRepo: new TurnRepo(db),
      bus: new InMemoryBus(),
      logger, clock, runner,
      agentConfigs: new Map([["assistant", agentConfig]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => "x",
    });
    await orch.tickOnce(); // should be a no-op
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/daemon/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/daemon/orchestrator.ts`**

```ts
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { ContainerRunner } from "../container/container-runner.js";
import type { Logger } from "../logger/logger.js";
import type { MessageRepo } from "../db/message-repo.js";
import type { TurnRepo } from "../db/turn-repo.js";
import { processTurn } from "./turn-processor.js";

export interface OrchestratorDeps {
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  runner: ContainerRunner;
  agentConfigs: Map<string, AgentConfig>;
  anthropicApiKey: string;
  turnTimeoutMs: number;
  pollIntervalMs: number;
  genId: () => string;
}

export class Orchestrator {
  private stopping = false;
  constructor(private readonly deps: OrchestratorDeps) {}

  async tickOnce(): Promise<void> {
    const pending = this.deps.messageRepo.findPendingInbound();
    for (const message of pending) {
      const cfg = this.deps.agentConfigs.get(message.agentId);
      if (!cfg) {
        this.deps.logger.error("no agent config for pending message", {
          agentId: message.agentId,
          messageId: message.id,
        });
        continue;
      }
      try {
        await processTurn({
          inbound: message,
          agentConfig: cfg,
          messageRepo: this.deps.messageRepo,
          turnRepo: this.deps.turnRepo,
          runner: this.deps.runner,
          bus: this.deps.bus,
          logger: this.deps.logger,
          clock: this.deps.clock,
          anthropicApiKey: this.deps.anthropicApiKey,
          timeoutMs: this.deps.turnTimeoutMs,
          genId: this.deps.genId,
        });
      } catch (err) {
        // Safety net — processTurn should not throw, but if it does, don't crash the loop.
        this.deps.logger.error("processTurn threw — continuing", {
          messageId: message.id,
          error: String(err),
        });
      }
    }
  }

  async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.tickOnce();
      await new Promise<void>((resolve) => setTimeout(resolve, this.deps.pollIntervalMs));
    }
  }

  stop(): void {
    this.stopping = true;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/daemon/orchestrator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts tests/daemon/orchestrator.test.ts
git commit -m "feat(m1): Orchestrator — tickOnce() and runLoop(), serializes turn processing"
```

---

## Task 16: Reconcile on startup

**Files:**
- Create: `src/daemon/reconcile.ts`
- Create: `tests/daemon/reconcile.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/daemon/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { ControllableClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { reconcile } from "../../src/daemon/reconcile.js";
import type { BusEvent } from "../../src/types.js";

function seedOrphan(
  clock: ControllableClock,
): { db: ReturnType<typeof createDatabase>; turnRepo: TurnRepo; messageRepo: MessageRepo; bus: InMemoryBus; logger: CapturingLogger } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const now = clock.nowIso();
  new AgentRepo(db).create({ id: "assistant", configPath: "/abs", createdAt: now });
  const messageRepo = new MessageRepo(db);
  messageRepo.create({
    id: "m-1", agentId: "assistant", channel: "cli", direction: "in",
    body: "a", turnId: "t-1", traceId: "tr-1", createdAt: now,
  });
  const turnRepo = new TurnRepo(db);
  turnRepo.create({
    id: "t-1", agentId: "assistant", inboundMessageId: "m-1", status: "running",
    containerId: "c-x", error: null, traceId: "tr-1",
    startedAt: now, finishedAt: null, createdAt: now,
  });
  return { db, turnRepo, messageRepo, bus: new InMemoryBus(), logger: new CapturingLogger(clock) };
}

describe("reconcile", () => {
  it("marks running turns as errored with 'daemon_restart'", async () => {
    const clock = new ControllableClock("2026-04-18T00:00:10.000Z");
    const { turnRepo, bus, logger } = seedOrphan(clock);
    const events: BusEvent[] = [];
    (async () => {
      for await (const e of bus.subscribe()) events.push(e);
    })();

    await reconcile({ turnRepo, bus, logger, clock, genId: () => "evt-1" });

    const t = turnRepo.findById("t-1");
    expect(t?.status).toBe("error");
    expect(t?.error).toBe("daemon_restart");

    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "turn.errored")).toBe(true);
  });

  it("no-ops when nothing is running", async () => {
    const clock = new ControllableClock("2026-04-18T00:00:00.000Z");
    const db = createDatabase(":memory:");
    runMigrations(db);
    const turnRepo = new TurnRepo(db);
    const bus = new InMemoryBus();
    const logger = new CapturingLogger(clock);
    await reconcile({ turnRepo, bus, logger, clock, genId: () => "x" });
    // no assertion error is the test
    expect(turnRepo.findByStatus("running")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/daemon/reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/daemon/reconcile.ts`**

```ts
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../logger/logger.js";
import type { TurnRepo } from "../db/turn-repo.js";

export interface ReconcileDeps {
  turnRepo: TurnRepo;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  genId: () => string;
}

export async function reconcile(deps: ReconcileDeps): Promise<void> {
  const orphans = deps.turnRepo.findByStatus("running");
  if (orphans.length === 0) {
    deps.logger.info("reconcile: no orphan turns");
    return;
  }
  deps.logger.warn("reconcile: found orphan running turns", { count: orphans.length });
  for (const turn of orphans) {
    const now = deps.clock.nowIso();
    deps.turnRepo.markError(turn.id, "daemon_restart", now);
    await deps.bus.publish({
      id: deps.genId(),
      type: "turn.errored",
      ts: now,
      agentId: turn.agentId,
      turnId: turn.id,
      traceId: turn.traceId,
      error: "daemon_restart",
    });
    deps.logger.warn("reconcile: marked orphan errored", { turnId: turn.id });
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/daemon/reconcile.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/reconcile.ts tests/daemon/reconcile.test.ts
git commit -m "feat(m1): reconcile — on boot, mark orphan running turns as error with 'daemon_restart'"
```

---

## Task 17: Safety nets (global error handlers)

**Files:**
- Create: `src/daemon/safety-nets.ts`

No unit test for this module — it registers global `process` handlers, which vitest can't safely exercise without cross-test interference. The behavior is verified manually via the smoke test.

- [ ] **Step 1: Create `src/daemon/safety-nets.ts`**

```ts
import type { Logger } from "../logger/logger.js";

export function installSafetyNets(logger: Logger): void {
  process.on("uncaughtException", (err) => {
    logger.fatal("uncaughtException (daemon does not exit)", {
      error: String(err),
      stack: err?.stack,
    });
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal("unhandledRejection (daemon does not exit)", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/safety-nets.ts
git commit -m "feat(m1): safety-nets — global handlers that log fatal and do not exit"
```

---

## Task 18: Daemon composition root + entry

**Files:**
- Create: `src/daemon/daemon.ts`
- Create: `src/daemon/main.ts`

This is the wiring that boots everything. Not directly unit-tested — the integration test in Task 25 covers it. Keep it boring.

- [ ] **Step 1: Create `src/daemon/daemon.ts`**

```ts
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
import { SystemClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
import { reconcile } from "./reconcile.js";
import { Orchestrator } from "./orchestrator.js";

export interface DaemonOptions {
  dataDir: string;          // e.g. <repo>/data
  agentsDir: string;        // e.g. <repo>/agents
  anthropicApiKey: string;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "bus"), { recursive: true });
  mkdirSync(join(opts.dataDir, "logs"), { recursive: true });

  const clock = new SystemClock();
  const dateStr = clock.nowIso().slice(0, 10);
  const logFile = join(opts.dataDir, "logs", `teamroom-${dateStr}.jsonl`);
  const logSink = (line: string) => {
    process.stdout.write(line + "\n");
    appendFileSync(logFile, line + "\n");
  };
  const rootLogger = new JsonLinesLogger(clock, logSink, { component: "daemon" });
  installSafetyNets(rootLogger);

  // PID file
  writeFileSync(join(opts.dataDir, "teamroom.pid"), String(process.pid));

  const db = createDatabase(join(opts.dataDir, "teamroom.db"));
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const bus = new FileNotifyBus(join(opts.dataDir, "bus"));

  // Discover and register each agent folder under agentsDir.
  const agentConfigs = new Map<string, AgentConfig>();
  if (existsSync(opts.agentsDir)) {
    const { readdirSync, statSync } = await import("node:fs");
    for (const entry of readdirSync(opts.agentsDir)) {
      const full = join(opts.agentsDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const cfg = loadAgentConfig(full);
      agentConfigs.set(cfg.name, cfg);
      if (!agentRepo.findById(cfg.name)) {
        agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });
      }
      rootLogger.info("agent registered", { agentName: cfg.name });
    }
  }

  const genId = () => randomUUID();

  await reconcile({ turnRepo, bus, logger: rootLogger, clock, genId });

  const runner = new DockerRunner();
  const orchestrator = new Orchestrator({
    messageRepo, turnRepo, bus, logger: rootLogger, clock, runner,
    agentConfigs,
    anthropicApiKey: opts.anthropicApiKey,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
  });

  // Fire-and-forget loop. Errors inside the loop are logged; the loop itself never throws.
  const loopPromise = orchestrator.runLoop().catch((err) => {
    rootLogger.fatal("orchestrator loop exited abnormally (daemon does not exit)", { error: String(err) });
  });

  const stop = async () => {
    orchestrator.stop();
    await loopPromise;
    await bus.close();
    db.close();
  };

  return { db, stop, orchestrator };
}
```

- [ ] **Step 2: Create `src/daemon/main.ts`**

```ts
import { join, resolve } from "node:path";
import { startDaemon } from "./daemon.js";

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY is required\n");
    process.exit(1);
  }

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    anthropicApiKey: apiKey,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // keep alive
  await new Promise(() => {});
}

void main();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/daemon.ts src/daemon/main.ts
git commit -m "feat(m1): daemon composition root and main entrypoint"
```

---

## Task 19: CLI bootstrap + serve

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/serve.ts`

- [ ] **Step 1: Create `src/cli/serve.ts`**

`serve` is a thin wrapper that spawns the daemon in the same process. It's exported as an async function so the CLI main can await it for error handling.

```ts
import { join, resolve } from "node:path";
import { startDaemon } from "../daemon/daemon.js";

export async function serve(): Promise<void> {
  const root = resolve(process.cwd());
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY is required\n");
    process.exit(1);
  }

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    anthropicApiKey: apiKey,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
```

- [ ] **Step 2: Create `src/cli/main.ts` (stub that wires commander; `send`/`tail`/`status` added in subsequent tasks)**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { serve } from "./serve.js";
import { send } from "./send.js";
import { tail } from "./tail.js";
import { status } from "./status.js";

const program = new Command();
program.name("teamroom").description("Team Room CLI").version("0.1.0");

program.command("serve").description("Run the daemon in the foreground").action(serve);

program
  .command("send <text...>")
  .description("Queue an inbound message for the sole agent")
  .action(async (text: string[]) => {
    await send(text.join(" "));
  });

program
  .command("tail")
  .description("Stream outbound messages as they arrive")
  .option("--json", "emit raw JSON events")
  .option("--verbose", "include trace/turn IDs")
  .action(async (opts: { json?: boolean; verbose?: boolean }) => {
    await tail({ json: !!opts.json, verbose: !!opts.verbose });
  });

program.command("status").description("Show daemon/turn status").action(status);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

Note: `send.ts`, `tail.ts`, `status.ts` are imported but not yet created — tasks 20–22 add them. Typecheck will fail until those land. That's fine; we commit each as we go.

- [ ] **Step 3: Commit the CLI bootstrap (serve only — other commands follow)**

```bash
git add src/cli/serve.ts src/cli/main.ts
git commit -m "feat(m1): CLI bootstrap (commander) with serve command"
```

---

## Task 20: CLI — `send`

**Files:**
- Create: `src/cli/send.ts`
- Create: `tests/cli/send.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/cli/send.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToDb } from "../../src/cli/send.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";

describe("sendToDb", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-send-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "agents", "assistant", "store"), { recursive: true });
    writeFileSync(join(dir, "agents", "assistant", "AGENTS.md"), "prompt");
    writeFileSync(
      join(dir, "agents", "assistant", "agent.yaml"),
      "name: assistant\nmodel: m\nimage_tag: img\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("inserts an inbound message for the sole agent", async () => {
    const result = await sendToDb({ repoRoot: dir, body: "hello" });
    expect(result.traceId).toMatch(/^[0-9a-f-]+$/);

    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const inbound = new MessageRepo(db).findPendingInbound();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.body).toBe("hello");
    expect(inbound[0]?.channel).toBe("cli");
    expect(inbound[0]?.direction).toBe("in");
    expect(inbound[0]?.agentId).toBe("assistant");
  });

  it("creates the agent row lazily if the daemon hasn't yet", async () => {
    await sendToDb({ repoRoot: dir, body: "a" });
    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    const agents = new AgentRepo(db).findAll();
    expect(agents.map((a) => a.id)).toEqual(["assistant"]);
  });

  it("rejects if no agents folder is present", async () => {
    rmSync(join(dir, "agents"), { recursive: true });
    await expect(sendToDb({ repoRoot: dir, body: "x" })).rejects.toThrow(/no agent/);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/cli/send.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/cli/send.ts`**

```ts
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { loadAgentConfig } from "../agent-config/agent-config.js";

export interface SendToDbResult {
  traceId: string;
  messageId: string;
  agentName: string;
  daemonRunning: boolean;
}

export interface SendToDbOpts {
  repoRoot: string;
  body: string;
}

export async function sendToDb(opts: SendToDbOpts): Promise<SendToDbResult> {
  const root = resolve(opts.repoRoot);
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) throw new Error(`no agents/ directory at ${agentsDir}`);

  const entries = readdirSync(agentsDir).filter((e) => statSync(join(agentsDir, e)).isDirectory());
  if (entries.length === 0) throw new Error("no agent folders found");
  const entry = entries[0]!;
  const cfg = loadAgentConfig(join(agentsDir, entry));

  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = createDatabase(join(dataDir, "teamroom.db"));
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  if (!agentRepo.findById(cfg.name)) {
    agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: new Date().toISOString() });
  }
  const messageId = randomUUID();
  const traceId = randomUUID();
  new MessageRepo(db).create({
    id: messageId,
    agentId: cfg.name,
    channel: "cli",
    direction: "in",
    body: opts.body,
    turnId: null,
    traceId,
    createdAt: new Date().toISOString(),
  });
  db.close();

  const daemonRunning = existsSync(join(dataDir, "teamroom.pid"));

  return { traceId, messageId, agentName: cfg.name, daemonRunning };
}

export async function send(body: string): Promise<void> {
  const result = await sendToDb({ repoRoot: process.cwd(), body });
  process.stdout.write(
    `queued for ${result.agentName} (trace: ${result.traceId})${
      result.daemonRunning ? "" : "  [warning: daemon not running — message will be processed when daemon starts]"
    }\n`,
  );
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/cli/send.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/send.ts tests/cli/send.test.ts
git commit -m "feat(m1): CLI send command — queues inbound message in DB; warns if daemon down"
```

---

## Task 21: CLI — `tail`

**Files:**
- Create: `src/cli/tail.ts`
- Create: `tests/cli/tail.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/cli/tail.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailRun } from "../../src/cli/tail.js";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { FileNotifyBus } from "../../src/bus/file-notify-bus.js";

describe("tailRun", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-tail-"));
    mkdirSync(join(dir, "data", "bus"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints outbound messages as they are published on the bus", async () => {
    const db = createDatabase(join(dir, "data", "teamroom.db"));
    runMigrations(db);
    new AgentRepo(db).create({ id: "assistant", configPath: "/abs", createdAt: "2026-04-18T00:00:00.000Z" });
    const messageRepo = new MessageRepo(db);
    messageRepo.create({
      id: "o-1", agentId: "assistant", channel: "cli", direction: "out",
      body: "hello world", turnId: "t-1", traceId: "tr-1",
      createdAt: new Date().toISOString(),
    });
    db.close();

    const bus = new FileNotifyBus(join(dir, "data", "bus"));
    const output: string[] = [];
    const run = tailRun({
      repoRoot: dir,
      options: { json: false, verbose: false },
      out: (line) => output.push(line),
      stopAfter: 1,
    });

    // Wait a tick so subscribe is registered, then publish
    await new Promise((r) => setTimeout(r, 100));
    await bus.publish({
      id: "e-1",
      type: "message.outbound",
      ts: new Date().toISOString(),
      agentId: "assistant",
      messageId: "o-1",
      turnId: "t-1",
      traceId: "tr-1",
    });

    await run;
    await bus.close();

    expect(output.some((l) => l.includes("hello world"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/cli/tail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/cli/tail.ts`**

```ts
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { MessageRepo } from "../db/message-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import type { BusEvent, MessageOutboundEvent } from "../types.js";

export interface TailOptions {
  json: boolean;
  verbose: boolean;
}

export interface TailRunArgs {
  repoRoot: string;
  options: TailOptions;
  out: (line: string) => void;
  stopAfter?: number;                // test hook — exit after N events
}

export async function tailRun(args: TailRunArgs): Promise<void> {
  const root = resolve(args.repoRoot);
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const busDir = join(dataDir, "bus");
  if (!existsSync(busDir)) mkdirSync(busDir, { recursive: true });
  const dbPath = join(dataDir, "teamroom.db");

  const db = createDatabase(dbPath);
  runMigrations(db);
  const messageRepo = new MessageRepo(db);

  const bus = new FileNotifyBus(busDir);

  let count = 0;
  try {
    for await (const event of bus.subscribe((e) => e.type === "message.outbound")) {
      const m = event as MessageOutboundEvent;
      const msg = messageRepo.findById(m.messageId);
      if (!msg) continue;

      if (args.options.json) {
        args.out(JSON.stringify({ ...event, body: msg.body }));
      } else {
        const prefix = args.options.verbose
          ? `[${m.traceId.slice(0, 8)} turn=${m.turnId.slice(0, 8)}] `
          : "";
        args.out(`${prefix}${msg.body}`);
      }
      count += 1;
      if (args.stopAfter && count >= args.stopAfter) break;
    }
  } finally {
    await bus.close();
    db.close();
  }
}

export async function tail(options: TailOptions): Promise<void> {
  await tailRun({
    repoRoot: process.cwd(),
    options,
    out: (line) => process.stdout.write(line + "\n"),
  });
}

export type { BusEvent };
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/cli/tail.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/cli/tail.ts tests/cli/tail.test.ts
git commit -m "feat(m1): CLI tail command — subscribes to FileNotifyBus, fetches bodies from DB"
```

---

## Task 22: CLI — `status`

**Files:**
- Create: `src/cli/status.ts`

- [ ] **Step 1: Create `src/cli/status.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { TurnRepo } from "../db/turn-repo.js";

export async function status(): Promise<void> {
  const root = resolve(process.cwd());
  const dataDir = join(root, "data");
  const pidFile = join(dataDir, "teamroom.pid");

  const daemonUp = existsSync(pidFile) && pidAlive(Number(readFileSync(pidFile, "utf8").trim()));
  process.stdout.write(`daemon:     ${daemonUp ? "running" : "not running"}\n`);

  const dbPath = join(dataDir, "teamroom.db");
  if (!existsSync(dbPath)) {
    process.stdout.write("database:   (none yet)\n");
    process.exit(daemonUp ? 0 : 1);
  }

  const db = createDatabase(dbPath);
  runMigrations(db);
  const turnRepo = new TurnRepo(db);
  const agents = new AgentRepo(db).findAll();

  process.stdout.write(`agents:     ${agents.map((a) => a.id).join(", ") || "(none)"}\n`);
  process.stdout.write(`pending:    ${turnRepo.countByStatus("pending")}\n`);
  process.stdout.write(`running:    ${turnRepo.countByStatus("running")}\n`);
  process.stdout.write(`done:       ${turnRepo.countByStatus("done")}\n`);
  process.stdout.write(`errors:     ${turnRepo.countByStatus("error")}\n`);

  const latest = turnRepo.latestDone();
  process.stdout.write(`last turn:  ${latest?.finishedAt ?? "(never)"}\n`);

  db.close();
  process.exit(daemonUp ? 0 : 1);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (all three CLI commands now resolved; `src/cli/main.ts` compiles).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: produces `dist/` with all compiled output.

- [ ] **Step 4: Commit**

```bash
git add src/cli/status.ts
git commit -m "feat(m1): CLI status command — daemon liveness + per-status turn counts"
```

---

## Task 23: Agent runtime — session store + core turn + entry

**Files:**
- Create: `src/agent-runtime/session-store.ts`
- Create: `src/agent-runtime/runtime.ts`
- Create: `src/agent-runtime/main.ts`
- Create: `tests/agent-runtime/session-store.test.ts`
- Create: `tests/agent-runtime/runtime.test.ts`

The agent runtime runs *inside* the container. It reads one JSON envelope on stdin, calls the Anthropic API with prior conversation history loaded from `/store/conversation.jsonl`, streams `reply` events to stdout, appends new messages to the conversation file, and exits.

The core `runTurn` function takes an `AnthropicClient` interface so tests inject a fake. `main.ts` wires in the real Anthropic SDK.

### 23a. session-store

- [ ] **Step 1: Write failing tests**

`tests/agent-runtime/session-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConversation, appendMessage } from "../../src/agent-runtime/session-store.js";

describe("session-store", () => {
  let file: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "tr-session-"));
    file = join(dir, "conversation.jsonl");
  });

  afterEach(() => rmSync(file, { force: true }));

  it("returns empty history when file missing", () => {
    expect(loadConversation(file)).toEqual([]);
  });

  it("loads lines into message history", () => {
    writeFileSync(
      file,
      `${JSON.stringify({ role: "user", content: "hi" })}\n${JSON.stringify({ role: "assistant", content: "hello" })}\n`,
    );
    expect(loadConversation(file)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("ignores malformed lines", () => {
    writeFileSync(file, `garbage\n${JSON.stringify({ role: "user", content: "ok" })}\n`);
    expect(loadConversation(file)).toEqual([{ role: "user", content: "ok" }]);
  });

  it("appendMessage adds one line atomically", () => {
    appendMessage(file, { role: "user", content: "a" });
    appendMessage(file, { role: "assistant", content: "b" });
    expect(loadConversation(file)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run tests/agent-runtime/session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/agent-runtime/session-store.ts`**

```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export function loadConversation(path: string): ConversationMessage[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, "utf8");
  const out: ConversationMessage[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as ConversationMessage;
      if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.content === "string") {
        out.push(parsed);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function appendMessage(path: string, message: ConversationMessage): void {
  appendFileSync(path, JSON.stringify(message) + "\n");
}
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run tests/agent-runtime/session-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/session-store.ts tests/agent-runtime/session-store.test.ts
git commit -m "feat(m1): agent-runtime session store — conversation.jsonl load/append"
```

### 23b. runtime (pure turn function, DI-testable)

- [ ] **Step 6: Write failing tests**

`tests/agent-runtime/runtime.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn, type AnthropicClient } from "../../src/agent-runtime/runtime.js";
import { loadConversation } from "../../src/agent-runtime/session-store.js";

describe("runTurn", () => {
  let dir: string;
  let convFile: string;
  let agentsMd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-runtime-"));
    convFile = join(dir, "conversation.jsonl");
    agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "You are a friendly assistant.");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("calls Anthropic, emits reply event, persists user + assistant to conversation.jsonl", async () => {
    const calls: { system: string; messages: unknown[] }[] = [];
    const client: AnthropicClient = {
      async createMessage({ system, messages, model }) {
        calls.push({ system, messages });
        expect(model).toBe("claude-opus-4-7");
        return { text: "hi there" };
      },
    };
    const events: string[] = [];
    await runTurn({
      envelope: { prompt: "hello", messageId: "m1", turnId: "t1", traceId: "tr1" },
      client,
      model: "claude-opus-4-7",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: (line) => events.push(line),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("friendly assistant");
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "hello" }]);

    const parsed = events.map((e) => JSON.parse(e) as { type: string; body?: string });
    expect(parsed).toEqual([{ type: "reply", body: "hi there", messageId: "m1" }]);

    expect(loadConversation(convFile)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("includes prior conversation on subsequent turns", async () => {
    writeFileSync(
      convFile,
      `${JSON.stringify({ role: "user", content: "a" })}\n${JSON.stringify({ role: "assistant", content: "b" })}\n`,
    );
    let captured: unknown[] = [];
    const client: AnthropicClient = {
      async createMessage({ messages }) {
        captured = messages;
        return { text: "c" };
      },
    };
    await runTurn({
      envelope: { prompt: "x", messageId: "m2", turnId: "t2", traceId: "tr2" },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    expect(captured).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "x" },
    ]);
  });

  it("uses a default system prompt if AGENTS.md is missing", async () => {
    rmSync(agentsMd);
    let captured = "";
    const client: AnthropicClient = {
      async createMessage({ system }) {
        captured = system;
        return { text: "ok" };
      },
    };
    await runTurn({
      envelope: { prompt: "hi", messageId: "m1", turnId: "t1", traceId: "tr1" },
      client,
      model: "m",
      agentsMdPath: agentsMd,
      conversationPath: convFile,
      emit: () => {},
    });
    expect(captured.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run — expect fail**

Run: `npx vitest run tests/agent-runtime/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Create `src/agent-runtime/runtime.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { appendMessage, loadConversation, type ConversationMessage } from "./session-store.js";

export interface Envelope {
  prompt: string;
  messageId: string;
  turnId: string;
  traceId: string;
}

export interface AnthropicCreateArgs {
  model: string;
  system: string;
  messages: ConversationMessage[];
}

export interface AnthropicCreateResult {
  text: string;
}

export interface AnthropicClient {
  createMessage(args: AnthropicCreateArgs): Promise<AnthropicCreateResult>;
}

export interface RunTurnDeps {
  envelope: Envelope;
  client: AnthropicClient;
  model: string;
  agentsMdPath: string;
  conversationPath: string;
  emit: (jsonLine: string) => void;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. Respond to the user's message directly and concisely.";

export async function runTurn(deps: RunTurnDeps): Promise<void> {
  const system = existsSync(deps.agentsMdPath)
    ? readFileSync(deps.agentsMdPath, "utf8")
    : DEFAULT_SYSTEM_PROMPT;

  const prior = loadConversation(deps.conversationPath);
  const userMessage: ConversationMessage = { role: "user", content: deps.envelope.prompt };
  const messages = [...prior, userMessage];

  appendMessage(deps.conversationPath, userMessage);

  const result = await deps.client.createMessage({
    model: deps.model,
    system,
    messages,
  });

  const assistantMessage: ConversationMessage = { role: "assistant", content: result.text };
  appendMessage(deps.conversationPath, assistantMessage);

  deps.emit(
    JSON.stringify({
      type: "reply",
      body: result.text,
      messageId: deps.envelope.messageId,
    }),
  );
}
```

- [ ] **Step 9: Run — expect pass**

Run: `npx vitest run tests/agent-runtime/runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add src/agent-runtime/runtime.ts tests/agent-runtime/runtime.test.ts
git commit -m "feat(m1): agent-runtime runTurn — load history, call Anthropic, emit reply, persist"
```

### 23c. main entry + Anthropic adapter

- [ ] **Step 11: Create `src/agent-runtime/main.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { runTurn, type AnthropicClient, type Envelope } from "./runtime.js";

const AGENTS_MD = "/AGENTS.md";
const CONVERSATION_PATH = "/store/conversation.jsonl";

async function readStdinOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function makeAnthropicAdapter(): AnthropicClient {
  const sdk = new Anthropic();
  return {
    async createMessage({ model, system, messages }) {
      const resp = await sdk.messages.create({
        model,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: 1024,
      });
      const text = resp.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text };
    },
  };
}

async function main(): Promise<void> {
  try {
    const raw = await readStdinOnce();
    const envelope = JSON.parse(raw.trim()) as Envelope;
    const model = process.env.TEAMROOM_MODEL ?? "claude-opus-4-7";
    const client = makeAnthropicAdapter();
    await runTurn({
      envelope,
      client,
      model,
      agentsMdPath: AGENTS_MD,
      conversationPath: CONVERSATION_PATH,
      emit: (line) => process.stdout.write(line + "\n"),
    });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-runtime fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(2);
  }
}

void main();
```

- [ ] **Step 12: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean; `dist/agent-runtime/main.js` exists.

- [ ] **Step 13: Commit**

```bash
git add src/agent-runtime/main.ts
git commit -m "feat(m1): agent-runtime main — reads stdin, dispatches to runTurn with real Anthropic SDK"
```

---

## Task 24: First hand-crafted agent — `assistant`

**Files:**
- Create: `agents/assistant/Dockerfile`
- Create: `agents/assistant/agent.yaml`
- Create: `agents/assistant/AGENTS.md`
- Create: `agents/assistant/store/.gitkeep`

- [ ] **Step 1: Create `agents/assistant/agent.yaml`**

```yaml
name: assistant
model: claude-opus-4-7
image_tag: teamroom-agent-assistant:latest
```

- [ ] **Step 2: Create `agents/assistant/AGENTS.md`**

```markdown
You are the first agent in Team Room — a helpful assistant.

Behave like a capable, concise collaborator. Keep responses brief unless the user asks for depth. You have access to `/store/` as your writable scratch space; feel free to leave notes for yourself between turns. The file `/store/conversation.jsonl` is your conversation history and is maintained by the runtime — you do not need to manage it yourself.

When you don't know something, say so. When you make a decision, name it. You are running inside a container that will be torn down at the end of each turn; durable memory lives in `/store/` and in the conversation history.
```

- [ ] **Step 3: Create `agents/assistant/store/.gitkeep`**

Empty file. Ensures the directory exists after clone even though `store/` itself is gitignored.

```bash
touch agents/assistant/store/.gitkeep
```

- [ ] **Step 4: Create `agents/assistant/Dockerfile`**

Dockerfile context is the repo root, so paths are relative to it.

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install production deps for the agent runtime (must match repo package.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled agent-runtime from dist/.
COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
```

- [ ] **Step 5: Verify the image builds**

Prerequisite: `npm run build` has produced `dist/`.

Run from repo root:

```bash
npm run build
docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .
```

Expected: image builds successfully.

- [ ] **Step 6: Commit**

```bash
git add agents/assistant/
git commit -m "feat(m1): first hand-crafted agent 'assistant' — AGENTS.md, agent.yaml, Dockerfile"
```

---

## Task 25: End-to-end integration test

**Files:**
- Create: `tests/integration/end-to-end.test.ts`

A full-stack test with all test implementations composed. Proves the assembled system works, without hitting Docker or Anthropic.

- [ ] **Step 1: Write the test**

`tests/integration/end-to-end.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { InMemoryBus } from "../../src/bus/in-memory-bus.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import { SystemClock } from "../../src/clock/clock.js";
import { CapturingLogger } from "../../src/logger/logger.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import { loadAgentConfig } from "../../src/agent-config/agent-config.js";
import { randomUUID } from "node:crypto";

describe("end-to-end (stack assembled with test implementations)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-e2e-"));
    mkdirSync(join(dir, "agents", "assistant", "store"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "assistant", "AGENTS.md"),
      "You are a test agent.",
    );
    writeFileSync(
      join(dir, "agents", "assistant", "agent.yaml"),
      "name: assistant\nmodel: m\nimage_tag: img\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("processes an inbound CLI message end-to-end and produces a tailable reply", async () => {
    const clock = new SystemClock();
    const db = createDatabase(":memory:");
    runMigrations(db);
    const agentRepo = new AgentRepo(db);
    const messageRepo = new MessageRepo(db);
    const turnRepo = new TurnRepo(db);
    const logger = new CapturingLogger(clock);
    const bus = new InMemoryBus();
    const cfg = loadAgentConfig(join(dir, "agents", "assistant"));

    agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });

    // seed an inbound message
    const inboundId = randomUUID();
    messageRepo.create({
      id: inboundId,
      agentId: cfg.name,
      channel: "cli",
      direction: "in",
      body: "say hello",
      turnId: null,
      traceId: randomUUID(),
      createdAt: clock.nowIso(),
    });

    const runner = new FakeRunner((req) => {
      const env = JSON.parse(req.stdinJson) as { prompt: string };
      return {
        events: [{ type: "reply", body: `echo:${env.prompt}` }],
        exitCode: 0,
        stderr: "",
      };
    });

    const orch = new Orchestrator({
      messageRepo, turnRepo, bus, logger, clock, runner,
      agentConfigs: new Map([[cfg.name, cfg]]),
      anthropicApiKey: "sk-test",
      turnTimeoutMs: 5000,
      pollIntervalMs: 50,
      genId: () => randomUUID(),
    });

    await orch.tickOnce();

    const outbound = messageRepo.findOutboundAfter(null);
    expect(outbound.map((m) => m.body)).toEqual(["echo:say hello"]);
    expect(messageRepo.findById(inboundId)?.turnId).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/end-to-end.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (all tasks aggregated).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "test(m1): end-to-end integration — stack assembled with test implementations"
```

---

## Task 26: Smoke test script (manual, real Docker + real Anthropic)

**Files:**
- Create: `scripts/smoke-test.sh`

Not run in CI. Verifies the full stack with real Docker and a real Anthropic key.

- [ ] **Step 1: Create `scripts/smoke-test.sh`**

```bash
#!/usr/bin/env bash
# M1 smoke test — exercises the full stack end-to-end.
# Requires: ANTHROPIC_API_KEY set; Docker running.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY is required" >&2
  exit 1
fi

echo "==> Building TypeScript"
npm run build

echo "==> Building agent image"
docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .

echo "==> Starting daemon in background"
rm -rf data
node dist/cli/main.js serve &
DAEMON_PID=$!
trap "kill $DAEMON_PID 2>/dev/null || true; wait 2>/dev/null || true" EXIT

# Wait for the daemon to signal it's up (pid file + agent registration).
for _ in $(seq 1 50); do
  [[ -f data/teamroom.pid ]] && break
  sleep 0.1
done
if [[ ! -f data/teamroom.pid ]]; then
  echo "daemon failed to start" >&2
  exit 1
fi

echo "==> Starting tail in background"
node dist/cli/main.js tail > /tmp/teamroom-smoke-output.txt &
TAIL_PID=$!

sleep 0.5

echo "==> Sending a message"
node dist/cli/main.js send "Hello from the smoke test — reply with exactly: hello back"

echo "==> Waiting for reply (up to 60s)"
for _ in $(seq 1 120); do
  if grep -q "hello back" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
    break
  fi
  sleep 0.5
done

kill "$TAIL_PID" 2>/dev/null || true

echo "==> Output:"
cat /tmp/teamroom-smoke-output.txt

if grep -q "hello back" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
  echo "==> SMOKE PASS"
else
  echo "==> SMOKE FAIL — expected reply not found" >&2
  exit 1
fi

echo "==> Stopping daemon"
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/smoke-test.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-test.sh
git commit -m "feat(m1): smoke-test.sh — manual end-to-end with real Docker and real Anthropic"
```

---

## Task 27: Module READMEs + root README polish

**Files:**
- Create: `src/README.md`
- Create: `src/db/README.md`
- Create: `src/bus/README.md`
- Create: `src/container/README.md`
- Create: `src/daemon/README.md`
- Create: `src/cli/README.md`
- Create: `src/agent-runtime/README.md`
- Modify: `README.md` (repo root)

These READMEs are semantic-memory anchor points per `docs/ways-of-working.md`. Each is short and links to the spec / plan sections that define it. Keep them under 20 lines.

- [ ] **Step 1: Create `src/README.md`**

```markdown
# `src/` — Team Room source

- `types.ts` — shared domain types (Message, Turn, Agent, BusEvent).
- `clock/`, `logger/` — small effect-wrapping modules shared across the codebase.
- `db/` — SQLite schema, migrations, repositories.
- `bus/` — `NotifyBus` seam; `FileNotifyBus` production impl, `InMemoryBus` for tests.
- `container/` — `ContainerRunner` seam; `DockerRunner` production, `FakeRunner` for tests.
- `agent-config/` — loads `agents/<name>/agent.yaml`.
- `daemon/` — the orchestrator process (composition root, turn processor, reconcile).
- `cli/` — `teamroom` binary (`serve`, `send`, `tail`, `status`).
- `agent-runtime/` — the shim that runs *inside* each agent container.

See `docs/specs/2026-04-18-teamroom-m1-design.md` for the design and `docs/plans/2026-04-18-teamroom-m1-plan.md` for the plan this code was built against.
```

- [ ] **Step 2: Create `src/db/README.md`**

```markdown
# `db/` — SQLite layer

Every effectful SQL call goes through one of three repositories: `AgentRepo`, `MessageRepo`, `TurnRepo`. `createDatabase(dsn)` is the factory (accepts `:memory:` for tests or a file path for production). `runMigrations(db)` applies numbered SQL files from `migrations/` on boot.

The schema is owned by the design spec (`docs/specs/2026-04-18-teamroom-m1-design.md` §6). Three tables — `agents`, `messages`, `turns` — plus a `_migrations` ledger.
```

- [ ] **Step 3: Create `src/bus/README.md`**

```markdown
# `bus/` — NotifyBus seam

`NotifyBus` is the interface; events are notifications, not payloads (bodies live in the DB). Production: `FileNotifyBus` (chokidar-polled `events.jsonl` + `.notify` file). Tests: `InMemoryBus` (EventEmitter-like).

M1 scope: no topic registry, no durable delivery, no cross-process subscription coordination. The interface is the seam M3 will upgrade behind.
```

- [ ] **Step 4: Create `src/container/README.md`**

```markdown
# `container/` — ContainerRunner seam

`ContainerRunner` abstracts the "spawn one turn, collect events, exit" operation. `DockerRunner` spawns real `docker run`; `FakeRunner` replays scripted events for tests. `docker-command.ts` is a pure argv builder — the unit-testable portion of the real runner.

The agent container's contract (mounts, env, stdin/stdout JSONL protocol) is specified in `docs/specs/2026-04-18-teamroom-m1-design.md` §9.
```

- [ ] **Step 5: Create `src/daemon/README.md`**

```markdown
# `daemon/` — the orchestrator

- `daemon.ts` — composition root (`startDaemon(opts)`).
- `orchestrator.ts` — polling loop that picks up pending inbound messages.
- `turn-processor.ts` — processes one inbound → 0..N outbound via `ContainerRunner`.
- `reconcile.ts` — on boot, marks orphan running turns as errored.
- `safety-nets.ts` — global `uncaughtException` / `unhandledRejection` handlers that log fatal and do not exit.
- `main.ts` — process entry (`teamroom serve` dispatches here).

Invariants: nothing silent, nothing inconsistent, nothing crashes. See `docs/specs/2026-04-18-teamroom-m1-design.md` §3 and §12.
```

- [ ] **Step 6: Create `src/cli/README.md`**

```markdown
# `cli/` — `teamroom` binary

Thin. Each subcommand is a file that parses its arguments and delegates to a service function. Logic does not live here — it lives behind DI-friendly services in `src/db/`, `src/bus/`, etc. No direct unit tests for the commander wiring; per-command tests exercise the underlying service functions.

Commands: `serve`, `send`, `tail`, `status`.
```

- [ ] **Step 7: Create `src/agent-runtime/README.md`**

```markdown
# `agent-runtime/` — what runs inside each container

The shim that reads a single stdin JSON envelope, loads conversation history from `/store/conversation.jsonl`, calls the Anthropic API via an injected `AnthropicClient`, streams `type: "reply"` events on stdout, appends to the conversation file, and exits.

`runtime.ts` holds the pure turn function (DI-testable). `main.ts` wires the real SDK. `session-store.ts` owns the conversation file. Baked into each agent image at build time.

LangGraph is the intended long-term replacement for this shim — see spec §9.1.
```

- [ ] **Step 8: Update `README.md` (repo root)**

```markdown
# Team Room

A multi-agent harness modeled after a software delivery team.

## Current state

Milestone 1 — "One agent that works." A single hand-configured agent (`assistant`) runs in a fresh Docker container per turn. Terminal-only channel. No memory, no inter-agent messaging, no scheduling — those arrive in later milestones.

- Design: `docs/specs/2026-04-18-teamroom-m1-design.md`
- Plan: `docs/plans/2026-04-18-teamroom-m1-plan.md`
- Practices: `docs/ways-of-working.md`

## Quick start

```bash
npm install
npm run build
npm test                                      # unit + integration tests (fast)
./scripts/smoke-test.sh                       # end-to-end; requires Docker + ANTHROPIC_API_KEY
```

## Day-to-day use

```bash
export ANTHROPIC_API_KEY=...
npm run build
docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .

node dist/cli/main.js serve   &       # daemon in background
node dist/cli/main.js tail            # stream replies
node dist/cli/main.js send "hello"    # send a message (from another terminal)
node dist/cli/main.js status          # daemon + turn stats
```

## Layout

- `src/` — daemon, CLI, agent-runtime shim.
- `agents/<name>/` — per-agent folder (AGENTS.md, agent.yaml, Dockerfile, store/).
- `data/` — runtime state (gitignored).
- `docs/` — specs, plans, retros, runbooks, ways-of-working, tabled.

Module orientation: start at `src/README.md`.
```

- [ ] **Step 9: Commit**

```bash
git add README.md src/README.md src/db/README.md src/bus/README.md src/container/README.md src/daemon/README.md src/cli/README.md src/agent-runtime/README.md
git commit -m "docs(m1): module READMEs as semantic-memory anchors; repo README quick start"
```

---

## Task 28: Final M1 sanity pass

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: every test passes; full suite finishes in a few seconds.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/` produced without errors.

- [ ] **Step 4: Run the smoke test**

Run: `./scripts/smoke-test.sh`
Expected: the daemon boots, the agent container is built and invoked, a real reply lands in `tail`, output contains `hello back`.

If the smoke test fails, diagnose before proceeding. Do not merge M1 until the smoke test passes.

- [ ] **Step 5: Check the document inventory is accurate**

Open `docs/ways-of-working.md` §"Document inventory" and verify each listed path now exists (except `docs/retros/` which will be created at milestone close). Update the table if anything is missing or new.

- [ ] **Step 6: Prepare for milestone retrospective**

Per `docs/ways-of-working.md`, M1 closes with a retrospective at `docs/retros/2026-XX-XX-m1.md` covering **Keep doing**, **Stop or change**, **Promote to artifact**, and **Commit to memory**. The retro is written after this task completes and the smoke test passes — it's not part of this plan's code, but it IS the exit condition for declaring M1 done.

- [ ] **Step 7: Final commit (if anything outstanding)**

```bash
git status
# resolve any leftover uncommitted changes
```

Do not create an empty commit.

---

## Self-review checklist (run after writing; author-only)

- **Spec coverage** — every section in `docs/specs/2026-04-18-teamroom-m1-design.md` should map to at least one task. Mapping:
  - §4 Architecture → Tasks 18–19 (composition root + CLI bootstrap)
  - §5 File layout → Tasks 1, 24
  - §6 Database schema → Tasks 5–8
  - §7 Turn lifecycle → Task 14 (processTurn) + Task 15 (Orchestrator)
  - §8 CLI surface → Tasks 19–22
  - §9 Container contract + §9.1 agent internals → Tasks 11–12 + Task 23 + Task 24
  - §10 NotifyBus → Tasks 9–10
  - §11 Observability → Tasks 4 (logger) + bus events threaded through Tasks 14–16 + Task 22 (status)
  - §12 Error handling → Tasks 14, 16, 17
  - §13 Testing strategy → Tasks 3–23 (TDD throughout) + Task 25
  - §14 Non-goals → reflected by *absence*; not a task.
  - §15 Open planning questions → resolved in "Decisions locked by this plan" block.
- **Placeholder scan** — no TBD, TODO, or "add error handling"-style gaps. All code and commands are concrete.
- **Type consistency** — all interface and function names used in later tasks are introduced in earlier tasks with matching signatures (`AgentRepo`, `MessageRepo`, `TurnRepo`, `NotifyBus`, `ContainerRunner`, `Clock`, `Logger`, `AgentConfig`, `processTurn`, `Orchestrator`).

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-18-teamroom-m1-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints for review.

Which approach?
