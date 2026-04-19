# Team Room M3 — Team Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two agents DM each other by name, share a `/codebase` mount, and claude-assistant has filesystem tools. Team substrate primitives proven end-to-end via an exit-scenario smoke test.

**Architecture:** Additive extension to M1/M2's DB-as-integration + per-turn-container model. Subscription resolution happens at DM-send time inside `turn-processor.onEvent`; orchestrator, reconcile, NotifyBus, container runner, model proxy, and CLI are all unchanged. Schema migration adds `topic`, `from_agent_id`, `conversation_id` to `messages` and `conversation_id` to `turns`.

**Tech Stack:** TypeScript (Node 22), Vitest, better-sqlite3, Docker, `@anthropic-ai/claude-agent-sdk`.

**Spec:** [`docs/specs/2026-04-19-m3-team-substrate-design.md`](../specs/2026-04-19-m3-team-substrate-design.md). Read it first.

**Testing discipline (from M1/M2 memory entries):**
- Unit tests co-located (`src/<module>/<file>.test.ts`); integration tests in `tests/integration/`.
- `:memory:` SQLite, `InMemoryBus`, `FakeRunner`; **zero** mocking libraries.
- Smoke tests fail loudly on missing prereqs; no opt-in gates.
- Any failing test is a hard stop — fix before moving to the next task.

---

## Phase 1 — Foundations

### Task 1: Schema migration for M3

**Files:**
- Create: `src/db/migrations/002_m3_team_substrate.sql`
- Test: `src/db/migrator.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test** — add to the existing `migrator.test.ts`:

```typescript
it("applies 002_m3_team_substrate.sql and exposes new columns", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
  expect(msgCols).toEqual(
    expect.arrayContaining(["topic", "from_agent_id", "conversation_id"]),
  );

  const turnCols = (db.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).map((r) => r.name);
  expect(turnCols).toEqual(expect.arrayContaining(["conversation_id"]));

  const applied = (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
  expect(applied).toContain("002_m3_team_substrate.sql");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrator.test.ts`
Expected: FAIL — columns `topic`, `from_agent_id`, `conversation_id` not found.

- [ ] **Step 3: Create the migration file**

```sql
-- src/db/migrations/002_m3_team_substrate.sql

-- M3: team-substrate DM primitive needs channel-specific routing fields on
-- messages and a business-level conversation_id on both messages and turns
-- (the latter powers the runaway-loop cap check).

ALTER TABLE messages ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN from_agent_id TEXT;
ALTER TABLE messages ADD COLUMN conversation_id TEXT;

ALTER TABLE turns ADD COLUMN conversation_id TEXT;

CREATE INDEX idx_messages_channel_topic ON messages(channel, topic);
CREATE INDEX idx_turns_conversation ON turns(conversation_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Also run the full suite to catch M2 regressions**

Run: `npm test`
Expected: all existing tests still PASS (the new columns are nullable / default so M2 code paths are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/002_m3_team_substrate.sql src/db/migrator.test.ts
git commit -m "feat(db): m3 migration — channel/topic/from/conversation columns"
```

---

### Task 2: Extend `Message` and `Turn` types

**Files:**
- Modify: `src/types.ts:11-20` (Message), `src/types.ts:22-33` (Turn)
- Test: `src/types.test.ts` (no changes needed — compile-time check is the test)

- [ ] **Step 1: Update the `Message` interface**

```typescript
export interface Message {
  id: string;
  agentId: string;
  channel: string;
  direction: MessageDirection;
  body: string;
  turnId: string | null;
  traceId: string;
  createdAt: string;
  // M3 additions:
  topic: string;                  // routing key within channel; '' for CLI, target-agent for DM
  fromAgentId: string | null;     // null for CLI-originated or outbound
  conversationId: string | null;  // null for pre-M3 rows
}
```

- [ ] **Step 2: Update the `Turn` interface**

```typescript
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
  conversationId: string | null;  // M3 addition; null for pre-M3 rows
}
```

- [ ] **Step 3: Run typecheck — expect many errors to cascade**

Run: `npx tsc --noEmit`
Expected: FAIL — every existing `messageRepo.create({...})` / `turnRepo.create({...})` call site is now missing the new required fields.

- [ ] **Step 4: Do NOT fix the errors yet**

Tasks 3 and 4 fix them. This step just confirms the type change landed.

- [ ] **Step 5: Commit (tree red; upcoming tasks will make it green)**

```bash
git add src/types.ts
git commit -m "feat(types): add topic/fromAgentId/conversationId to Message; conversationId to Turn"
```

Note: this commit leaves the tree in a non-compiling state. It's a deliberate, minimal commit to pin the type decision before downstream updates. The next two tasks restore compilation.

---

### Task 3: Update `MessageRepo` for new columns

**Files:**
- Modify: `src/db/message-repo.ts`
- Test: `src/db/message-repo.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — add to `message-repo.test.ts`:

```typescript
it("round-trips DM-shaped messages with topic/from/conversation", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({ id: "claude-assistant", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
  const repo = new MessageRepo(db);
  const msg: Message = {
    id: "m1",
    agentId: "claude-assistant",
    channel: "dm",
    direction: "in",
    body: "hi",
    turnId: null,
    traceId: "t1",
    createdAt: "2026-04-19T00:00:01Z",
    topic: "claude-assistant",
    fromAgentId: "studio-assistant",
    conversationId: "c1",
  };
  repo.create(msg);
  const got = repo.findById("m1");
  expect(got).toEqual(msg);
});

it("defaults M2-style CLI messages to empty topic + null from/conversation", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({ id: "claude-assistant", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
  const repo = new MessageRepo(db);
  const msg: Message = {
    id: "m2",
    agentId: "claude-assistant",
    channel: "cli",
    direction: "in",
    body: "hi",
    turnId: null,
    traceId: "t2",
    createdAt: "2026-04-19T00:00:01Z",
    topic: "",
    fromAgentId: null,
    conversationId: null,
  };
  repo.create(msg);
  expect(repo.findById("m2")).toEqual(msg);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/message-repo.test.ts`
Expected: FAIL — missing columns in the INSERT.

- [ ] **Step 3: Update `MessageRepo`**

```typescript
// src/db/message-repo.ts

interface MessageRow {
  id: string;
  agent_id: string;
  channel: string;
  direction: "in" | "out";
  body: string;
  turn_id: string | null;
  trace_id: string;
  created_at: string;
  topic: string;
  from_agent_id: string | null;
  conversation_id: string | null;
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
    topic: row.topic,
    fromAgentId: row.from_agent_id,
    conversationId: row.conversation_id,
  };
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  create(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, agent_id, channel, direction, body, turn_id, trace_id, created_at,
            topic, from_agent_id, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.agentId, m.channel, m.direction, m.body, m.turnId, m.traceId, m.createdAt,
        m.topic, m.fromAgentId, m.conversationId,
      );
  }

  // findById, findPendingInbound, attachTurn, findOutboundAfter: unchanged (SELECT * picks up new cols;
  // rowToMessage maps them). No code change needed other than rowToMessage above.
  // ...existing methods below...
}
```

Keep the rest of the file as-is; only `create`, `rowToMessage`, and `MessageRow` change.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/db/message-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix call-site compile errors**

There are existing `messageRepo.create({...})` calls in `src/daemon/turn-processor.ts` and `src/cli/send.ts`. Add the three new fields inline:
- In `src/cli/send.ts` — add `topic: ""`, `fromAgentId: null`, `conversationId: null` (conversation_id wiring comes in Task 8).
- In `src/daemon/turn-processor.ts` — add the same three defaults to the existing `messageRepo.create({...})` call in the `reply` branch.

Run: `npx tsc --noEmit` — expected: PASS.

- [ ] **Step 6: Full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/message-repo.ts src/db/message-repo.test.ts src/cli/send.ts src/daemon/turn-processor.ts
git commit -m "feat(message-repo): persist m3 topic/from/conversation columns"
```

---

### Task 4: Update `TurnRepo` — add `conversationId` and `countByConversationId`

**Files:**
- Modify: `src/db/turn-repo.ts`
- Test: `src/db/turn-repo.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```typescript
it("round-trips turns with conversationId", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({ id: "a1", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
  new MessageRepo(db).create({
    id: "m1", agentId: "a1", channel: "cli", direction: "in", body: "b",
    turnId: null, traceId: "t", createdAt: "2026-04-19T00:00:01Z",
    topic: "", fromAgentId: null, conversationId: "c1",
  });
  const repo = new TurnRepo(db);
  const turn: Turn = {
    id: "turn1", agentId: "a1", inboundMessageId: "m1", status: "pending",
    containerId: null, error: null, traceId: "t",
    startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
    conversationId: "c1",
  };
  repo.create(turn);
  expect(repo.findById("turn1")).toEqual(turn);
});

it("counts turns by conversationId", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);
  new AgentRepo(db).create({ id: "a1", configPath: "/x", createdAt: "2026-04-19T00:00:00Z" });
  new MessageRepo(db).create({
    id: "m1", agentId: "a1", channel: "cli", direction: "in", body: "b",
    turnId: null, traceId: "t", createdAt: "2026-04-19T00:00:01Z",
    topic: "", fromAgentId: null, conversationId: "c1",
  });
  const repo = new TurnRepo(db);
  for (let i = 0; i < 3; i += 1) {
    repo.create({
      id: `turn${i}`, agentId: "a1", inboundMessageId: "m1", status: "done",
      containerId: null, error: null, traceId: "t",
      startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
      conversationId: "c1",
    });
  }
  // Unrelated conversation.
  repo.create({
    id: "other", agentId: "a1", inboundMessageId: "m1", status: "done",
    containerId: null, error: null, traceId: "t",
    startedAt: null, finishedAt: null, createdAt: "2026-04-19T00:00:02Z",
    conversationId: "c-other",
  });
  expect(repo.countByConversationId("c1")).toBe(3);
  expect(repo.countByConversationId("c-other")).toBe(1);
  expect(repo.countByConversationId("nonexistent")).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/db/turn-repo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `TurnRepo`**

```typescript
// src/db/turn-repo.ts

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
  conversation_id: string | null;
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
    conversationId: row.conversation_id,
  };
}

export class TurnRepo {
  constructor(private readonly db: Db) {}

  create(t: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, agent_id, inbound_message_id, status, container_id, error, trace_id,
            started_at, finished_at, created_at, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.agentId, t.inboundMessageId, t.status, t.containerId, t.error, t.traceId,
        t.startedAt, t.finishedAt, t.createdAt, t.conversationId,
      );
  }

  countByConversationId(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE conversation_id = ?`)
      .get(conversationId) as { c: number };
    return row.c;
  }

  // All other methods unchanged.
}
```

- [ ] **Step 4: Fix call-site compile errors**

In `src/daemon/turn-processor.ts:49-60`, add `conversationId: null` to the `turnRepo.create({...})` call. (Wiring to real conversationId happens in Task 9.)

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/db/turn-repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/turn-repo.ts src/db/turn-repo.test.ts src/daemon/turn-processor.ts
git commit -m "feat(turn-repo): add conversationId + countByConversationId"
```

---

### Task 5: Extend `AgentConfig` to parse `subscriptions` and `allowed_tools`

**Files:**
- Modify: `src/agent-config/agent-config.ts`
- Test: `src/agent-config/agent-config.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```typescript
it("parses subscriptions as string[] (defaults to empty)", () => {
  const dir = mkTempAgentDir({
    name: "a", provider: "anthropic", model: "m", image_tag: "t",
    subscriptions: ["a", "team-wide"],
  });
  const cfg = loadAgentConfig(dir);
  expect(cfg.subscriptions).toEqual(["a", "team-wide"]);

  const dir2 = mkTempAgentDir({ name: "b", provider: "anthropic", model: "m", image_tag: "t" });
  expect(loadAgentConfig(dir2).subscriptions).toEqual([]);
});

it("rejects non-string subscription entries", () => {
  const dir = mkTempAgentDir({
    name: "a", provider: "anthropic", model: "m", image_tag: "t",
    subscriptions: ["ok", 42],
  });
  expect(() => loadAgentConfig(dir)).toThrow(/subscriptions.*must be a string/);
});

it("parses allowed_tools as string[] (defaults to empty)", () => {
  const dir = mkTempAgentDir({
    name: "a", provider: "anthropic", model: "m", image_tag: "t",
    allowed_tools: ["Read", "Write"],
  });
  expect(loadAgentConfig(dir).allowedTools).toEqual(["Read", "Write"]);

  const dir2 = mkTempAgentDir({ name: "b", provider: "anthropic", model: "m", image_tag: "t" });
  expect(loadAgentConfig(dir2).allowedTools).toEqual([]);
});
```

Use the existing `mkTempAgentDir` helper if one exists; otherwise create it inline by writing `agent.yaml`, `AGENTS.md`, and a `store/` dir to an `os.tmpdir()` path.

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/agent-config/agent-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `AgentConfig` and `loadAgentConfig`**

```typescript
// src/agent-config/agent-config.ts

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  provider: Provider;
  configPath: string;
  agentsMdPath: string;
  storePath: string;
  // M3 additions:
  subscriptions: string[];   // DM topics this agent listens for; empty by default
  allowedTools: string[];    // claude-agent-sdk allowed-tool names; empty by default
}

export function loadAgentConfig(agentDir: string): AgentConfig {
  // ... existing checks (lines 17-40) stay ...

  const subscriptions = parseStringArray(parsed, "subscriptions");
  const allowedTools = parseStringArray(parsed, "allowed_tools");

  return {
    name, model, imageTag, provider, configPath, agentsMdPath, storePath,
    subscriptions, allowedTools,
  };
}

function parseStringArray(parsed: Record<string, unknown>, field: string): string[] {
  const value = parsed[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`agent.yaml '${field}' must be an array (got ${typeof value})`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `agent.yaml '${field}' entries must be a string (got ${typeof entry}: '${String(entry)}')`,
      );
    }
  }
  return value as string[];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/agent-config/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-config/agent-config.ts src/agent-config/agent-config.test.ts
git commit -m "feat(agent-config): parse subscriptions and allowed_tools"
```

---

### Task 6: Subscription index module

**Files:**
- Create: `src/daemon/subscriptions.ts`
- Create: `src/daemon/subscriptions.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/daemon/subscriptions.test.ts
import { describe, it, expect } from "vitest";
import { AgentSubscriptionIndex } from "./subscriptions.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

function cfg(name: string, subscriptions: string[]): AgentConfig {
  return {
    name, model: "m", imageTag: "t", provider: "anthropic",
    configPath: "/x", agentsMdPath: "/x/AGENTS.md", storePath: "/x/store",
    subscriptions, allowedTools: [],
  };
}

describe("AgentSubscriptionIndex", () => {
  it("returns agent ids subscribed to a dm topic", () => {
    const cfgs = new Map([
      ["claude-assistant", cfg("claude-assistant", ["claude-assistant"])],
      ["studio-assistant", cfg("studio-assistant", ["studio-assistant"])],
    ]);
    const idx = new AgentSubscriptionIndex(cfgs);

    expect(idx.lookup("dm", "claude-assistant")).toEqual(["claude-assistant"]);
    expect(idx.lookup("dm", "studio-assistant")).toEqual(["studio-assistant"]);
  });

  it("returns empty array when no subscribers match", () => {
    const cfgs = new Map([["a", cfg("a", ["a"])]]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "nonexistent")).toEqual([]);
    expect(idx.lookup("other-channel", "a")).toEqual([]);
  });

  it("supports multiple agents on the same topic", () => {
    const cfgs = new Map([
      ["a", cfg("a", ["team-wide"])],
      ["b", cfg("b", ["team-wide"])],
    ]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "team-wide").sort()).toEqual(["a", "b"]);
  });

  it("an agent can subscribe to multiple topics", () => {
    const cfgs = new Map([["a", cfg("a", ["t1", "t2"])]]);
    const idx = new AgentSubscriptionIndex(cfgs);
    expect(idx.lookup("dm", "t1")).toEqual(["a"]);
    expect(idx.lookup("dm", "t2")).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/daemon/subscriptions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

```typescript
// src/daemon/subscriptions.ts
import type { AgentConfig } from "../agent-config/agent-config.js";

/**
 * Read-only lookup: given (channel, topic), returns the ids of agents
 * subscribed. In M3 the only populated channel is "dm"; every entry in an
 * agent.yaml `subscriptions:` list is indexed under `dm:<topic>`.
 *
 * CLI routing does NOT use this index. CLI `send` addresses an agent
 * directly via `messages.agent_id`; no subscription lookup involved.
 */
export interface SubscriptionIndex {
  lookup(channel: string, topic: string): string[];
}

export class AgentSubscriptionIndex implements SubscriptionIndex {
  // Key: `${channel}:${topic}`; value: set of subscribed agent ids.
  private readonly index = new Map<string, Set<string>>();

  constructor(agentConfigs: Map<string, AgentConfig>) {
    for (const [agentId, cfg] of agentConfigs) {
      for (const topic of cfg.subscriptions) {
        const key = `dm:${topic}`;
        let set = this.index.get(key);
        if (!set) {
          set = new Set();
          this.index.set(key, set);
        }
        set.add(agentId);
      }
    }
  }

  lookup(channel: string, topic: string): string[] {
    const key = `${channel}:${topic}`;
    const set = this.index.get(key);
    return set ? Array.from(set) : [];
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/daemon/subscriptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/subscriptions.ts src/daemon/subscriptions.test.ts
git commit -m "feat(daemon): subscription index module"
```

---

### Task 7: Wire subscription index at daemon boot

**Files:**
- Modify: `src/daemon/daemon.ts` (build index after loading agentConfigs)
- Modify: `src/daemon/orchestrator.ts` (accept index in deps, pass to `processTurn`)
- Modify: `src/daemon/turn-processor.ts` (accept index in deps — handler added in Task 11)
- Test: `src/daemon/daemon.test.ts` (extend)

- [ ] **Step 1: Write failing test** — add to `daemon.test.ts`:

```typescript
it("builds a subscription index reflecting each agent's subscriptions", async () => {
  // startDaemon() returns orchestrator; orchestrator's subscriptionIndex should
  // contain the union of all agent.yaml subscription entries.
  const tempDir = ...; // existing test helper
  // write two agent folders — one subscribed to its own name + "team-wide",
  // the other subscribed to its own name only.
  // ... setup omitted; existing test helpers in daemon.test.ts provide this ...
  const started = await startDaemon({ /* ... */ });
  const idx = started.orchestrator.deps.subscriptionIndex;  // see Step 3 for shape
  expect(idx.lookup("dm", "team-wide")).toEqual(["a"]);
  expect(idx.lookup("dm", "a")).toEqual(["a"]);
  expect(idx.lookup("dm", "b")).toEqual(["b"]);
  await started.stop();
});
```

If exposing `orchestrator.deps` feels like poor encapsulation, expose a narrow accessor `started.getSubscriberAgents(channel, topic)` instead.

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run src/daemon/daemon.test.ts`
Expected: FAIL — index not built / not exposed.

- [ ] **Step 3: Wire the index through**

In `src/daemon/daemon.ts`, after `agentConfigs` is populated (after the agent-discovery loop, ~line 90):

```typescript
import { AgentSubscriptionIndex } from "./subscriptions.js";
// ...
const subscriptionIndex = new AgentSubscriptionIndex(agentConfigs);
rootLogger.info("subscription index built", {
  entries: [...agentConfigs.values()].reduce((n, c) => n + c.subscriptions.length, 0),
});
```

Pass `subscriptionIndex` into the `Orchestrator` constructor via `OrchestratorDeps`.

In `src/daemon/orchestrator.ts`:

```typescript
export interface OrchestratorDeps {
  // ...existing fields...
  subscriptionIndex: SubscriptionIndex;
}
```

Pass it through in the `processTurn` call (it gets consumed by the handler added in Task 11):

```typescript
await processTurn({
  // ...existing deps...
  subscriptionIndex: this.deps.subscriptionIndex,
});
```

In `src/daemon/turn-processor.ts`:

```typescript
import type { SubscriptionIndex } from "./subscriptions.js";

export interface ProcessTurnDeps {
  // ...existing fields...
  subscriptionIndex: SubscriptionIndex;
}
```

Destructure it in `processTurn` but do not use it yet (Task 11 adds the handler).

Expose the index on `StartedDaemon` for testability:

```typescript
export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
  subscriptionIndex: SubscriptionIndex;
}
```

- [ ] **Step 4: Update all existing tests** that construct `OrchestratorDeps` or `ProcessTurnDeps` inline to include `subscriptionIndex` (an empty `AgentSubscriptionIndex(new Map())` is fine for those).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/daemon.ts src/daemon/daemon.test.ts src/daemon/orchestrator.ts src/daemon/turn-processor.ts src/daemon/orchestrator.test.ts src/daemon/turn-processor.test.ts
git commit -m "feat(daemon): wire subscription index through orchestrator + turn-processor"
```

---

## Phase 2 — Conversation_id propagation

### Task 8: `cli/send.ts` generates `conversation_id` per CLI message

**Files:**
- Modify: `src/cli/send.ts`
- Test: `src/cli/send.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```typescript
it("generates a non-null conversationId per CLI send", async () => {
  // Existing test helpers create a repo-root with at least one agent. After
  // sendToDb(), read the messages row and assert conversationId is set.
  const result = await sendToDb({ repoRoot: tmpRoot, body: "hi", agentName: "a" });
  const db = createDatabase(join(tmpRoot, "data", "teamroom.db"));
  const repo = new MessageRepo(db);
  const msg = repo.findById(result.messageId);
  expect(msg?.conversationId).not.toBeNull();
  expect(msg?.conversationId).toMatch(/^[0-9a-f-]{36}$/); // uuid shape
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run src/cli/send.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `sendToDb`**

```typescript
// src/cli/send.ts — inside sendToDb(), replace the current messageRepo.create call:

const messageId = randomUUID();
const traceId = randomUUID();
const conversationId = randomUUID();  // NEW — CLI-initiated messages start a new conversation
new MessageRepo(db).create({
  id: messageId,
  agentId: cfg.name,
  channel: "cli",
  direction: "in",
  body: opts.body,
  turnId: null,
  traceId,
  createdAt: new Date().toISOString(),
  topic: "",
  fromAgentId: null,
  conversationId,
});
```

Also include `conversationId` in `SendToDbResult` so downstream tooling can reference it if wanted:

```typescript
export interface SendToDbResult {
  traceId: string;
  messageId: string;
  agentName: string;
  daemonRunning: boolean;
  conversationId: string;  // NEW
}
// ...return { traceId, messageId, agentName: cfg.name, daemonRunning, conversationId };
```

- [ ] **Step 4: Run tests + full suite**

Run: `npx vitest run src/cli/send.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/send.ts src/cli/send.test.ts
git commit -m "feat(cli): generate conversationId per CLI send"
```

---

### Task 9: `turn-processor` propagates `conversationId` to the turn row

**Files:**
- Modify: `src/daemon/turn-processor.ts:49-60` (the `turnRepo.create({...})` call)
- Test: `src/daemon/turn-processor.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```typescript
it("copies inbound.conversationId to the turn row", async () => {
  // Use the existing test harness that runs processTurn with a FakeRunner.
  // Fabricate an inbound message with conversationId = "c-test".
  // After processTurn completes, expect turnRepo.findById(...).conversationId === "c-test".
  const inbound: Message = {
    id: "m1", agentId: "a", channel: "cli", direction: "in", body: "hi",
    turnId: null, traceId: "t", createdAt: "...",
    topic: "", fromAgentId: null, conversationId: "c-test",
  };
  // ...run processTurn with inbound...
  const turn = turnRepo.findById(result.turnId);
  expect(turn?.conversationId).toBe("c-test");
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: FAIL — `conversationId` still `null` on turn row.

- [ ] **Step 3: Update the `turnRepo.create({...})` call in `processTurn`** (replaces the placeholder `conversationId: null` from Task 4):

```typescript
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
  conversationId: inbound.conversationId,  // M3: inherit from inbound
});
```

- [ ] **Step 4: Run tests + full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts
git commit -m "feat(turn-processor): inherit conversationId from inbound message"
```

---

## Phase 3 — DM primitive

### Task 10: Add `dm` to `ContainerStdoutEvent` + `docker-runner` parser

**Files:**
- Modify: `src/container/container-runner.ts` (type)
- Modify: `src/container/docker-runner.ts` (parseEvent — whichever function maps raw JSON to `ContainerStdoutEvent`)
- Test: `src/container/docker-runner.test.ts` (extend)

- [ ] **Step 1: Write failing test** — add a case exercising `dm` parsing:

```typescript
it("parses a {type:'dm'} stdout line into a ContainerStdoutEvent", () => {
  const line = JSON.stringify({ type: "dm", to: "studio-assistant", body: "hello" });
  const evt = parseEvent(line);   // or whatever the existing parse entry-point is
  expect(evt).toEqual({ type: "dm", to: "studio-assistant", body: "hello" });
});

it("rejects malformed dm lines", () => {
  const line = JSON.stringify({ type: "dm", body: "missing to" });
  const evt = parseEvent(line);
  expect(evt.type).toBe("unknown");
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run src/container/docker-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the type**

```typescript
// src/container/container-runner.ts
export type ContainerStdoutEvent =
  | { type: "reply"; body: string; messageId?: string }
  | { type: "dm"; to: string; body: string }    // M3
  | { type: "status"; phase: string; [k: string]: unknown }
  | { type: "log"; level: string; msg: string; [k: string]: unknown }
  | { type: "unknown"; raw: string };
```

Extend the parser in `docker-runner.ts` to validate the `dm` branch: `type === "dm"` with `typeof to === "string"` and `typeof body === "string"` both required; otherwise fall through to `unknown`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/container/docker-runner.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/container/container-runner.ts src/container/docker-runner.ts src/container/docker-runner.test.ts
git commit -m "feat(container): parse {type:dm} stdout events"
```

---

### Task 11: `turn-processor.onEvent` — DM branch (subscription lookup + inbound insert + self-DM reject)

**Files:**
- Modify: `src/daemon/turn-processor.ts:150-184` (the `onEvent` handler)
- Test: `src/daemon/turn-processor.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — three scenarios:

```typescript
it("on {type:dm}: inserts inbound rows for each subscriber", async () => {
  // Build a FakeRunner that emits one {type:"dm", to:"studio-assistant", body:"ping"} event.
  // Build a SubscriptionIndex where "studio-assistant" is subscribed to its own name.
  // Run processTurn with a CLI-originated inbound addressed to claude-assistant.
  // After processTurn returns, expect exactly one new row in messages where
  //   channel=dm, topic=studio-assistant, from_agent_id=claude-assistant,
  //   conversation_id=<inbound's>, direction=in, turn_id=null.
  // ...
});

it("on {type:dm} to self: logs self-dm.rejected and inserts no row", async () => {
  // Emit {type:"dm", to:"claude-assistant", ...} from a claude-assistant turn.
  // Expect: 0 new DM rows in messages; logger captured a warn entry with event "self-dm.rejected".
});

it("on {type:dm} with no matching subscriber: logs message.undelivered and inserts no row", async () => {
  // Emit {type:"dm", to:"nobody", ...}. SubscriptionIndex has no match.
  // Expect: 0 new rows; logger captured "message.undelivered" warn with channel=dm, topic=nobody.
});
```

Tests should use the existing `CapturingLogger` / `:memory:` DB / `FakeRunner` patterns established in M2.

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: FAIL — no dm branch.

- [ ] **Step 3: Add the `dm` branch to the `onEvent` handler** (inside the big `onEvent` callback, alongside the existing `reply` / `status` / `log` branches):

```typescript
} else if (evt.type === "dm") {
  const sender = agentConfig.name;
  const to = evt.to;

  if (to === sender) {
    turnLogger.warn("self-dm.rejected", { from: sender, to });
    return;
  }

  const subscribers = subscriptionIndex.lookup("dm", to);
  if (subscribers.length === 0) {
    turnLogger.warn("message.undelivered", { channel: "dm", topic: to });
    return;
  }

  for (const subscriberId of subscribers) {
    messageRepo.create({
      id: genId(),
      agentId: subscriberId,
      channel: "dm",
      direction: "in",
      body: evt.body,
      turnId: null,
      traceId: genId(),  // fresh trace per new inbound (M2 span convention)
      createdAt: clock.nowIso(),
      topic: to,
      fromAgentId: sender,
      conversationId: inbound.conversationId,  // inherit through the chain
    });
  }
}
```

Remember to destructure `subscriptionIndex` from `deps` at the top of `processTurn`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/daemon/turn-processor.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts
git commit -m "feat(turn-processor): dm onEvent branch — lookup + self-reject + undelivered"
```

---

### Task 12: Update `agent.yaml` for both agents — add own-name subscription

**Files:**
- Modify: `agents/claude-assistant/agent.yaml`
- Modify: `agents/studio-assistant/agent.yaml`

- [ ] **Step 1: Update `agents/claude-assistant/agent.yaml`**

```yaml
name: claude-assistant
provider: anthropic
model: claude-opus-4-7
image_tag: teamroom-agent-claude-assistant:latest
subscriptions:
  - claude-assistant
```

- [ ] **Step 2: Update `agents/studio-assistant/agent.yaml`**

```yaml
name: studio-assistant
model: qwen/qwen3.5-9b
image_tag: teamroom-agent-studio-assistant:latest
provider: lm-studio
subscriptions:
  - studio-assistant
```

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: PASS — daemon tests now observe the populated subscription index.

- [ ] **Step 4: Commit**

```bash
git add agents/claude-assistant/agent.yaml agents/studio-assistant/agent.yaml
git commit -m "config(agents): subscribe each agent to its own name on dm channel"
```

---

### Task 13: Update agent-runtime `Envelope` to carry `channel` + `from`; inject a context prefix for DM turns

**Files:**
- Modify: `src/agent-runtime/runtime.ts` (the `Envelope` interface and the prompt-composition code)
- Modify: `src/daemon/turn-processor.ts:137-142` (stdinEnvelope JSON)
- Test: `src/agent-runtime/runtime.test.ts` (extend)

The agent (LLM) needs to know "who woke me up" so it can respond appropriately. The minimal way: when the turn is triggered by a DM (`channel === "dm"`), the runtime prepends a one-line context marker to the user prompt.

- [ ] **Step 1: Write failing tests**

```typescript
it("prepends '[dm from X]' context to the user prompt when envelope.channel === 'dm'", async () => {
  // Run runTurn with envelope.channel="dm", envelope.from="studio-assistant", envelope.prompt="what day is it?".
  // Capture the messages array the LlmClient received.
  // Expect the user message content to start with "[dm from studio-assistant]\n\n".
});

it("does NOT prepend anything when envelope.channel === 'cli'", async () => {
  // Same but channel="cli". Expect user message content === envelope.prompt.
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/agent-runtime/runtime.test.ts`
Expected: FAIL — fields not in envelope.

- [ ] **Step 3: Update `Envelope`**

```typescript
// src/agent-runtime/runtime.ts
export interface Envelope {
  prompt: string;
  messageId: string;
  turnId: string;
  traceId: string;
  channel?: string;       // M3: "cli" | "dm" (undefined for pre-M3 envelopes)
  from?: string | null;   // M3: "cli" for CLI-originated; agent id for DMs; undefined pre-M3
}
```

In the prompt-composition code inside `runTurn`, before the LLM call:

```typescript
const userBody = envelope.channel === "dm" && envelope.from
  ? `[dm from ${envelope.from}]\n\n${envelope.prompt}`
  : envelope.prompt;
```

Pass `userBody` wherever the existing code was passing `envelope.prompt` as user content.

- [ ] **Step 4: Update `turn-processor.ts` to populate the envelope**

Replace the existing stdinEnvelope construction (lines 137-142):

```typescript
const stdinEnvelope = JSON.stringify({
  prompt: inbound.body,
  messageId: inbound.id,
  turnId,
  traceId: inbound.traceId,
  channel: inbound.channel,                     // M3
  from: inbound.fromAgentId ?? "cli",           // M3
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-runtime/runtime.ts src/agent-runtime/runtime.test.ts src/daemon/turn-processor.ts
git commit -m "feat(agent-runtime): prepend [dm from X] context for dm-triggered turns"
```

---

## Phase 4 — Reply routing for DM context

### Task 14: Extend `reply` onEvent branch — DM context → return-DM inbound

**Files:**
- Modify: `src/daemon/turn-processor.ts:152-173` (existing `reply` branch)
- Test: `src/daemon/turn-processor.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```typescript
it("when inbound.channel === 'dm': reply creates an inbound DM back to inbound.fromAgentId", async () => {
  // inbound: (agent_id=studio-assistant, channel=dm, topic=studio-assistant,
  //   from_agent_id=claude-assistant, conversation_id=c1, body="ping")
  // FakeRunner emits {type:"reply", body:"pong"}.
  // Expect a new row in messages with:
  //   agent_id=claude-assistant, channel=dm, topic=claude-assistant,
  //   from_agent_id=studio-assistant, conversation_id=c1, direction=in, turn_id=null.
  // Expect NO message.outbound bus event (since this is an inbound-create, not an outbound delivery).
});

it("when inbound.channel === 'cli': reply creates an outbound row + message.outbound event (unchanged M2 behaviour)", async () => {
  // inbound: (agent_id=claude-assistant, channel=cli, ...) from CLI.
  // FakeRunner emits {type:"reply", body:"hello"}.
  // Expect an outbound row on channel=cli and a message.outbound bus event.
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: FAIL — existing reply branch doesn't branch on channel.

- [ ] **Step 3: Replace the existing `reply` branch**

```typescript
if (evt.type === "reply") {
  if (inbound.channel === "dm") {
    // DM context — bounce back to the original sender as a fresh inbound.
    const target = inbound.fromAgentId;
    if (target == null) {
      turnLogger.warn("dm-reply.no-sender", { inboundId: inbound.id });
    } else {
      messageRepo.create({
        id: genId(),
        agentId: target,
        channel: "dm",
        direction: "in",
        body: evt.body,
        turnId: null,
        traceId: genId(),
        createdAt: clock.nowIso(),
        topic: target,
        fromAgentId: agentConfig.name,
        conversationId: inbound.conversationId,
      });
    }
  } else {
    // CLI context (M2 unchanged).
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
      topic: "",
      fromAgentId: null,
      conversationId: inbound.conversationId,
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
  }
}
```

- [ ] **Step 4: Run tests + full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts
git commit -m "feat(turn-processor): reply from dm turn bounces back as inbound DM"
```

---

## Phase 5 — Conversation safety

### Task 15: Conversation cap check at `processTurn` entry

**Files:**
- Modify: `src/daemon/turn-processor.ts` (add cap check before current step "1")
- Modify: `src/daemon/daemon.ts` (read env var; pass into deps)
- Modify: `src/daemon/orchestrator.ts` (thread through)
- Test: `src/daemon/turn-processor.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```typescript
it("refuses dispatch when turns-per-conversation >= cap", async () => {
  // Pre-populate turnRepo with N=10 turns sharing conversation_id="c-runaway".
  // Run processTurn with an inbound whose conversationId === "c-runaway".
  // Expect: turn row is marked 'error' with error="conversation_cap";
  //   no container spawn (FakeRunner.run was not called);
  //   logger captured "conversation.limit_reached" warn entry.
});

it("allows dispatch when turns-per-conversation < cap", async () => {
  // conversationId exists but turn count < N — normal dispatch proceeds.
});

it("skips the cap when inbound.conversationId is null (pre-M3 row)", async () => {
  // inbound.conversationId === null — dispatch proceeds regardless of any prior turn counts.
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `maxTurnsPerConversation` to `ProcessTurnDeps`**

```typescript
export interface ProcessTurnDeps {
  // ...existing...
  maxTurnsPerConversation: number;  // 0 or negative disables the cap
}
```

- [ ] **Step 4: Insert cap check at the top of `processTurn`** — between the turn-id generation and `turnRepo.create`:

```typescript
// Runaway-loop safety: cap turns per conversation.
if (
  inbound.conversationId != null &&
  maxTurnsPerConversation > 0 &&
  turnRepo.countByConversationId(inbound.conversationId) >= maxTurnsPerConversation
) {
  turnLogger.warn("conversation.limit_reached", {
    conversationId: inbound.conversationId,
    limit: maxTurnsPerConversation,
  });
  // Still write the turn row so we have a DB record of the refusal, but mark errored.
  turnRepo.create({
    id: turnId,
    agentId: inbound.agentId,
    inboundMessageId: inbound.id,
    status: "error",
    containerId: null,
    error: "conversation_cap",
    traceId: inbound.traceId,
    startedAt: null,
    finishedAt: clock.nowIso(),
    createdAt: now,
    conversationId: inbound.conversationId,
  });
  messageRepo.attachTurn(inbound.id, turnId);
  return;
}
```

- [ ] **Step 5: Wire env var in `daemon.ts`**

```typescript
// In startDaemon, after reading the other env-derived opts:
const maxTurnsPerConversation = (() => {
  const raw = process.env.TEAMROOM_MAX_TURNS_PER_CONVERSATION;
  if (raw == null || raw.trim() === "") return 10;  // default
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`TEAMROOM_MAX_TURNS_PER_CONVERSATION must be a non-negative integer (got '${raw}')`);
  return n;
})();

// Pass into orchestrator deps (propagates to processTurn).
```

Thread through `OrchestratorDeps` and the `processTurn` call in `orchestrator.ts`.

- [ ] **Step 6: Run tests + full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts src/daemon/orchestrator.ts src/daemon/orchestrator.test.ts src/daemon/daemon.ts src/daemon/daemon.test.ts
git commit -m "feat(turn-processor): cap turns per conversation (default 10, configurable)"
```

---

## Phase 6 — Capability layer

### Task 16: Mount `/codebase` into every agent container

**Files:**
- Modify: `src/daemon/turn-processor.ts:100-105` (mounts array)
- Modify: `src/daemon/daemon.ts` (read env var; pass into deps)
- Modify: `src/daemon/orchestrator.ts` (thread through)
- Test: `src/daemon/turn-processor.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```typescript
it("adds a /codebase mount (rw) to the DockerRunSpec when codebasePath is set", async () => {
  // Capture DockerRunSpec via FakeRunner.
  // After processTurn, spec.mounts should include
  //   { hostPath: "/host/codebase", containerPath: "/codebase", readOnly: false }.
});

it("omits the /codebase mount when codebasePath is null", async () => {
  // Same harness, but deps.codebasePath = null.
  // Expect the mounts array does NOT contain a containerPath "/codebase" entry.
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `codebasePath` to `ProcessTurnDeps`**

```typescript
export interface ProcessTurnDeps {
  // ...existing...
  codebasePath: string | null;  // null disables the mount
}
```

- [ ] **Step 4: Conditionally add the mount**

```typescript
const mounts: Mount[] = [
  { hostPath: agentConfig.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },
  { hostPath: agentConfig.storePath, containerPath: "/store", readOnly: false },
];
if (codebasePath) {
  mounts.push({ hostPath: codebasePath, containerPath: "/codebase", readOnly: false });
}
```

- [ ] **Step 5: Wire env var in `daemon.ts`**

```typescript
const codebasePath = (() => {
  const raw = process.env.TEAMROOM_CODEBASE_PATH;
  if (raw == null || raw.trim() === "") {
    // Default: <repoRoot>/codebase, iff it exists; otherwise null.
    const defaultPath = join(opts.dataDir, "..", "codebase");
    return existsSync(defaultPath) ? defaultPath : null;
  }
  if (!existsSync(raw)) throw new Error(`TEAMROOM_CODEBASE_PATH does not exist: ${raw}`);
  return raw;
})();

rootLogger.info("codebase mount", { path: codebasePath ?? "(none)" });
```

Thread `codebasePath` through `OrchestratorDeps` and into `processTurn`.

- [ ] **Step 6: Run tests + full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts src/daemon/orchestrator.ts src/daemon/daemon.ts src/daemon/daemon.test.ts
git commit -m "feat(daemon): mount /codebase into agent containers (configurable via env)"
```

---

### Task 17: Wire `allowedTools` through env var into `AnthropicLlmClient`

**Files:**
- Modify: `src/agent-runtime/anthropic-llm-client.ts` (accept `allowedTools` option)
- Modify: `src/agent-runtime/main.ts` (read env var; pass option)
- Modify: `src/daemon/turn-processor.ts` (populate env var from AgentConfig)
- Modify: `agents/claude-assistant/agent.yaml` (set `allowed_tools`)
- Test: `src/agent-runtime/anthropic-llm-client.test.ts` (extend)

- [ ] **Step 1: Write failing test** — verify the options the SDK receives:

```typescript
it("passes allowedTools through to the claude-agent-sdk Options", async () => {
  // Intercept the SDK query() by injecting a module-level hook (existing test
  // pattern in anthropic-llm-client.test.ts — uses a lightweight doubling).
  const client = new AnthropicLlmClient({ allowedTools: ["Read", "Write"] });
  await client.createMessage({ /* ...minimal args... */ });
  expect(capturedOptions.allowedTools).toEqual(["Read", "Write"]);
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run src/agent-runtime/anthropic-llm-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `AnthropicLlmClientOpts` and `createMessage`**

```typescript
export interface AnthropicLlmClientOpts {
  executable?: "bun" | "deno" | "node";
  sessionIdFile?: string;
  configDir?: string;
  cwd?: string;
  allowedTools?: string[];   // M3: default [] (matches pre-M3 behaviour)
}

export class AnthropicLlmClient implements LlmClient {
  private readonly allowedTools: string[];
  // ...

  constructor(opts: AnthropicLlmClientOpts = {}) {
    // ...existing...
    this.allowedTools = opts.allowedTools ?? [];
  }

  async createMessage(args: LlmCreateArgs): Promise<LlmCreateResult> {
    // ...
    const options: Options = {
      executable: this.executable,
      model: args.model,
      cwd: this.cwd,
      allowedTools: this.allowedTools,  // M3: was hardcoded [], now configurable
      // ...rest unchanged...
    };
    // ...
  }
}
```

- [ ] **Step 4: Update `agent-runtime/main.ts`**

```typescript
// In buildLlmClient(), for provider === "anthropic":
const toolsRaw = process.env.TEAMROOM_ALLOWED_TOOLS ?? "";
const allowedTools = toolsRaw.trim() === ""
  ? []
  : toolsRaw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
return new AnthropicLlmClient({ allowedTools });
```

- [ ] **Step 5: Update `daemon/turn-processor.ts`** — populate the env var in the container spec:

```typescript
env: {
  // ...existing...
  TEAMROOM_ALLOWED_TOOLS: agentConfig.allowedTools.join(","),
},
```

- [ ] **Step 6: Set `allowed_tools` in `agents/claude-assistant/agent.yaml`**

```yaml
name: claude-assistant
provider: anthropic
model: claude-opus-4-7
image_tag: teamroom-agent-claude-assistant:latest
subscriptions:
  - claude-assistant
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
```

(Studio-assistant's yaml gets no `allowed_tools` — it inherits the `[]` default from `loadAgentConfig`.)

- [ ] **Step 7: Run tests + full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agent-runtime/anthropic-llm-client.ts src/agent-runtime/anthropic-llm-client.test.ts src/agent-runtime/main.ts src/daemon/turn-processor.ts agents/claude-assistant/agent.yaml
git commit -m "feat(agent-runtime): configurable allowedTools via env var; enable fs tools for claude-assistant"
```

---

## Phase 7 — Integration + smoke

### Task 18: Integration test — full DM round-trip with FakeRunner

**Files:**
- Create: `tests/integration/dm-round-trip.test.ts`

- [ ] **Step 1: Write the test** — the test is the deliverable:

```typescript
// tests/integration/dm-round-trip.test.ts
import { describe, it, expect } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { TurnRepo } from "../../src/db/turn-repo.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { AgentSubscriptionIndex } from "../../src/daemon/subscriptions.js";
import { Orchestrator } from "../../src/daemon/orchestrator.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
// ... plus existing test helpers for InMemoryBus, CapturingLogger, FakeClock, FakeModelProxy, genId, agent configs.

describe("DM round-trip integration", () => {
  it("claude→DM→studio→reply→claude→reply→CLI flow writes the expected rows", async () => {
    // 1. Build `:memory:` DB + repos.
    // 2. Register two agents: claude-assistant (subscriptions=["claude-assistant"]),
    //    studio-assistant (subscriptions=["studio-assistant"]).
    // 3. Build SubscriptionIndex.
    // 4. Build FakeRunner scripted to:
    //      - For a turn on claude-assistant with an inbound on channel=cli:
    //          emit {type:"dm", to:"studio-assistant", body:"ask: day of week"}.
    //      - For a turn on studio-assistant with an inbound on channel=dm:
    //          emit {type:"reply", body:"it is Sunday"}.
    //      - For a turn on claude-assistant with an inbound on channel=dm:
    //          emit {type:"reply", body:"studio says: it is Sunday"}.
    // 5. Build Orchestrator with those deps.
    // 6. Seed a CLI inbound message: (agent=claude-assistant, channel=cli,
    //      topic="", body="ask studio what day", conversationId="c-main").
    // 7. Tick orchestrator until `findPendingInbound()` returns empty (max 10 ticks).
    // 8. Assert the messages table contains:
    //      - 1 cli inbound (seeded)
    //      - 1 dm inbound (claude→studio, topic=studio-assistant, from=claude-assistant, conversation=c-main)
    //      - 1 dm inbound (studio→claude reply, topic=claude-assistant, from=studio-assistant, conversation=c-main)
    //      - 1 cli outbound (claude's final reply to user, conversation=c-main)
    // 9. Assert turns table contains 3 turns with conversation_id=c-main.
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `npx vitest run tests/integration/dm-round-trip.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/dm-round-trip.test.ts
git commit -m "test(integration): full DM round-trip with FakeRunner"
```

---

### Task 19: Integration test — conversation cap triggering

**Files:**
- Create: `tests/integration/conversation-cap.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/conversation-cap.test.ts
import { describe, it, expect } from "vitest";
// ...imports as above...

describe("Conversation cap integration", () => {
  it("runaway ping-pong between two agents is stopped at the cap", async () => {
    // Build the harness as in Task 18, but:
    //   - Script FakeRunner so both agents always emit {type:"dm", to:<the-other>, body:"ping"}.
    //     Never emit {type:"reply"}. This creates an infinite loop by design.
    //   - Set maxTurnsPerConversation = 5.
    // Seed a CLI inbound kicking off the loop.
    // Tick the orchestrator until findPendingInbound() stabilises.
    // Assert:
    //   - Exactly 5 turns were spawned with conversation_id=c-main (the last one was a cap-refusal, status=error, error=conversation_cap).
    //   - The logger captured at least one "conversation.limit_reached" entry.
    //   - No infinite loop / no test timeout.
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run tests/integration/conversation-cap.test.ts && npm test`
Expected: PASS.

```bash
git add tests/integration/conversation-cap.test.ts
git commit -m "test(integration): conversation cap prevents runaway loops"
```

---

### Task 20: Integration test — `/codebase` mount surface

**Files:**
- Create: `tests/integration/codebase-mount.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/codebase-mount.test.ts
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// ...

describe("Codebase mount integration", () => {
  it("FakeRunner observes a /codebase mount in the DockerRunSpec when codebasePath is set", async () => {
    const tmp = /* create tmp dir */;
    const codebaseDir = join(tmp, "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "README.md"), "hello");

    const runner = new FakeRunner();
    // ...build processTurn with codebasePath=codebaseDir and a seeded CLI inbound...
    await tickOrchestratorOnce();

    const spec = runner.lastRunSpec();
    expect(spec.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ containerPath: "/codebase", hostPath: codebaseDir, readOnly: false }),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npm test`
Expected: PASS.

```bash
git add tests/integration/codebase-mount.test.ts
git commit -m "test(integration): /codebase mount appears in container spec"
```

---

### Task 21: Seed `codebase/` with minimal content + update `agents/README.md`

**Files:**
- Modify/create: `codebase/README.md` (trim or replace what the user put there if needed)
- Modify: `agents/README.md` (add a note about /codebase mount visibility)
- Modify: `AGENTS.md` files in each agent (brief pointer so the LLM knows about /codebase + the `dm` stdout verb)

The user already created `codebase/` with "a couple of other folders and a README." Confirm the README exists and says something meaningful the smoke test can read. If empty, write:

```markdown
# /codebase — the shared work area

This directory is mounted read-write at `/codebase` in every agent container.
It represents the codebase the team is managing. For the M3 demo it is a
sample; eventually it points at any target codebase the operator chooses.

Agents read and write here using their filesystem tools. The harness itself
does not modify this directory.
```

- [ ] **Step 1: Write/update `codebase/README.md`** (see above).

- [ ] **Step 2: Update each agent's `AGENTS.md`** with a short instruction block:

```
## Communication

- Reply to the turn initiator: emit `{"type":"reply","body":"<text>"}` to stdout.
- Direct-message another agent: emit `{"type":"dm","to":"<agent-name>","body":"<text>"}`.
- When woken by a DM, you'll see `[dm from <sender>]` as a prefix on the user prompt.

## Shared codebase

- `/codebase` is a shared read-write mount visible to every agent.
- Use your filesystem tools to read and write files there.
```

Add to both `agents/claude-assistant/AGENTS.md` and `agents/studio-assistant/AGENTS.md`. (Studio-assistant doesn't have tools yet but the instructions are still relevant.)

- [ ] **Step 3: Update `agents/README.md`** with a one-paragraph note that every container now sees `/codebase`.

- [ ] **Step 4: Commit**

```bash
git add codebase/README.md agents/README.md agents/claude-assistant/AGENTS.md agents/studio-assistant/AGENTS.md
git commit -m "docs(agents): communication verbs + /codebase mount awareness"
```

---

### Task 22: Smoke test — exit scenario against real backends

**Files:**
- Modify: existing smoke test (likely `scripts/smoke-test.ts` or `tests/integration/<existing-smoke>.test.ts` — check the project layout).

Read the existing smoke test first to understand its shape and helpers, then extend with the exit scenario.

- [ ] **Step 1: Add a new scenario** that:
  1. Starts the daemon with both LM Studio + Anthropic credentials discovered (per M2 conventions).
  2. Sends a CLI message: `teamroom send claude-assistant "please ask studio-assistant to tell you a one-word greeting, then report back to me"`.
  3. Tails the CLI and waits up to 60 seconds for claude-assistant's final reply.
  4. Asserts the final reply mentions studio-assistant's greeting (exact text is LLM-dependent; assert the reply is non-empty and contains any non-empty body).
  5. Asserts (by querying the DB after) that:
     - ≥ 1 DM message with channel=dm, from=claude-assistant, topic=studio-assistant
     - ≥ 1 DM reply with channel=dm, from=studio-assistant, topic=claude-assistant
     - ≥ 1 outbound CLI message routed back to the user
     - All four messages share the same `conversation_id`.

- [ ] **Step 2: Run the smoke test locally**

Run: `npm run smoke` (or whatever the existing command is; verify from `package.json`).
Expected: PASS end-to-end with real Anthropic + real LM Studio.

**If the test fails:** investigate before moving on. Per `feedback_teamroom_no_failing_tests`, no test failure is acceptable to "leave for later." Common root causes to check: claude-assistant's AGENTS.md didn't steer it toward emitting `{type:"dm"}`; the stdin envelope context prefix was misrendered; the subscription index was empty due to a yaml typo.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/<smoke-file>  # or scripts/smoke-test.ts
git commit -m "test(smoke): m3 exit scenario — DM round-trip with /codebase read"
```

---

### Task 23: Full suite green + final commit

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test passes, including unit, integration, and real-backend smoke.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: `git status` — expect clean tree**

Run: `git status`
Expected: nothing to commit.

- [ ] **Step 4: Commit M3 capture** — a lightweight marker commit that captures any observations for the retro/as-built before moving to close-out:

Create a scratch note at `docs/tabled.md` if any observations should be retained for the retro; otherwise skip this step.

---

## Self-Review

**Spec coverage:**
- §1 In-scope — all covered: DM mechanism (T10, T11), subscriptions (T5, T6, T7, T12), DM routing (T11), reply routing for DM context (T14), self-DM rejection (T11), conversation cap (T15), conversation_id propagation (T8, T9), shared /codebase mount (T16), claude-assistant fs tools (T17).
- §2 Architecture — schema (T1), types (T2), repo updates (T3, T4), subscription index (T6), DM onEvent branch (T11), reply routing (T14), cap (T15), conversation_id lifecycle (T8, T9).
- §3 Agent surface — stdout verbs (T10, T11), stdin envelope extension (T13), subscription schema (T5, T12).
- §4 Edge cases — self-DM (T11), undelivered (T11), cap (T15), concurrency unchanged.
- §5 Codebase + tools — mount (T16), allowedTools (T17).
- §6 Testing + staged order — unit tests throughout; integration tests (T18, T19, T20); smoke test (T22). Order matches the spec's Phase 1–7.

**Placeholder scan:** No TBD/TODO/placeholder content; every task shows exact code.

**Type consistency:** `conversationId` (camelCase in TS), `conversation_id` (snake_case in SQL) used consistently; `fromAgentId` / `from_agent_id`; `allowedTools` / `allowed_tools`; `subscriptions` (both places).

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-04-19-m3-team-substrate-plan.md`.
