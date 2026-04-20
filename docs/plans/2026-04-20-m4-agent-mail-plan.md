# M4 Agent Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the agent-mail substrate from [`docs/specs/2026-04-20-m4-agent-mail-design.md`](../specs/2026-04-20-m4-agent-mail-design.md): per-agent durable inboxes, an HTTP MCP server exposing `mail.*` tools, channels-as-event-emitters, mailing lists with event triggers, daemon-owned container lifetime with a 30-min inactivity timer, and retirement of M3's DM primitive.

**Architecture:** Email rows evolve on the existing `messages` table; a new in-process typed event bus carries non-durable signals; a daemon-hosted HTTP MCP server exposes mail ops to containers via `host.docker.internal` (mirrors the M2 `LocalModelProxy` transport); `docker-runner` gains persistent stdin streaming so the daemon can push wake envelopes into live containers; a `SessionTimerManager` owns per-agent container lifetime.

**Tech Stack:** TypeScript (strict), Node ≥22, better-sqlite3, vitest, @anthropic-ai/claude-agent-sdk (existing MCP client support), existing M2 HTTP listener pattern for the MCP server.

---

## Pre-plan — full-chain feasibility spike (non-commit)

This is reading work, not a coding task. Do it before starting Task 1 so the plan's assumptions are verified end-to-end. The M3 retro promoted "full-chain feasibility spike" as a discipline — this is its first use.

**Read with these questions in mind:**

1. **claude-agent-sdk MCP client** — in `node_modules/@anthropic-ai/claude-agent-sdk`, find how MCP servers are registered on a session. What does the `Options.mcpServers` (or equivalent) field look like? Does it support HTTP/SSE transport out of the box, or only stdio?
   - Open the SDK's README / type definitions. Grep for `mcp` / `McpServer` / `ServerConfig`.
   - **If HTTP isn't natively supported**, note this before writing Task 5. Possible fallbacks: use an stdio MCP server inside the container that HTTP-calls the daemon, or upgrade the SDK.

2. **docker-runner stdin** — in `src/container/docker-runner.ts`, confirm the child process is spawned with `stdio: ['pipe', 'pipe', 'pipe']` (or similar), so stdin is a writable stream we can hold open. Verify `proc.stdin.write(...)` won't close the stream.
   - If the current shape closes stdin after the first write (`input: envelopeJson`), the Task 6 change is non-trivial.

3. **MCP HTTP server library** — decide between (a) `@modelcontextprotocol/sdk`'s server implementation if it ships a Node HTTP/SSE server, (b) hand-rolled Express-style handlers over Node's built-in `http` module. Prefer (a). Document the choice.
   - Check `npm view @modelcontextprotocol/sdk` or the package's README.

4. **Orchestrator ↔ SessionTimerManager** — read `src/daemon/orchestrator.ts` and `src/daemon/turn-processor.ts`. Identify where "spawn container for a new inbound" happens today. Confirm the new model (SessionTimerManager owns spawn; orchestrator ticks only schedule turn rows) is additive, not a rewrite.

5. **`claude-agent-sdk` reply wrapping** — in `src/agent-runtime/runtime.ts`, find exactly where the LLM's text response becomes `{type:"reply", body:<text>}`. That's the line Task 9 removes. Note its shape so the replacement "wake loop that doesn't auto-emit reply" is clear.

**Deliverable (non-commit):** a scratch note you can refer to as you implement. Doesn't need to be a file; can live in your session.

**Red-flag items that force a plan revision:**
- Claude SDK doesn't speak HTTP MCP → Task 5 pivots to stdio-in-container MCP bridging HTTP back to daemon.
- docker-runner uses a one-shot `.input` option that can't be extended → Task 6 grows.
- MCP SDK's server-side code is missing/immature → Task 5 hand-rolls a minimal MCP HTTP handler.

If any red flag hits, stop and re-discuss with the user before proceeding.

---

## Task 1 — Schema migration + types + MessageRepo

**Why one task:** the migration introduces columns that `Message` (in `src/types.ts`) and `MessageRepo` (in `src/db/message-repo.ts`) both consume. Splitting introduces intermediate states where the types don't match the schema. Tsconfig.test.json will still catch downstream fixture drift; this task just keeps the core triad consistent.

**Files:**
- Create: `src/db/migrations/003_m4_agent_mail.sql`
- Modify: `src/types.ts`
- Modify: `src/db/message-repo.ts`
- Test: `src/db/migrator.test.ts` (add one test for the new migration)
- Test: `src/db/message-repo.test.ts` (new round-trip + soft delete + index-use tests)

### Steps

- [ ] **Step 1: Write the migration SQL file**

Create `src/db/migrations/003_m4_agent_mail.sql`:

```sql
-- Migration 003: M4 agent mail
-- Adds email-shaped columns to messages; new indexes for inbox + thread views.

ALTER TABLE messages ADD COLUMN "to" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN "from" TEXT;
ALTER TABLE messages ADD COLUMN cc TEXT;
ALTER TABLE messages ADD COLUMN subject TEXT;
ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN read_at TEXT;
ALTER TABLE messages ADD COLUMN archived_at TEXT;
ALTER TABLE messages ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_messages_inbox
  ON messages(agent_id, read_at)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX idx_messages_thread ON messages(thread_id);
```

Note: `to` and `from` are SQLite reserved-ish tokens; they must be quoted. Timestamps land as TEXT (ISO 8601) matching M1/M2 convention for DB time fields.

- [ ] **Step 2: Update `Message` type in `src/types.ts`**

Add the new fields (the exact existing shape of `Message` is unchanged except for additions):

```ts
// Additions to the existing Message type
export type Message = {
  // ...existing M1/M2/M3 fields (id, agentId, channel, direction, body,
  // topic, fromAgentId, conversationId, traceId, turnId, createdAt, etc.)...

  // M4 additions
  to: string[];            // JSON array in DB; parsed here
  from: string | null;     // nullable: legacy rows have no from
  cc: string[] | null;     // JSON array in DB; parsed here; null if column was null
  subject: string | null;
  threadId: string | null;
  readAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
};
```

- [ ] **Step 3: Update `MessageRepo` — rowToMessage + create**

In `src/db/message-repo.ts`:

In `rowToMessage` (the row-mapper):
```ts
function rowToMessage(row: any): Message {
  return {
    // ...existing fields...
    to: JSON.parse(row.to ?? '[]'),
    from: row.from ?? null,
    cc: row.cc == null ? null : JSON.parse(row.cc),
    subject: row.subject ?? null,
    threadId: row.thread_id ?? null,
    readAt: row.read_at ?? null,
    archivedAt: row.archived_at ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}
```

In `create` (the insert statement): extend the SQL + parameter binding to carry the new columns. Default behavior for callers that don't pass them (e.g., legacy CLI outbound rows): `to=[], from=null, cc=null, subject=null, threadId=null, readAt=null, archivedAt=null, deletedAt=null`. Accept them in the `MessageCreate` input type with all new fields optional, defaulting to those values.

Add a new repo method `softDelete(id)`:
```ts
softDelete(id: string, now: string): void {
  this.db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(now, id);
}
```

Add `markRead(id, now)`, `archive(id, now)` with the analogous one-liners.

Add `listInbox(agentId, { unreadOnly, threadId, includeArchived, limit })`:
```ts
listInbox(agentId: string, opts: {
  unreadOnly?: boolean;
  threadId?: string;
  includeArchived?: boolean;
  limit?: number;
}): Message[] {
  const wheres: string[] = ['agent_id = ?', 'direction = ?', 'deleted_at IS NULL'];
  const params: any[] = [agentId, 'in'];
  if (!opts.includeArchived) wheres.push('archived_at IS NULL');
  if (opts.unreadOnly) wheres.push('read_at IS NULL');
  if (opts.threadId != null) { wheres.push('thread_id = ?'); params.push(opts.threadId); }
  const limit = opts.limit ?? 100;
  const sql = `SELECT * FROM messages WHERE ${wheres.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return this.db.prepare(sql).all(...params).map(rowToMessage);
}
```

Add `countInThread(threadId)` (used by thread-cap later):
```ts
countInThread(threadId: string): number {
  const row = this.db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE thread_id = ? AND deleted_at IS NULL'
  ).get(threadId) as { c: number };
  return row.c;
}
```

- [ ] **Step 4: Write repo tests**

Add to `src/db/message-repo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './database'; // whatever the existing test-db helper is

describe('MessageRepo — M4 additions', () => {
  it('round-trips to/from/cc/subject/thread_id/read_at fields', () => {
    const { repo } = makeTestDb();
    repo.create({
      id: 'm1',
      agentId: 'claude-assistant',
      channel: 'mail',
      direction: 'in',
      body: 'hello',
      to: ['agent:claude-assistant'],
      from: 'cli:don',
      cc: ['agent:claude-researcher'],
      subject: 'greetings',
      threadId: 'T1',
      createdAt: '2026-04-20T10:00:00Z',
      // ...other required legacy fields defaulted/passed...
    });
    const got = repo.get('m1')!;
    expect(got.to).toEqual(['agent:claude-assistant']);
    expect(got.from).toBe('cli:don');
    expect(got.cc).toEqual(['agent:claude-researcher']);
    expect(got.subject).toBe('greetings');
    expect(got.threadId).toBe('T1');
    expect(got.readAt).toBeNull();
  });

  it('softDelete sets deleted_at and hides from listInbox', () => {
    const { repo } = makeTestDb();
    repo.create({ id: 'm1', agentId: 'A', direction: 'in', channel: 'mail', body: 'x', threadId: 'T1', createdAt: '2026-04-20T10:00:00Z' });
    repo.softDelete('m1', '2026-04-20T11:00:00Z');
    expect(repo.listInbox('A', {})).toHaveLength(0);
    // But still queryable by id
    expect(repo.get('m1')!.deletedAt).toBe('2026-04-20T11:00:00Z');
  });

  it('markRead sets read_at; unreadOnly filter respects it', () => {
    const { repo } = makeTestDb();
    repo.create({ id: 'm1', agentId: 'A', direction: 'in', channel: 'mail', body: 'x', threadId: 'T1', createdAt: '2026-04-20T10:00:00Z' });
    repo.markRead('m1', '2026-04-20T10:05:00Z');
    expect(repo.listInbox('A', { unreadOnly: true })).toHaveLength(0);
    expect(repo.listInbox('A', { unreadOnly: false })).toHaveLength(1);
  });

  it('archive sets archived_at; default listInbox excludes, includeArchived re-includes', () => {
    const { repo } = makeTestDb();
    repo.create({ id: 'm1', agentId: 'A', direction: 'in', channel: 'mail', body: 'x', threadId: 'T1', createdAt: '2026-04-20T10:00:00Z' });
    repo.archive('m1', '2026-04-20T10:05:00Z');
    expect(repo.listInbox('A', {})).toHaveLength(0);
    expect(repo.listInbox('A', { includeArchived: true })).toHaveLength(1);
  });

  it('countInThread counts non-deleted rows only', () => {
    const { repo } = makeTestDb();
    repo.create({ id: 'm1', agentId: 'A', direction: 'in', channel: 'mail', body: 'x', threadId: 'T1', createdAt: '2026-04-20T10:00:00Z' });
    repo.create({ id: 'm2', agentId: 'A', direction: 'in', channel: 'mail', body: 'y', threadId: 'T1', createdAt: '2026-04-20T10:01:00Z' });
    repo.create({ id: 'm3', agentId: 'B', direction: 'in', channel: 'mail', body: 'z', threadId: 'T2', createdAt: '2026-04-20T10:02:00Z' });
    expect(repo.countInThread('T1')).toBe(2);
    repo.softDelete('m1', '2026-04-20T10:10:00Z');
    expect(repo.countInThread('T1')).toBe(1);
  });
});
```

- [ ] **Step 5: Add migrator test**

In `src/db/migrator.test.ts`, append one assertion that migration 003 runs on a fresh M2-state DB and the new columns + indexes exist. Pattern it on the existing migration tests.

- [ ] **Step 6: Run tests; verify failures**

```
npm test -- src/db/message-repo.test.ts src/db/migrator.test.ts
```

Expected: failures on the new tests — `to` undefined, `softDelete` not a function, migration file not found, etc.

- [ ] **Step 7: Iterate until green**

Implement the migration, type changes, repo updates. Re-run after each chunk. When green:

```
npm test
```

Expect some **pre-existing unrelated tests to fail** due to fixture drift (missing new required fields on `Message` literals used in integration tests). Note them — Task 1 doesn't fix the downstream tests. They'll be fixed as those areas are touched in later tasks, or swept in Task 17 verification.

Actually — that's too loose. Fix the drift now by making all new `Message` fields optional/nullable at the type level (which the shape above already does) and defaulting them in the repo `create` call. If a fixture passes no `to`, it becomes `[]`; no `threadId`, it becomes `null`. This keeps existing fixtures valid. Run `npm test` again; expect full green except for the explicit M3 DM tests (which stay green until Task 11 retires them).

Tsconfig check:
```
npm run typecheck
```
Expected: clean across both configs.

- [ ] **Step 8: Commit**

```
git add src/db/migrations/003_m4_agent_mail.sql src/types.ts src/db/message-repo.ts src/db/message-repo.test.ts src/db/migrator.test.ts
git commit -m "feat(m4-t1): schema migration + message fields + mail-shaped repo ops"
```

---

## Task 2 — Event bus module

**Files:**
- Create: `src/bus/event-bus.ts`
- Create: `src/bus/event-bus.test.ts`
- Modify: `src/bus/README.md` (add one line documenting the new module)

### Steps

- [ ] **Step 1: Write the failing tests**

`src/bus/event-bus.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './event-bus';

describe('EventBus', () => {
  it('delivers published events to subscribers of matching type', () => {
    const bus = new EventBus();
    const received: any[] = [];
    bus.subscribe('mail.delivered', (p) => received.push(p));
    bus.publish('mail.delivered', { to: 'agent:X' });
    expect(received).toEqual([{ to: 'agent:X' }]);
  });

  it('does not deliver to subscribers of other types', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('mail.delivered', a);
    bus.subscribe('tool.call', b);
    bus.publish('mail.delivered', { to: 'agent:X' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers to the same type', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('tool.call', a);
    bus.subscribe('tool.call', b);
    bus.publish('tool.call', { agentId: 'X', tool: 'mail.list' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops deliveries', () => {
    const bus = new EventBus();
    const h = vi.fn();
    const off = bus.subscribe('tool.call', h);
    off();
    bus.publish('tool.call', {});
    expect(h).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscriber — other subscribers still fire', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe('tool.call', () => { throw new Error('boom'); });
    bus.subscribe('tool.call', good);
    // Must not throw to the caller of publish().
    expect(() => bus.publish('tool.call', {})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — expect "no such module" / failing imports**

```
npm test -- src/bus/event-bus.test.ts
```

- [ ] **Step 3: Implement EventBus**

`src/bus/event-bus.ts`:

```ts
import type { Logger } from '../logger/logger';

export type EventType = string;
export type EventHandler<P = any> = (payload: P) => void;

export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();

  constructor(private logger?: Logger) {}

  subscribe<P = any>(type: EventType, handler: EventHandler<P>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  publish<P = any>(type: EventType, payload: P): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        this.logger?.warn({ event: 'event-bus.handler.error', type, error: String(err) });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests — green**

```
npm test -- src/bus/event-bus.test.ts
```

- [ ] **Step 5: Document and commit**

Update `src/bus/README.md` to list the new file alongside the existing NotifyBus entries with one sentence: "`event-bus.ts` — typed, in-process publish/subscribe for M4 event signals (mail, session, tool-call, channel). Not durable; crashes drop events."

```
git add src/bus/event-bus.ts src/bus/event-bus.test.ts src/bus/README.md
git commit -m "feat(m4-t2): typed in-process EventBus for M4 signals"
```

---

## Task 3 — MailDispatcher core (agent + CLI recipients + validation + thread cap)

**Files:**
- Create: `src/mail-dispatcher/mail-dispatcher.ts`
- Create: `src/mail-dispatcher/address.ts` (parsing helper used here and in Task 5)
- Create: `src/mail-dispatcher/address.test.ts`
- Create: `src/mail-dispatcher/mail-dispatcher.test.ts`

**Defer to Task 4:** `list:<name>` expansion. This task's dispatcher throws "list expansion not yet implemented" if a `list:*` address is passed. Task 4 plugs it in.

### Steps

- [ ] **Step 1: Write address-parsing tests**

`src/mail-dispatcher/address.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAddress, formatAddress, type Address } from './address';

describe('parseAddress', () => {
  it.each([
    ['agent:claude-assistant', { kind: 'agent', name: 'claude-assistant' }],
    ['cli:don', { kind: 'cli', user: 'don' }],
    ['list:harness-activity', { kind: 'list', name: 'harness-activity' }],
  ])('parses %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each([
    'no-prefix',
    ':empty-prefix',
    'agent:', // empty name
    'xxx:foo',
  ])('rejects %s', (s) => {
    expect(() => parseAddress(s)).toThrow();
  });
});

describe('formatAddress', () => {
  it('round-trips', () => {
    const addrs: Address[] = [
      { kind: 'agent', name: 'a' },
      { kind: 'cli', user: 'u' },
      { kind: 'list', name: 'l' },
    ];
    for (const a of addrs) {
      expect(parseAddress(formatAddress(a))).toEqual(a);
    }
  });
});
```

- [ ] **Step 2: Implement `address.ts`**

```ts
export type Address =
  | { kind: 'agent'; name: string }
  | { kind: 'cli'; user: string }
  | { kind: 'list'; name: string };

const VALID_PREFIXES = new Set(['agent', 'cli', 'list']);

export function parseAddress(s: string): Address {
  const idx = s.indexOf(':');
  if (idx <= 0 || idx === s.length - 1) throw new Error(`invalid address: ${s}`);
  const prefix = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  if (!VALID_PREFIXES.has(prefix)) throw new Error(`unknown address prefix: ${prefix}`);
  if (prefix === 'agent') return { kind: 'agent', name: rest };
  if (prefix === 'cli') return { kind: 'cli', user: rest };
  return { kind: 'list', name: rest };
}

export function formatAddress(a: Address): string {
  switch (a.kind) {
    case 'agent': return `agent:${a.name}`;
    case 'cli': return `cli:${a.user}`;
    case 'list': return `list:${a.name}`;
  }
}
```

- [ ] **Step 3: Run address tests — green**

```
npm test -- src/mail-dispatcher/address.test.ts
```

- [ ] **Step 4: Write dispatcher tests (list expansion omitted for now)**

`src/mail-dispatcher/mail-dispatcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MailDispatcher } from './mail-dispatcher';
import { makeTestDb } from '../db/database';
import { EventBus } from '../bus/event-bus';

const knownAgents = new Set(['claude-assistant', 'claude-researcher']);
const knownLists = new Set<string>(); // none in Task 3

function makeDispatcher() {
  const { repo, db } = makeTestDb();
  const bus = new EventBus();
  const clock = { now: () => '2026-04-20T10:00:00Z', epochMs: () => 1745150400000 };
  const dispatcher = new MailDispatcher({
    messageRepo: repo,
    bus,
    clock,
    genId: () => 'generated-id',
    knownAgents: (name) => knownAgents.has(name),
    knownLists: (name) => knownLists.has(name),
    listSubscribers: (_name) => { throw new Error('list expansion not yet implemented'); },
    maxMailsPerThread: 10,
  });
  return { dispatcher, repo, bus, db };
}

describe('MailDispatcher — agent recipient', () => {
  it('inserts one email row in the recipient agent inbox', () => {
    const { dispatcher, repo, bus } = makeDispatcher();
    const events: any[] = [];
    bus.subscribe('mail.delivered', (p) => events.push(p));
    const result = dispatcher.sendMail({
      from: 'cli:don',
      to: ['agent:claude-assistant'],
      body: 'hi',
    });
    expect(result.threadId).toBeTruthy();
    const rows = repo.listInbox('claude-assistant', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe('cli:don');
    expect(rows[0].to).toEqual(['agent:claude-assistant']);
    expect(rows[0].threadId).toBe(result.threadId);
    expect(events).toEqual([{ to: 'claude-assistant' }]);
  });

  it('inherits thread_id when explicitly provided', () => {
    const { dispatcher, repo } = makeDispatcher();
    const r1 = dispatcher.sendMail({ from: 'cli:don', to: ['agent:claude-assistant'], body: 'first' });
    const r2 = dispatcher.sendMail({ from: 'cli:don', to: ['agent:claude-assistant'], body: 'second', threadId: r1.threadId });
    expect(r2.threadId).toBe(r1.threadId);
    const rows = repo.listInbox('claude-assistant', { threadId: r1.threadId });
    expect(rows).toHaveLength(2);
  });
});

describe('MailDispatcher — cli recipient', () => {
  it('inserts a plain CLI outbound row, no email row, publishes channel.cli.out', () => {
    const { dispatcher, repo, bus } = makeDispatcher();
    const events: any[] = [];
    bus.subscribe('channel.cli.out', (p) => events.push(p));
    dispatcher.sendMail({
      from: 'agent:claude-assistant',
      to: ['cli:don'],
      body: 'done',
    });
    // CLI rows live in messages with channel=cli, direction=out.
    const cliRows = repo.listCliOutbound('don'); // add this helper to MessageRepo; or grep by channel
    expect(cliRows).toHaveLength(1);
    expect(cliRows[0].body).toBe('done');
    expect(events).toEqual([{ user: 'don' }]);
    // And no email row anywhere for cli:don
    expect(repo.listInbox('cli:don', {})).toHaveLength(0);
  });
});

describe('MailDispatcher — validation', () => {
  it('atomically rejects an unknown agent recipient', () => {
    const { dispatcher, repo } = makeDispatcher();
    expect(() => dispatcher.sendMail({
      from: 'cli:don',
      to: ['agent:nonexistent', 'agent:claude-assistant'],
      body: 'x',
    })).toThrow(/unknown recipient/i);
    // Nothing persisted for claude-assistant either.
    expect(repo.listInbox('claude-assistant', {})).toHaveLength(0);
  });

  it('throws "list expansion not yet implemented" for list:* addresses', () => {
    const { dispatcher } = makeDispatcher();
    expect(() => dispatcher.sendMail({
      from: 'cli:don',
      to: ['list:anything'],
      body: 'x',
    })).toThrow(/list expansion/i);
  });
});

describe('MailDispatcher — thread cap', () => {
  it('rejects sends when thread already at the cap', () => {
    const { dispatcher, repo } = makeDispatcher();
    // Seed the thread at exactly the cap.
    const seedThreadId = 'T1';
    for (let i = 0; i < 10; i++) {
      repo.create({
        id: `m${i}`, agentId: 'claude-assistant', direction: 'in', channel: 'mail',
        body: `#${i}`, threadId: seedThreadId,
        createdAt: `2026-04-20T10:0${i}:00Z`,
      });
    }
    expect(() => dispatcher.sendMail({
      from: 'cli:don',
      to: ['agent:claude-assistant'],
      body: 'one more',
      threadId: seedThreadId,
    })).toThrow(/thread cap/i);
  });

  it('cap=0 disables', () => {
    const { dispatcher, repo, bus } = (() => {
      const { repo, db } = makeTestDb();
      const bus = new EventBus();
      const clock = { now: () => '2026-04-20T10:00:00Z', epochMs: () => 1745150400000 };
      const dispatcher = new MailDispatcher({
        messageRepo: repo, bus, clock,
        genId: () => 'gen',
        knownAgents: (n) => knownAgents.has(n),
        knownLists: (n) => false,
        listSubscribers: () => { throw new Error('unused'); },
        maxMailsPerThread: 0,
      });
      return { dispatcher, repo, bus, db };
    })();
    // Seed 100 rows in one thread.
    for (let i = 0; i < 100; i++) {
      repo.create({ id: `m${i}`, agentId: 'claude-assistant', direction: 'in', channel: 'mail', body: '', threadId: 'T', createdAt: '2026-04-20T10:00:00Z' });
    }
    // Cap disabled → doesn't throw.
    expect(() => dispatcher.sendMail({
      from: 'cli:don', to: ['agent:claude-assistant'], body: 'x', threadId: 'T',
    })).not.toThrow();
  });
});
```

Note: `repo.listCliOutbound(user)` needs adding in this task (or use a direct query helper). Keep it simple:
```ts
// In MessageRepo
listCliOutbound(user: string, limit = 100): Message[] {
  // In M4 the CLI outbound row doesn't carry the user id directly;
  // for tests, filter on channel=cli + direction=out. If we need per-user
  // filtering later, we can add a column then.
  return this.db.prepare(
    `SELECT * FROM messages WHERE channel = 'cli' AND direction = 'out' ORDER BY created_at DESC LIMIT ?`
  ).all(limit).map(rowToMessage);
}
```
(The user parameter is ignored for now — single-user CLI in M4. Revisit when the CLI multi-user question arises.)

- [ ] **Step 5: Run — fail on "no MailDispatcher"**

```
npm test -- src/mail-dispatcher/
```

- [ ] **Step 6: Implement MailDispatcher**

`src/mail-dispatcher/mail-dispatcher.ts`:

```ts
import type { MessageRepo } from '../db/message-repo';
import type { EventBus } from '../bus/event-bus';
import type { Clock } from '../clock/clock';
import { parseAddress, type Address } from './address';

export interface MailDispatcherDeps {
  messageRepo: MessageRepo;
  bus: EventBus;
  clock: Clock;
  genId: () => string;
  knownAgents: (name: string) => boolean;
  knownLists: (name: string) => boolean;
  listSubscribers: (name: string) => string[]; // returns agent names; used in Task 4
  maxMailsPerThread: number; // 0 disables
}

export interface SendMailInput {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  threadId?: string | null;
}

export interface SendMailResult {
  threadId: string;
  rowIds: string[]; // one per recipient row inserted (agent + cli), post-expansion
}

export class MailDispatcher {
  constructor(private deps: MailDispatcherDeps) {}

  sendMail(input: SendMailInput): SendMailResult {
    const threadId = input.threadId ?? this.deps.genId();

    const parsedTo = input.to.map(parseAddress);
    const parsedCc = (input.cc ?? []).map(parseAddress);

    // Validate every recipient before expansion, atomically.
    for (const a of [...parsedTo, ...parsedCc]) {
      if (a.kind === 'agent' && !this.deps.knownAgents(a.name)) {
        throw new Error(`unknown recipient: agent:${a.name}`);
      }
      if (a.kind === 'list' && !this.deps.knownLists(a.name)) {
        throw new Error(`unknown recipient: list:${a.name}`);
      }
    }

    // Expansion (Task 3: lists throw; Task 4 plugs in).
    const expandedTo = this.expand(parsedTo);
    const expandedCc = this.expand(parsedCc);

    // Thread-cap check.
    const cap = this.deps.maxMailsPerThread;
    if (cap > 0) {
      const existing = this.deps.messageRepo.countInThread(threadId);
      // Rows we'd add: one per agent/cli in expandedTo + expandedCc.
      const incoming = expandedTo.length + expandedCc.length;
      if (existing + incoming > cap) {
        throw new Error(`thread cap reached (thread=${threadId}, cap=${cap})`);
      }
    }

    const toStrings = expandedTo.map((a) => this.formatAddr(a));
    const ccStrings = expandedCc.length === 0 ? null : expandedCc.map((a) => this.formatAddr(a));

    const rowIds: string[] = [];

    for (const addr of [...expandedTo, ...expandedCc]) {
      const id = this.deps.genId();
      rowIds.push(id);
      if (addr.kind === 'agent') {
        this.deps.messageRepo.create({
          id,
          agentId: addr.name,
          channel: 'mail',
          direction: 'in',
          body: input.body,
          to: toStrings,
          from: input.from,
          cc: ccStrings,
          subject: input.subject ?? null,
          threadId,
          createdAt: this.deps.clock.now(),
        });
        this.deps.bus.publish('mail.delivered', { to: addr.name });
      } else if (addr.kind === 'cli') {
        // Plain CLI outbound row — no email columns populated except body/thread_id.
        // agentId carries the sending agent (matches M3's convention where CLI
        // outbound rows are scoped to the agent that produced them). `system`
        // sends — e.g., mailing-list fanout — get agentId of the sender name
        // verbatim; downstream readers (`teamroom tail`) treat it as an opaque label.
        const senderAddr = parseAddress(input.from);
        const outboundAgentId = senderAddr.kind === 'agent' ? senderAddr.name : input.from;
        this.deps.messageRepo.create({
          id,
          agentId: outboundAgentId,
          channel: 'cli',
          direction: 'out',
          body: input.body,
          threadId,
          createdAt: this.deps.clock.now(),
        });
        this.deps.bus.publish('channel.cli.out', { user: addr.user });
      }
      // list.kind is already expanded by this.expand().
    }

    // mail.sent fires once for the sender's outbound notification.
    // Only publish if the sender is an agent (cli:* senders don't have a session to reset).
    const sender = parseAddress(input.from);
    if (sender.kind === 'agent') {
      this.deps.bus.publish('mail.sent', { from: sender.name });
    }

    return { threadId, rowIds };
  }

  private expand(addrs: Address[]): Address[] {
    const out: Address[] = [];
    for (const a of addrs) {
      if (a.kind === 'list') {
        const subs = this.deps.listSubscribers(a.name);
        for (const s of subs) out.push({ kind: 'agent', name: s });
      } else {
        out.push(a);
      }
    }
    return out;
  }

  private formatAddr(a: Address): string {
    if (a.kind === 'agent') return `agent:${a.name}`;
    if (a.kind === 'cli') return `cli:${a.user}`;
    return `list:${a.name}`;
  }
}
```

- [ ] **Step 7: Iterate tests until green**

```
npm test -- src/mail-dispatcher/
```

- [ ] **Step 8: Commit**

```
git add src/mail-dispatcher/
git commit -m "feat(m4-t3): MailDispatcher — agent+cli recipients, validation, thread cap"
```

---

## Task 4 — MailingListRegistry + trigger listener + list expansion wired into dispatcher

**Files:**
- Create: `src/mailing-lists/registry.ts`
- Create: `src/mailing-lists/registry.test.ts`
- Create: `src/mailing-lists/trigger-listener.ts`
- Create: `src/mailing-lists/trigger-listener.test.ts`
- Create (config file): `lists.yaml` at repo root, seeded with `list:harness-activity`.
- Modify: daemon composition (`src/daemon/daemon.ts`) to build the registry at boot and pass to dispatcher via `knownLists` + `listSubscribers` closures.

### Steps

- [ ] **Step 1: Write registry tests**

`src/mailing-lists/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MailingListRegistry, type ListDefinition } from './registry';
import type { AgentConfig } from '../agent-config/agent-config';

function cfg(name: string, subs: string[]): AgentConfig {
  return { name, allowedTools: [], subscriptions: subs } as AgentConfig;
}

describe('MailingListRegistry', () => {
  const lists: ListDefinition[] = [
    { name: 'harness-activity', triggers: ['turn.started', 'turn.completed'] },
    { name: 'qa', triggers: [] },
  ];

  it('records list definitions and allows knownLists lookup', () => {
    const reg = new MailingListRegistry(lists, [
      cfg('claude-researcher', ['list:harness-activity', 'list:qa']),
      cfg('claude-assistant', ['list:harness-activity']),
    ]);
    expect(reg.has('harness-activity')).toBe(true);
    expect(reg.has('qa')).toBe(true);
    expect(reg.has('nonexistent')).toBe(false);
  });

  it('resolves subscribers via reverse index from agent configs', () => {
    const reg = new MailingListRegistry(lists, [
      cfg('claude-researcher', ['list:harness-activity', 'list:qa']),
      cfg('claude-assistant', ['list:harness-activity']),
    ]);
    expect(reg.subscribers('harness-activity').sort()).toEqual(['claude-assistant', 'claude-researcher']);
    expect(reg.subscribers('qa')).toEqual(['claude-researcher']);
    expect(reg.subscribers('nonexistent')).toEqual([]);
  });

  it('rejects an agent subscribing to a non-existent list (startup-time fail)', () => {
    expect(() => new MailingListRegistry(lists, [
      cfg('a', ['list:ghost']),
    ])).toThrow(/unknown list: ghost/);
  });

  it('ignores non-list: subscriptions (startup-time fail — strict mode)', () => {
    // M4 only supports list:* in subscriptions per spec.
    expect(() => new MailingListRegistry(lists, [
      cfg('a', ['agent:x']),
    ])).toThrow(/only list: subscriptions/i);
  });

  it('triggersFor returns event types that fire this list', () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.triggersFor('harness-activity').sort()).toEqual(['turn.completed', 'turn.started']);
    expect(reg.triggersFor('qa')).toEqual([]);
  });

  it('listsTriggeredBy returns all lists triggered by an event type', () => {
    const reg = new MailingListRegistry(lists, []);
    expect(reg.listsTriggeredBy('turn.started')).toEqual(['harness-activity']);
    expect(reg.listsTriggeredBy('unused.event')).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement registry**

`src/mailing-lists/registry.ts`:

```ts
import type { AgentConfig } from '../agent-config/agent-config';
import { parseAddress } from '../mail-dispatcher/address';

export interface ListDefinition {
  name: string;
  triggers: string[]; // event types
}

export class MailingListRegistry {
  private byList: Map<string, Set<string>> = new Map();           // list → subscriber agent names
  private byEvent: Map<string, Set<string>> = new Map();          // event type → list names
  private defs: Map<string, ListDefinition> = new Map();

  constructor(lists: ListDefinition[], agentConfigs: AgentConfig[]) {
    for (const ld of lists) {
      this.defs.set(ld.name, ld);
      this.byList.set(ld.name, new Set());
      for (const ev of ld.triggers) {
        if (!this.byEvent.has(ev)) this.byEvent.set(ev, new Set());
        this.byEvent.get(ev)!.add(ld.name);
      }
    }
    for (const cfg of agentConfigs) {
      for (const sub of cfg.subscriptions ?? []) {
        const parsed = parseAddress(sub);
        if (parsed.kind !== 'list') {
          throw new Error(`agent.yaml subscriptions only accept list: addresses (got ${sub} on ${cfg.name})`);
        }
        if (!this.defs.has(parsed.name)) {
          throw new Error(`unknown list: ${parsed.name} (subscribed by ${cfg.name})`);
        }
        this.byList.get(parsed.name)!.add(cfg.name);
      }
    }
  }

  has(name: string): boolean { return this.defs.has(name); }

  subscribers(name: string): string[] {
    const set = this.byList.get(name);
    return set ? [...set] : [];
  }

  triggersFor(name: string): string[] {
    return this.defs.get(name)?.triggers ?? [];
  }

  listsTriggeredBy(eventType: string): string[] {
    const set = this.byEvent.get(eventType);
    return set ? [...set] : [];
  }
}
```

- [ ] **Step 3: Write trigger-listener tests**

`src/mailing-lists/trigger-listener.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MailingListTriggerListener } from './trigger-listener';
import { MailingListRegistry } from './registry';
import { EventBus } from '../bus/event-bus';
import type { MailDispatcher } from '../mail-dispatcher/mail-dispatcher';

describe('MailingListTriggerListener', () => {
  it('forwards bus events that trigger lists to the dispatcher', () => {
    const registry = new MailingListRegistry(
      [{ name: 'harness-activity', triggers: ['turn.started'] }],
      []
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;

    new MailingListTriggerListener({
      bus, registry, dispatcher,
      formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
    });

    bus.publish('turn.started', { agentId: 'X', turnId: 'T' });

    expect(dispatcher.sendMail).toHaveBeenCalledWith({
      from: 'system',
      to: ['list:harness-activity'],
      subject: undefined,
      body: 'turn.started: {"agentId":"X","turnId":"T"}',
      threadId: null,
    });
  });

  it('ignores events that trigger no lists', () => {
    const registry = new MailingListRegistry(
      [{ name: 'harness-activity', triggers: ['turn.started'] }],
      []
    );
    const bus = new EventBus();
    const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;
    new MailingListTriggerListener({ bus, registry, dispatcher, formatBody: () => '' });
    bus.publish('unrelated.event', {});
    expect(dispatcher.sendMail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Implement trigger listener**

`src/mailing-lists/trigger-listener.ts`:

```ts
import type { EventBus } from '../bus/event-bus';
import type { MailingListRegistry } from './registry';
import type { MailDispatcher } from '../mail-dispatcher/mail-dispatcher';

export interface TriggerListenerDeps {
  bus: EventBus;
  registry: MailingListRegistry;
  dispatcher: MailDispatcher;
  formatBody: (eventType: string, payload: unknown) => string;
}

export class MailingListTriggerListener {
  constructor(deps: TriggerListenerDeps) {
    // Subscribe to the union of all trigger events.
    const seen = new Set<string>();
    // Iterate every list's triggers (registry doesn't currently expose iteration;
    // simplest: have a method to enumerate).
    // Add a `allTriggers()` method to the registry returning string[] — update
    // registry.ts to include it.
    for (const ev of deps.registry.allTriggers()) {
      if (seen.has(ev)) continue;
      seen.add(ev);
      deps.bus.subscribe(ev, (payload) => {
        const lists = deps.registry.listsTriggeredBy(ev);
        for (const listName of lists) {
          deps.dispatcher.sendMail({
            from: 'system',
            to: [`list:${listName}`],
            subject: undefined,
            body: deps.formatBody(ev, payload),
            threadId: null,
          });
        }
      });
    }
  }
}
```

Add to `registry.ts`:
```ts
allTriggers(): string[] {
  return [...this.byEvent.keys()];
}
```

- [ ] **Step 5: Wire list expansion into the dispatcher**

Update the dispatcher's existing `listSubscribers` dep to actually go through the registry. In daemon composition (Task 8 finalizes this, but the plumbing starts here):

```ts
const registry = new MailingListRegistry(loadedLists, agentConfigs);
const dispatcher = new MailDispatcher({
  // ...
  knownLists: (n) => registry.has(n),
  listSubscribers: (n) => registry.subscribers(n),
});
```

Update `MailDispatcher` tests — add a multi-recipient fanout case:

```ts
describe('MailDispatcher — list expansion (multi-recipient)', () => {
  it('expands list:* to subscribers and sets to[] on all recipient rows', () => {
    const { repo } = makeTestDb();
    const bus = new EventBus();
    const clock = { now: () => 'ts', epochMs: () => 0 };
    let idx = 0;
    const dispatcher = new MailDispatcher({
      messageRepo: repo, bus, clock,
      genId: () => `id-${idx++}`,
      knownAgents: (n) => ['A','B','C'].includes(n),
      knownLists: (n) => n === 'team',
      listSubscribers: (n) => n === 'team' ? ['A','B','C'] : [],
      maxMailsPerThread: 0,
    });
    dispatcher.sendMail({ from: 'system', to: ['list:team'], body: 'announce', threadId: null });
    for (const who of ['A','B','C']) {
      const rows = repo.listInbox(who, {});
      expect(rows).toHaveLength(1);
      // Expanded to[] must include all subscribers, not just the owner.
      expect(rows[0].to.sort()).toEqual(['agent:A','agent:B','agent:C']);
    }
  });
});
```

- [ ] **Step 6: Create seed `lists.yaml` at repo root**

```yaml
# lists.yaml — mailing list registry
# Subscribers are declared in each agent's agent.yaml via `subscriptions: [list:<name>]`.
lists:
  - name: harness-activity
    triggers: [turn.started, turn.completed]
```

- [ ] **Step 7: Loader for `lists.yaml`**

Add `src/mailing-lists/loader.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ListDefinition } from './registry';

export function loadListsYaml(path: string): ListDefinition[] {
  const raw = readFileSync(path, 'utf8');
  const parsed = parse(raw) as { lists?: ListDefinition[] };
  if (!parsed?.lists) return [];
  for (const l of parsed.lists) {
    if (!l.name) throw new Error(`lists.yaml: missing name`);
    if (!Array.isArray(l.triggers)) throw new Error(`lists.yaml: triggers must be array for ${l.name}`);
  }
  return parsed.lists;
}
```

- [ ] **Step 8: Run tests — green**

```
npm test -- src/mailing-lists/ src/mail-dispatcher/
```

- [ ] **Step 9: Commit**

```
git add src/mailing-lists/ lists.yaml src/mail-dispatcher/mail-dispatcher.ts src/mail-dispatcher/mail-dispatcher.test.ts
git commit -m "feat(m4-t4): MailingListRegistry + trigger listener + list expansion in dispatcher"
```

---

## Task 5 — MCP mail server (HTTP, auth, all tools)

**Files:**
- Create: `src/mail-mcp/server.ts` — HTTP listener + token auth + tool registry.
- Create: `src/mail-mcp/tools.ts` — tool implementations (thin wrappers around repo + dispatcher).
- Create: `src/mail-mcp/server.test.ts`
- Create: `src/mail-mcp/tools.test.ts`

**Choice point from the feasibility spike:** if `@modelcontextprotocol/sdk` offers an HTTP server implementation for Node, use it. Otherwise hand-roll over `node:http` with the JSON-RPC 2.0 shape MCP mandates. The body of this task assumes hand-rolled; if the SDK works, adapt.

### Steps

- [ ] **Step 1: Tool implementations — unit tests (don't need the HTTP layer)**

`src/mail-mcp/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MailMcpTools } from './tools';
import { makeTestDb } from '../db/database';
import { EventBus } from '../bus/event-bus';
import { MailDispatcher } from '../mail-dispatcher/mail-dispatcher';

function setup() {
  const { repo } = makeTestDb();
  const bus = new EventBus();
  const clock = { now: () => 'ts', epochMs: () => 0 };
  const dispatcher = new MailDispatcher({
    messageRepo: repo, bus, clock, genId: () => 'g',
    knownAgents: (n) => ['A','B'].includes(n),
    knownLists: () => false, listSubscribers: () => [],
    maxMailsPerThread: 10,
  });
  const tools = new MailMcpTools({ messageRepo: repo, dispatcher, bus });
  return { tools, repo, bus };
}

describe('MailMcpTools', () => {
  it('list returns caller inbox summaries', () => {
    const { tools, repo } = setup();
    repo.create({ id: 'r1', agentId: 'A', channel: 'mail', direction: 'in', body: 'hi', threadId: 'T1', createdAt: 'ts' });
    const out = tools.list({ callerAgentId: 'A' }, {});
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('r1');
  });

  it('get returns only if caller owns the row', () => {
    const { tools, repo } = setup();
    repo.create({ id: 'r1', agentId: 'A', channel: 'mail', direction: 'in', body: 'hi', threadId: 'T1', createdAt: 'ts' });
    expect(() => tools.get({ callerAgentId: 'B' }, { id: 'r1' })).toThrow(/not found|forbidden/i);
    expect(tools.get({ callerAgentId: 'A' }, { id: 'r1' }).id).toBe('r1');
  });

  it('send delegates to dispatcher and publishes tool.call', () => {
    const { tools, bus } = setup();
    const calls: any[] = [];
    bus.subscribe('tool.call', (p) => calls.push(p));
    const r = tools.send({ callerAgentId: 'A' }, { to: ['agent:B'], body: 'hey' });
    expect(r.threadId).toBeTruthy();
    expect(calls).toContainEqual({ agentId: 'A', tool: 'mail.send' });
  });

  it('reply sets to=[original.from], inherits thread_id', () => {
    const { tools, repo } = setup();
    repo.create({
      id: 'r1', agentId: 'A', channel: 'mail', direction: 'in', body: 'hi',
      threadId: 'T1', from: 'agent:B', to: ['agent:A'], createdAt: 'ts',
    });
    const r = tools.reply({ callerAgentId: 'A' }, { id: 'r1', body: 'hello back' });
    expect(r.threadId).toBe('T1');
    // Verify B received the reply.
    const bRows = repo.listInbox('B', {});
    expect(bRows.some((m) => m.body === 'hello back' && m.threadId === 'T1')).toBe(true);
  });

  it('reply cc_all=true populates cc with original.to ∪ cc minus self', () => {
    const { tools, repo } = setup();
    repo.create({
      id: 'r1', agentId: 'A', channel: 'mail', direction: 'in', body: 'hi',
      threadId: 'T1', from: 'agent:B', to: ['agent:A', 'agent:B'], cc: null,
      createdAt: 'ts',
    });
    // reply from A → to [B] (original.from), cc [] (original.to=[A,B] minus self=A → just [B], but B is already in to; so cc ends up empty or [B] depending on spec).
    // Per spec: cc = original.to ∪ original.cc minus self. Here: {A,B} minus A = {B}.
    const r = tools.reply({ callerAgentId: 'A' }, { id: 'r1', body: 'hello', ccAll: true });
    const bRows = repo.listInbox('B', {});
    const last = bRows.find((m) => m.body === 'hello')!;
    // to is [B] (from original.from); cc has B.
    expect(last.to).toEqual(['agent:B']);
    expect(last.cc).toEqual(['agent:B']);
  });

  it('mark_read / archive / delete set their respective timestamps', () => {
    const { tools, repo } = setup();
    repo.create({ id: 'r1', agentId: 'A', channel: 'mail', direction: 'in', body: 'hi', threadId: 'T1', createdAt: 'ts' });
    tools.markRead({ callerAgentId: 'A' }, { id: 'r1' });
    expect(repo.get('r1')!.readAt).toBeTruthy();
    tools.archive({ callerAgentId: 'A' }, { id: 'r1' });
    expect(repo.get('r1')!.archivedAt).toBeTruthy();
    tools.delete({ callerAgentId: 'A' }, { id: 'r1' });
    expect(repo.get('r1')!.deletedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement tools**

`src/mail-mcp/tools.ts`:

```ts
import type { MessageRepo, Message } from '../db/message-repo';
import type { MailDispatcher } from '../mail-dispatcher/mail-dispatcher';
import type { EventBus } from '../bus/event-bus';
import { parseAddress } from '../mail-dispatcher/address';

export interface ToolContext { callerAgentId: string; }

export class MailMcpTools {
  constructor(private deps: {
    messageRepo: MessageRepo;
    dispatcher: MailDispatcher;
    bus: EventBus;
  }) {}

  private scopedGet(ctx: ToolContext, id: string): Message {
    const row = this.deps.messageRepo.get(id);
    if (!row || row.agentId !== ctx.callerAgentId) {
      throw new Error(`mail not found: ${id}`);
    }
    return row;
  }

  private activity(ctx: ToolContext, tool: string) {
    this.deps.bus.publish('tool.call', { agentId: ctx.callerAgentId, tool });
  }

  list(ctx: ToolContext, input: {
    unreadOnly?: boolean; threadId?: string; includeArchived?: boolean; limit?: number;
  }) {
    this.activity(ctx, 'mail.list');
    return this.deps.messageRepo.listInbox(ctx.callerAgentId, input);
  }

  get(ctx: ToolContext, input: { id: string }) {
    this.activity(ctx, 'mail.get');
    return this.scopedGet(ctx, input.id);
  }

  send(ctx: ToolContext, input: { to: string[]; cc?: string[]; subject?: string; body: string; threadId?: string; }) {
    this.activity(ctx, 'mail.send');
    return this.deps.dispatcher.sendMail({
      from: `agent:${ctx.callerAgentId}`,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId ?? null,
    });
  }

  reply(ctx: ToolContext, input: { id: string; body: string; ccAll?: boolean; }) {
    this.activity(ctx, 'mail.reply');
    const parent = this.scopedGet(ctx, input.id);
    if (!parent.from) throw new Error('cannot reply — original mail has no from');
    const cc = input.ccAll
      ? [...new Set([...(parent.to ?? []), ...(parent.cc ?? [])])].filter((a) => a !== `agent:${ctx.callerAgentId}`)
      : undefined;
    return this.deps.dispatcher.sendMail({
      from: `agent:${ctx.callerAgentId}`,
      to: [parent.from],
      cc,
      subject: parent.subject ?? undefined,
      body: input.body,
      threadId: parent.threadId ?? null,
    });
  }

  markRead(ctx: ToolContext, input: { id: string }) {
    this.activity(ctx, 'mail.mark_read');
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.markRead(row.id, new Date().toISOString());
  }

  archive(ctx: ToolContext, input: { id: string }) {
    this.activity(ctx, 'mail.archive');
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.archive(row.id, new Date().toISOString());
  }

  delete(ctx: ToolContext, input: { id: string }) {
    this.activity(ctx, 'mail.delete');
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.softDelete(row.id, new Date().toISOString());
  }
}
```

Note: the tool names in the `activity` publish must match spec — `mail.list`, `mail.get`, etc.

- [ ] **Step 3: Run tool tests — green**

```
npm test -- src/mail-mcp/tools.test.ts
```

- [ ] **Step 4: Write HTTP server tests**

`src/mail-mcp/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MailMcpServer } from './server';
// ... plus dispatcher + repo setup as in tools.test.ts ...

describe('MailMcpServer', () => {
  let server: MailMcpServer;
  beforeEach(() => {
    // server = new MailMcpServer({ tools, tokenResolver, port: 0 }); await server.start();
  });
  afterEach(() => server?.stop());

  it('rejects requests missing the MCP token header', async () => {
    // POST /mcp with no token → 401
  });

  it('rejects requests with an unknown token', async () => {
    // POST /mcp with token=bogus → 401
  });

  it('routes mail.list tool calls to the tools impl using caller-agent-id from token', async () => {
    // tokenResolver('abc123') → 'claude-assistant'
    // POST /mcp with body { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mail.list', arguments: {} } }
    // → 200 with result matching tools.list({ callerAgentId: 'claude-assistant' }, {})
  });

  it('supports tools/list discovery', async () => {
    // POST with method=tools/list → returns the 7 mail tools
  });
});
```

(The concrete HTTP assertions depend on the chosen library; fill in once the spike resolves.)

- [ ] **Step 5: Implement HTTP server**

`src/mail-mcp/server.ts`:

Minimum shape — swap to `@modelcontextprotocol/sdk`'s server if the spike found it viable. Otherwise:

```ts
import { createServer, Server } from 'node:http';
import type { MailMcpTools } from './tools';

export interface MailMcpServerDeps {
  tools: MailMcpTools;
  tokenResolver: (token: string) => string | null; // token → agentId, or null if invalid
  port: number;
  logger?: Logger;
}

const TOOL_DESCRIPTORS = [
  { name: 'mail.send', description: 'Send a new mail.', inputSchema: { /* JSON Schema */ } },
  { name: 'mail.reply', description: 'Reply to a mail.', inputSchema: { /* ... */ } },
  { name: 'mail.list', description: 'List inbox.', inputSchema: { /* ... */ } },
  { name: 'mail.get', description: 'Get a mail by id.', inputSchema: { /* ... */ } },
  { name: 'mail.mark_read', description: 'Mark mail read.', inputSchema: { /* ... */ } },
  { name: 'mail.archive', description: 'Archive a mail.', inputSchema: { /* ... */ } },
  { name: 'mail.delete', description: 'Soft-delete a mail.', inputSchema: { /* ... */ } },
];

export class MailMcpServer {
  private server?: Server;
  constructor(private deps: MailMcpServerDeps) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((ok) => this.server!.listen(this.deps.port, ok));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((ok) => this.server!.close(() => ok()));
  }

  address() { return this.server!.address() as { port: number }; }

  private async handle(req, res) {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.statusCode = 404; res.end(); return; }
    const token = (req.headers['x-teamroom-mcp-token'] as string) ?? '';
    const agentId = this.deps.tokenResolver(token);
    if (!agentId) { res.statusCode = 401; res.end('unauthorized'); return; }

    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      let rpc;
      try { rpc = JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }

      const result = this.dispatch(agentId, rpc);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  }

  private dispatch(agentId: string, rpc: any) {
    if (rpc.method === 'tools/list') return { tools: TOOL_DESCRIPTORS };
    if (rpc.method === 'tools/call') {
      const { name, arguments: args } = rpc.params;
      const ctx = { callerAgentId: agentId };
      switch (name) {
        case 'mail.list': return { content: [{ type: 'json', json: this.deps.tools.list(ctx, args) }] };
        case 'mail.get': return { content: [{ type: 'json', json: this.deps.tools.get(ctx, args) }] };
        case 'mail.send': return { content: [{ type: 'json', json: this.deps.tools.send(ctx, args) }] };
        case 'mail.reply': return { content: [{ type: 'json', json: this.deps.tools.reply(ctx, args) }] };
        case 'mail.mark_read': this.deps.tools.markRead(ctx, args); return { content: [] };
        case 'mail.archive': this.deps.tools.archive(ctx, args); return { content: [] };
        case 'mail.delete': this.deps.tools.delete(ctx, args); return { content: [] };
      }
      throw new Error(`unknown tool: ${name}`);
    }
    throw new Error(`unknown method: ${rpc.method}`);
  }
}
```

(This is a minimal MCP server. If the spike found `@modelcontextprotocol/sdk` Node-HTTP support, replace the `handle`/`dispatch` body with the SDK's server class. The tests in Step 4 care about behavior, not implementation choice.)

- [ ] **Step 6: Run all tests — green**

```
npm test -- src/mail-mcp/
```

- [ ] **Step 7: Commit**

```
git add src/mail-mcp/
git commit -m "feat(m4-t5): HTTP MCP mail server (tools + auth + token-scoped inbox)"
```

---

## Task 6 — docker-runner persistent stdin streaming

**Why:** the daemon needs to push wake envelopes to a running container throughout its session, not just once at spawn.

**Files:**
- Modify: `src/container/docker-runner.ts` — keep stdin open, expose write/close handles.
- Modify: `src/container/container-runner.ts` — expand the `ContainerRunner` interface with `writeEnvelope(env)` and `closeStdin()`.
- Modify: `src/container/fake-runner.ts` — match the new interface; tests use it.
- Test: `src/container/docker-runner.test.ts` — new tests for the streaming shape.
- Test: `src/container/fake-runner.test.ts` — new interface coverage.

### Steps

- [ ] **Step 1: Update the `ContainerRunner` interface**

In `src/container/container-runner.ts`, add:
```ts
export interface RunningContainer {
  containerId: string;
  writeEnvelope(envelope: unknown): void;   // serialize JSON + '\n', write to stdin
  closeStdin(): void;                        // close stdin → runtime reads EOF
  onEvent(handler: (event: ContainerStdoutEvent) => void): void;
  onExit(handler: (code: number) => void): void;
  kill(): Promise<void>;
}

export interface ContainerRunner {
  run(spec: DockerRunSpec): RunningContainer;
}
```

(Replace or extend the existing one-shot `run(spec): Promise<ContainerResult>` signature. The old shape still works for some callers; for M4, the orchestrator uses the streaming shape exclusively.)

- [ ] **Step 2: Implement streaming FakeRunner**

In `src/container/fake-runner.ts`, update `run` to return a `RunningContainer`:

```ts
export class FakeRunner implements ContainerRunner {
  // Each run starts the scripted agent interaction.
  run(spec: DockerRunSpec): RunningContainer {
    const stdinBuffer: unknown[] = [];
    const eventHandlers: ((e: ContainerStdoutEvent) => void)[] = [];
    const exitHandlers: ((c: number) => void)[] = [];
    // ... scripted behavior reads from stdinBuffer when the script says so ...
    return {
      containerId: 'fake-' + spec.agentName,
      writeEnvelope: (env) => { stdinBuffer.push(env); /* notify script */ },
      closeStdin: () => { /* script sees EOF */ },
      onEvent: (h) => { eventHandlers.push(h); },
      onExit: (h) => { exitHandlers.push(h); },
      kill: async () => { /* script.stop() */ },
    };
  }
}
```

Scripts for FakeRunner-based integration tests become event-driven: "when I read envelope N, emit event E via the registered handler."

- [ ] **Step 3: Implement streaming docker-runner**

In `src/container/docker-runner.ts`:

```ts
import { spawn } from 'node:child_process';

export class DockerRunner implements ContainerRunner {
  run(spec: DockerRunSpec): RunningContainer {
    const args = buildDockerArgs(spec); // existing helper — returns ['run', '--rm', '-i', ...]
    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    // stdout: parse JSON lines into ContainerStdoutEvent
    const eventHandlers: Array<(e: ContainerStdoutEvent) => void> = [];
    const exitHandlers: Array<(c: number) => void> = [];

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const event = parseEvent(line);
        for (const h of eventHandlers) h(event);
      }
    });

    proc.on('exit', (code) => { for (const h of exitHandlers) h(code ?? 0); });

    return {
      containerId: /* obtain via docker inspect if needed; for M4 use the short pid */ `docker-${proc.pid}`,
      writeEnvelope: (env) => {
        if (!proc.stdin.writable) throw new Error('stdin closed');
        proc.stdin.write(JSON.stringify(env) + '\n');
      },
      closeStdin: () => { proc.stdin.end(); },
      onEvent: (h) => { eventHandlers.push(h); },
      onExit: (h) => { exitHandlers.push(h); },
      kill: async () => {
        proc.kill('SIGTERM');
        // give docker a moment to clean up; exit handler will fire
      },
    };
  }
}
```

(Adapt against the existing `docker-command` helpers for building args. Keep the existing parseEvent logic; this task only changes transport, not parse format.)

- [ ] **Step 4: Write FakeRunner tests for the new interface**

`src/container/fake-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeRunner } from './fake-runner';

describe('FakeRunner — streaming interface', () => {
  it('queues envelopes written before the script reads them', () => {
    const runner = new FakeRunner(/* script: read envelope 1, emit reply "hi" */);
    const rc = runner.run({ /* spec */ } as any);
    const events: any[] = [];
    rc.onEvent((e) => events.push(e));
    rc.writeEnvelope({ type: 'wake', events: ['mail'] });
    // Script processes envelope, emits. Depending on FakeRunner's model,
    // we may need to await a tick / manually advance the script.
    expect(events.length).toBeGreaterThan(0);
  });

  it('exits cleanly when stdin closes', async () => {
    const runner = new FakeRunner(/* script: read until EOF, exit 0 */);
    const rc = runner.run({} as any);
    let exitCode: number | undefined;
    rc.onExit((c) => { exitCode = c; });
    rc.closeStdin();
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);
  });
});
```

Likewise for docker-runner, write a test that uses an `echo`/`cat` image (or leverages the existing docker-runner test infrastructure) to prove the streaming shape. If the existing tests mock docker, follow that pattern.

- [ ] **Step 5: Run tests — iterate until green**

```
npm test -- src/container/
```

Expect existing callers of the one-shot `run()` to break. Update them (likely `turn-processor.ts` and any tests that spawn via the runner) to use the streaming shape. If preserving backward compat matters, keep a `runOnce(spec)` convenience method that internally uses the streaming shape and closes stdin after the first envelope.

- [ ] **Step 6: Commit**

```
git add src/container/ src/daemon/turn-processor.ts
git commit -m "feat(m4-t6): persistent stdin streaming on ContainerRunner + impls"
```

---

## Task 7 — SessionTimerManager

**Files:**
- Create: `src/session-manager/session-manager.ts`
- Create: `src/session-manager/session-manager.test.ts`
- Modify: `src/daemon/daemon.ts` — instantiate, wire bus events, pass into orchestrator.

### Steps

- [ ] **Step 1: Write tests first (Clock DI'd)**

`src/session-manager/session-manager.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionTimerManager } from './session-manager';
import type { ContainerRunner, RunningContainer } from '../container/container-runner';

function makeRunningContainer(): RunningContainer {
  return {
    containerId: 'c',
    writeEnvelope: vi.fn(),
    closeStdin: vi.fn(),
    onEvent: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  };
}

function setup(idleMin = 30) {
  const containers: RunningContainer[] = [];
  const runner: ContainerRunner = {
    run: vi.fn(() => { const rc = makeRunningContainer(); containers.push(rc); return rc; }),
  };
  const clock = {
    time: 0,
    now() { return new Date(this.time).toISOString(); },
    epochMs() { return this.time; },
  };
  const timers: { fire: () => void; when: number }[] = [];
  const timerFactory = {
    schedule(ms: number, fn: () => void) {
      const when = clock.epochMs() + ms;
      const entry = { fire: fn, when };
      timers.push(entry);
      return {
        cancel: () => { const i = timers.indexOf(entry); if (i >= 0) timers.splice(i, 1); },
      };
    },
    advance(ms: number) {
      clock.time += ms;
      while (timers.length && timers[0].when <= clock.epochMs()) {
        const t = timers.shift()!;
        t.fire();
      }
    },
  };
  const mgr = new SessionTimerManager({
    runner, clock,
    idleMinutes: idleMin,
    timerFactory,
    spec: (agentId) => ({ agentName: agentId }) as any,
    genToken: () => 'token-' + Math.random(),
  });
  return { mgr, runner, containers, clock, timerFactory };
}

describe('SessionTimerManager', () => {
  it('spawns a container on first onMailDelivered + writes initial wake', () => {
    const { mgr, runner, containers } = setup();
    mgr.onMailDelivered('A');
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(containers[0].writeEnvelope).toHaveBeenCalledWith({ type: 'wake', events: ['mail'] });
  });

  it('reuses a live session on subsequent onMailDelivered — only writes wake', () => {
    const { mgr, runner, containers } = setup();
    mgr.onMailDelivered('A');
    mgr.onMailDelivered('A');
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(containers[0].writeEnvelope).toHaveBeenCalledTimes(2);
  });

  it('resets the idle timer on any agent activity', () => {
    const { mgr, containers, timerFactory } = setup(30);
    mgr.onMailDelivered('A');
    timerFactory.advance(29 * 60 * 1000);
    mgr.onAgentActivity('A'); // resets
    timerFactory.advance(29 * 60 * 1000);
    // Still alive — stdin not closed.
    expect(containers[0].closeStdin).not.toHaveBeenCalled();
    // One more minute → 30 min since last activity → timer fires.
    timerFactory.advance(1 * 60 * 1000);
    expect(containers[0].closeStdin).toHaveBeenCalled();
  });

  it('closes stdin when inactivity timer fires', () => {
    const { mgr, containers, timerFactory } = setup(30);
    mgr.onMailDelivered('A');
    timerFactory.advance(30 * 60 * 1000);
    expect(containers[0].closeStdin).toHaveBeenCalled();
  });

  it('removes session on container exit', () => {
    const { mgr, containers } = setup();
    mgr.onMailDelivered('A');
    const exitHandler = (containers[0].onExit as any).mock.calls[0][0];
    exitHandler(0);
    // Next mail should spawn fresh.
    mgr.onMailDelivered('A');
    // Re-spawn: runner.run called twice now (tracked in outer scope if needed).
    // Minimum: the session must have been removed so onMailDelivered doesn't try to writeEnvelope on the dead container.
  });

  it('tokenFor(agentId) returns the current session token, null if no session', () => {
    const { mgr } = setup();
    expect(mgr.tokenFor('A')).toBeNull();
    mgr.onMailDelivered('A');
    expect(mgr.tokenFor('A')).toMatch(/^token-/);
  });

  it('killAll terminates every live session', async () => {
    const { mgr, containers } = setup();
    mgr.onMailDelivered('A');
    mgr.onMailDelivered('B');
    await mgr.killAll();
    expect(containers[0].kill).toHaveBeenCalled();
    expect(containers[1].kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement SessionTimerManager**

`src/session-manager/session-manager.ts`:

```ts
import type { ContainerRunner, RunningContainer, DockerRunSpec } from '../container/container-runner';
import type { Clock } from '../clock/clock';

export interface TimerHandle { cancel(): void; }
export interface TimerFactory {
  schedule(ms: number, fn: () => void): TimerHandle;
}

export interface SessionTimerManagerDeps {
  runner: ContainerRunner;
  clock: Clock;
  idleMinutes: number;
  timerFactory: TimerFactory;
  spec: (agentId: string, mcpToken: string) => DockerRunSpec;
  genToken: () => string;
}

interface Session {
  agentId: string;
  rc: RunningContainer;
  timer: TimerHandle | null;
  token: string;
}

export class SessionTimerManager {
  private sessions = new Map<string, Session>();

  constructor(private deps: SessionTimerManagerDeps) {}

  onMailDelivered(agentId: string): void {
    let s = this.sessions.get(agentId);
    if (!s) {
      s = this.spawn(agentId);
      this.sessions.set(agentId, s);
    }
    s.rc.writeEnvelope({ type: 'wake', events: ['mail'] });
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

  async killAll(): Promise<void> {
    const all = [...this.sessions.values()];
    await Promise.all(all.map((s) => s.rc.kill()));
    this.sessions.clear();
  }

  private spawn(agentId: string): Session {
    const token = this.deps.genToken();
    const spec = this.deps.spec(agentId, token);
    const rc = this.deps.runner.run(spec);
    const session: Session = { agentId, rc, timer: null, token };
    rc.onExit(() => {
      session.timer?.cancel();
      this.sessions.delete(agentId);
    });
    return session;
  }

  private armTimer(s: Session): void {
    s.timer?.cancel();
    s.timer = this.deps.timerFactory.schedule(this.deps.idleMinutes * 60 * 1000, () => {
      s.rc.closeStdin();
    });
  }
}
```

- [ ] **Step 3: Run tests — green**

```
npm test -- src/session-manager/
```

- [ ] **Step 4: Add a real timerFactory in prod composition**

```ts
// src/session-manager/real-timer.ts
import type { TimerFactory } from './session-manager';
export const realTimerFactory: TimerFactory = {
  schedule: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  },
};
```

- [ ] **Step 5: Wire session manager to the bus in daemon composition**

In `src/daemon/daemon.ts`, after constructing `sessionManager`, `bus`, and `dispatcher`, subscribe the activity-tracking handlers:

```ts
// Inbound mail → wake (spawn if needed) + reset timer.
bus.subscribe('mail.delivered', (p: { to: string }) => {
  sessionManager.onMailDelivered(p.to);
});

// Agent outbound mail → reset that agent's timer.
bus.subscribe('mail.sent', (p: { from: string }) => {
  sessionManager.onAgentActivity(p.from);
});

// Every MCP tool call → reset that agent's timer.
bus.subscribe('tool.call', (p: { agentId: string; tool: string }) => {
  sessionManager.onAgentActivity(p.agentId);
});
```

Also, provide a `tokenResolver` closure to the MCP server that looks up the caller's agent id via `sessionManager.tokenFor`-inverse (the manager knows `agentId → token`; the server needs `token → agentId`). Simplest: add a `resolveToken(token): agentId | null` method to the session manager backed by a second `Map<token, agentId>` populated on spawn:

```ts
// in SessionTimerManager
private tokens = new Map<string, string>(); // token → agentId

// in spawn()
this.tokens.set(token, agentId);

// on exit handler
this.tokens.delete(token);

resolveToken(token: string): string | null {
  return this.tokens.get(token) ?? null;
}
```

(Add a unit test for `resolveToken`.)

- [ ] **Step 6: Commit**

```
git add src/session-manager/
git commit -m "feat(m4-t7): SessionTimerManager — spawn, idle timer, killAll"
```

---

## Task 8 — CLI channel adapter wiring

**Files:**
- Modify: `src/cli/send.ts` — call dispatcher instead of writing directly to messages.
- Modify: `src/cli/tail.ts` — verify it still reads CLI rows correctly (channel=cli, direction=out). Likely no change.
- Create: `src/channels/cli.ts` — thin adapter module to centralize the CLI inbound/outbound semantics (for future channels to mirror).
- Create: `src/channels/cli.test.ts`

### Steps

- [ ] **Step 1: Write CLI adapter tests**

`src/channels/cli.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { CliChannelAdapter } from './cli';

describe('CliChannelAdapter', () => {
  it('inbound send calls dispatcher with cli:<user> → [agent:<target>]', () => {
    const dispatcher = { sendMail: vi.fn().mockReturnValue({ threadId: 'T1', rowIds: [] }) };
    const adapter = new CliChannelAdapter({ dispatcher: dispatcher as any });
    adapter.send({ user: 'don', target: 'claude-assistant', body: 'hello' });
    expect(dispatcher.sendMail).toHaveBeenCalledWith({
      from: 'cli:don',
      to: ['agent:claude-assistant'],
      body: 'hello',
      threadId: null,
    });
  });
});
```

- [ ] **Step 2: Implement adapter**

`src/channels/cli.ts`:

```ts
import type { MailDispatcher } from '../mail-dispatcher/mail-dispatcher';

export interface CliChannelAdapterDeps { dispatcher: MailDispatcher; }

export class CliChannelAdapter {
  constructor(private deps: CliChannelAdapterDeps) {}
  send(input: { user: string; target: string; body: string; threadId?: string | null }) {
    return this.deps.dispatcher.sendMail({
      from: `cli:${input.user}`,
      to: [`agent:${input.target}`],
      body: input.body,
      threadId: input.threadId ?? null,
    });
  }
}
```

- [ ] **Step 3: Add a `/cli/send` HTTP endpoint to the daemon**

The CLI must go through the daemon so the event bus + session manager actually wake the recipient. In M3 the CLI wrote directly to the DB; in M4 that bypasses the bus, and the target agent would never be spawned.

In `src/mail-mcp/server.ts` (the same HTTP server we already run on the MCP port), add a second route:

```ts
// inside handle(req, res)
if (req.method === 'POST' && req.url === '/cli/send') {
  // Trust localhost only — no token needed; the daemon-owned socket is
  // the trust boundary, same as the existing NotifyBus signal.
  if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
    res.statusCode = 403; res.end('localhost only'); return;
  }
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    const { user, target, body: mailBody, threadId } = JSON.parse(body);
    const result = this.deps.cliAdapter.send({ user, target, body: mailBody, threadId });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  });
  return;
}
```

(Extend `MailMcpServerDeps` with `cliAdapter: CliChannelAdapter`.)

- [ ] **Step 4: Rewire `src/cli/send.ts` to POST the endpoint**

```ts
import { request } from 'node:http';
import os from 'node:os';

export async function runSend(opts: { target: string; body: string; port: number }) {
  const user = os.userInfo().username;
  const payload = JSON.stringify({ user, target: opts.target, body: opts.body });
  await new Promise((ok, fail) => {
    const req = request({
      host: '127.0.0.1', port: opts.port, path: '/cli/send', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = ''; res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return fail(new Error(`daemon rejected: ${res.statusCode} ${data}`));
        const result = JSON.parse(data);
        console.log(`sent; thread=${result.threadId}`);
        ok(null);
      });
    });
    req.on('error', fail);
    req.write(payload); req.end();
  });
}
```

The port comes from the daemon's status file / env var (same mechanism M2 uses to tell the CLI where `LocalModelProxy` lives). If the daemon isn't running, the CLI errors with a clear "daemon not running" message.

- [ ] **Step 5: Run — verify send works end-to-end in a unit test**

```
npm test -- src/channels/ src/cli/ src/mail-mcp/
```

- [ ] **Step 6: Commit**

```
git add src/channels/ src/cli/ src/mail-mcp/server.ts
git commit -m "feat(m4-t8): CLI channel adapter + /cli/send HTTP endpoint + CLI rewired"
```

---

## Task 9 — Runtime reshape (stdin wake loop, MCP client, remove {type:"reply"}, system prompt)

**Files:**
- Modify: `src/agent-runtime/main.ts` — wake loop over stdin.
- Modify: `src/agent-runtime/runtime.ts` — remove `{type:"reply"}` emission; no DM prefix (Task 11 cleans up remnants).
- Modify: `src/agent-runtime/anthropic-llm-client.ts` — register the mail MCP server on the Options.
- Modify: `agents/claude-assistant/AGENTS.md` (or system prompt file) — add inbox-on-wake instructions.

### Steps

- [ ] **Step 1: Write wake-loop tests**

`src/agent-runtime/runtime.test.ts` — add cases:

```ts
describe('runtime — wake loop', () => {
  it('processes multiple stdin envelopes serially', async () => {
    // stdin stream with two wake envelopes, EOF at end.
    // Expect two LLM invocations; each sees only its wake context.
  });

  it('exits cleanly on stdin EOF', async () => {
    // stdin that ends immediately.
    // Expect clean exit, no unhandled rejections.
  });

  it('does not emit {type:"reply"} for LLM text output', async () => {
    // stdin with one wake; mock LLM returns "hello".
    // Expect stdout to be empty / structured-log-only, NOT {type:"reply"}.
  });
});
```

- [ ] **Step 2: Rewrite `src/agent-runtime/main.ts` to stream stdin**

```ts
import { createInterface } from 'node:readline';
import { Runtime } from './runtime';
import { AnthropicLlmClient } from './anthropic-llm-client';
// ...

async function main() {
  const llmClient = new AnthropicLlmClient({
    mcpServers: {
      mail: {
        type: 'http',
        url: process.env.TEAMROOM_MCP_URL!, // e.g. http://host.docker.internal:8765/mcp
        headers: { 'x-teamroom-mcp-token': process.env.TEAMROOM_MCP_TOKEN! },
      },
    },
    // ... rest of existing Options ...
  });
  const runtime = new Runtime({ llmClient /* ... */ });

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const wake = JSON.parse(line);
    await runtime.processWake(wake);
  }
  // EOF → exit naturally.
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Simplify Runtime**

```ts
// src/agent-runtime/runtime.ts

export class Runtime {
  constructor(private deps: RuntimeDeps) {}

  async processWake(_wake: Wake): Promise<void> {
    // System prompt already instructs the LLM: "on wake, call mail.list,
    // read unread mail, act accordingly (mail.reply / mail.send)."
    // The wake envelope itself is minimal — just signals "check environment."
    await this.deps.llmClient.invoke({
      prompt: 'wake: check your inbox and act accordingly.',
      // No {type:"reply"} post-processing. The LLM calls mail.* via MCP.
    });
  }
}
```

Key change: **no `{type:"reply"}` stdout emission anywhere in this module.** If the LLM returns natural-language text, it's just text — logged via the existing logger, not routed. The LLM should use `mail.reply` or `mail.send` MCP tools for any communication.

- [ ] **Step 4: Update AnthropicLlmClient options**

```ts
// src/agent-runtime/anthropic-llm-client.ts
// Add to Options:
mcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;

// In the claude-agent-sdk session initialization:
// Pass `this.options.mcpServers` through to the SDK's Options.mcpServers field
// (name may vary — check the SDK's type definitions during the spike).
```

- [ ] **Step 5: Update `agents/claude-assistant/AGENTS.md` with wake-aware instructions**

Add a section explaining:
- "On wake, call `mail.list(unread_only=true)` to see new mail."
- "Use `mail.get(id)` to read full bodies."
- "Use `mail.reply(id, body)` to respond in-thread; `cc_all=true` includes the full group."
- "Use `mail.send(to=[...], body=...)` to initiate new threads."
- "Team roster: `agent:claude-assistant` (you), `agent:claude-researcher`."

- [ ] **Step 6: Run tests — green**

```
npm test -- src/agent-runtime/
```

- [ ] **Step 7: Commit**

```
git add src/agent-runtime/ agents/claude-assistant/
git commit -m "feat(m4-t9): runtime wake loop + MCP client + remove reply emission"
```

---

## Task 10 — Daemon restart: kill-all live containers on startup

**Files:**
- Modify: `src/daemon/daemon.ts` — on startup, after SessionTimerManager is constructed but before the orchestrator begins, query docker for any containers labeled `teamroom-agent` and kill them.
- Test: `src/daemon/daemon.test.ts` — add a test.

### Steps

- [ ] **Step 1: Label containers at spawn time**

In `docker-runner.ts` (or wherever `docker run` args are built), ensure `--label teamroom-agent=true --label teamroom-agent-id=<agentId>`.

- [ ] **Step 2: Add cleanup on daemon start**

In `src/daemon/daemon.ts`, near the top of `start()`:

```ts
async function killStaleContainers(): Promise<void> {
  // docker ps -q --filter label=teamroom-agent=true  → list of container ids
  // For each: docker kill <id>
  const result = await execFile('docker', ['ps', '-q', '--filter', 'label=teamroom-agent=true']);
  const ids = result.stdout.trim().split('\n').filter(Boolean);
  for (const id of ids) {
    await execFile('docker', ['kill', id]).catch(() => {/* best effort */});
  }
}
```

- [ ] **Step 3: Test**

```ts
describe('daemon startup — stale container cleanup', () => {
  it('kills previously-labeled teamroom-agent containers', async () => {
    // Mock docker ps to return ['abc', 'def'].
    // Mock docker kill; verify called twice.
  });
});
```

- [ ] **Step 4: Run and commit**

```
npm test -- src/daemon/daemon.test.ts
git add src/daemon/daemon.ts src/container/docker-runner.ts src/daemon/daemon.test.ts
git commit -m "feat(m4-t10): kill stale teamroom-agent containers on daemon startup"
```

---

## Task 11 — DM code retirement

**Files removed / modified:**
- Delete: `tests/integration/dm-round-trip.test.ts`, `tests/integration/conversation-cap.test.ts` (the M3 DM-focused integration tests — their M4 replacements are `thread-cap.test.ts` built in Task 15).
- Modify: `src/container/docker-runner.ts` — remove `{type:"dm"}` parsing.
- Modify: `src/daemon/turn-processor.ts` — remove `dm` branch in `onEvent`; remove reply-by-channel branching (the whole concept is gone; replies now come via MCP `mail.reply`, not stdout events).
- Modify: `src/agent-runtime/runtime.ts` — remove `[dm from <X>]` prompt prefix; remove `{type:"reply"}` emission (already done in Task 9, but double-check).
- Rename: `src/daemon/subscriptions.ts` → uses `MailingListSubscriptionIndex` name; the internal logic is superseded by `MailingListRegistry` from Task 4, so this file can be deleted if nothing else depends on it.
- Modify: `src/agent-config/agent-config.ts` — `subscriptions:` field values are now required to be `list:<name>` (enforced; parse-time error otherwise). The parse keeps string arrays but validates.
- Modify: `agents/claude-assistant/agent.yaml` and `agents/studio-assistant/agent.yaml` — change any M3 topic subscriptions into list subscriptions (or remove if no applicable list).
- Update: `src/db/message-repo.ts` — remove `countByConversationId` if nothing else references it (`turn-processor.ts` used it for the M3 cap). Cap is now thread-based in the dispatcher.

### Steps

- [ ] **Step 1: Grep for `dm` usages and make a kill list**

```
grep -rn '"dm"\|type: "dm"\|{type:\s*"dm"\|fromAgentId\|topic\|conversationId' src/ tests/
```

Keep: schema columns that stay (flagged for later-cleanup migration). Remove: parse paths, branches, callers that stop making sense.

- [ ] **Step 2: Remove `{type:"dm"}` from docker-runner**

Delete the dm branch from `parseEvent` (or equivalent). Update tests.

- [ ] **Step 3: Remove dm branch + reply-by-channel from turn-processor**

Delete the `dm` case in `onEvent`. Delete the channel-check on `reply` (since agents no longer emit `{type:"reply"}` at all — reply comes via MCP, not stdout).

Actually: since the agent-runtime no longer emits any stdout events for communication (Task 9), the entire `onEvent` may become much simpler — it only handles `log`, `status`, `unknown`. Trim accordingly.

- [ ] **Step 4: Remove `[dm from]` prefix from runtime**

Already removed in Task 9 as part of runtime reshape; confirm no residue.

- [ ] **Step 5: Delete `src/daemon/subscriptions.ts`**

Replaced by `MailingListRegistry` (Task 4). Check no other file imports from it; if so, repoint.

- [ ] **Step 6: Update `agent-config.ts` to enforce `list:*` in subscriptions**

```ts
// when parsing, for each subscription string, call parseAddress() and
// throw if kind !== 'list'. Matches registry validation in Task 4.
```

- [ ] **Step 7: Delete M3 DM integration tests**

```
git rm tests/integration/dm-round-trip.test.ts tests/integration/conversation-cap.test.ts
```

- [ ] **Step 8: Remove `countByConversationId` from TurnRepo and `conversation_id` cap logic from turn-processor**

The cap logic moves entirely into the dispatcher (Task 3). Turn-processor no longer needs to check conversation_id-based caps.

- [ ] **Step 9: Update agent yamls**

```yaml
# agents/claude-assistant/agent.yaml (example)
name: claude-assistant
allowed_tools: [Read, Write, Edit, Bash, Glob, Grep]
subscriptions: []   # claude-assistant doesn't subscribe to any mailing lists by default
```

```yaml
# agents/studio-assistant/agent.yaml (unchanged except subscriptions now parsed strictly)
name: studio-assistant
allowed_tools: []
subscriptions: []   # studio doesn't participate in M4 mail
```

- [ ] **Step 10: Run full suite — iterate until green**

```
npm test
npm run typecheck
```

Expect fixture drift from removed fields. Fix at each test file.

- [ ] **Step 11: Commit**

```
git add -A
git commit -m "feat(m4-t11): retire M3 DM primitive (code paths + tests + subscriptions shape)"
```

---

## Task 12 — Second Claude-family agent (`claude-researcher`)

**Files:**
- Create: `agents/claude-researcher/agent.yaml`
- Create: `agents/claude-researcher/AGENTS.md`
- Create: `agents/claude-researcher/Dockerfile` (or reference the shared base image — check what claude-assistant uses in M3; replicate).

### Steps

- [ ] **Step 1: Create agent.yaml**

```yaml
# agents/claude-researcher/agent.yaml
name: claude-researcher
provider: anthropic
model: claude-opus-4-7
allowed_tools: [Read, Write, Edit, Bash, Glob, Grep]
subscriptions:
  - list:harness-activity
```

- [ ] **Step 2: Create AGENTS.md**

Short, distinct from claude-assistant:

```markdown
# claude-researcher

You are claude-researcher, a teammate in the Team Room harness. You read deeply, reason carefully about what other agents have built or proposed, and surface patterns they might have missed.

## Your inbox
You're subscribed to `list:harness-activity` — you'll receive a mail every time a turn starts or completes across any agent. Use `mail.list(unread_only=true)` to see what's fresh.

## When another agent asks you to consult
Read the thread via `mail.list(thread_id=<id>)` then `mail.get(id)` to gather context. Reply with `mail.reply(id, body, cc_all=true)` to keep the conversation visible to the whole thread.

## Team
- `agent:claude-assistant` — the coding-focused teammate.
- `cli:*` — humans via the CLI.

## Style
Precise, concise, honest about uncertainty. Prefer grounding claims in what you've actually read over speculating.
```

- [ ] **Step 3: Dockerfile / image reuse**

If claude-assistant uses a shared base image, claude-researcher uses the same. If it has its own Dockerfile, copy + tweak for the new name.

- [ ] **Step 4: Verify the daemon picks it up**

Start the daemon in a test harness; confirm `agent-config` loader finds `agents/claude-researcher/` and `MailingListRegistry` adds it as a subscriber to `list:harness-activity`.

```
npm test -- src/agent-config/ src/mailing-lists/
```

- [ ] **Step 5: Commit**

```
git add agents/claude-researcher/
git commit -m "feat(m4-t12): claude-researcher agent (subscribed to list:harness-activity)"
```

---

## Task 13 — Integration tests: `cli-mail-round-trip` + `agent-to-agent-mail`

**Files:**
- Create: `tests/integration/cli-mail-round-trip.test.ts`
- Create: `tests/integration/agent-to-agent-mail.test.ts`

Both use FakeRunner for agent containers, a real SQLite DB, real dispatcher / MCP server (the MCP server's HTTP layer can be bypassed for integration by invoking tools directly — the HTTP layer gets its own coverage in Task 5's unit tests; here we care about cross-component flows).

### Steps

- [ ] **Step 1: Write cli-mail-round-trip**

```ts
import { describe, it, expect } from 'vitest';
import { composeIntegrationHarness } from './helpers'; // existing M3 pattern

describe('cli-mail-round-trip', () => {
  it('CLI send → agent mail.list + mail.reply → CLI tail row', async () => {
    const h = composeIntegrationHarness({
      agents: ['claude-assistant'],
      fakeRunnerScript: {
        'claude-assistant': (rc) => {
          rc.onWake(async (tools) => {
            const inbox = await tools.mailList({ unreadOnly: true });
            expect(inbox).toHaveLength(1);
            const full = await tools.mailGet({ id: inbox[0].id });
            await tools.mailReply({ id: inbox[0].id, body: `got: ${full.body}` });
          });
        },
      },
    });

    await h.cli.send({ user: 'don', target: 'claude-assistant', body: 'ping' });
    await h.waitForCliOut({ bodyMatch: /got: ping/, timeoutMs: 2000 });
    h.shutdown();
  });
});
```

(The FakeRunner API shown — `rc.onWake`, `tools.mailList`, etc. — is a scripting convenience added in this task. Keep it thin.)

- [ ] **Step 2: Write agent-to-agent-mail**

```ts
describe('agent-to-agent-mail', () => {
  it('two agents exchange mail in a shared thread, no cap errors', async () => {
    const h = composeIntegrationHarness({
      agents: ['claude-assistant', 'claude-researcher'],
      fakeRunnerScript: {
        'claude-assistant': (rc) => {
          let turn = 0;
          rc.onWake(async (tools) => {
            turn++;
            const unread = await tools.mailList({ unreadOnly: true });
            for (const m of unread) {
              if (turn === 1) {
                // first wake from CLI → consult researcher
                await tools.mailSend({
                  to: ['agent:claude-researcher'],
                  body: 'question: ' + m.body,
                  threadId: m.threadId,
                });
                await tools.mailMarkRead({ id: m.id });
              } else if (turn === 2) {
                // second wake: researcher replied
                await tools.mailReply({ id: m.id, body: 'final answer based on researcher' });
                await tools.mailMarkRead({ id: m.id });
              }
            }
          });
        },
        'claude-researcher': (rc) => {
          rc.onWake(async (tools) => {
            const unread = await tools.mailList({ unreadOnly: true });
            for (const m of unread) {
              await tools.mailReply({ id: m.id, body: 'researcher answer' });
              await tools.mailMarkRead({ id: m.id });
            }
          });
        },
      },
    });

    await h.cli.send({ user: 'don', target: 'claude-assistant', body: 'need help' });
    await h.waitForCliOut({ bodyMatch: /final answer/, timeoutMs: 5000 });
    h.shutdown();
  });
});
```

- [ ] **Step 3: Run**

```
npm test -- tests/integration/cli-mail-round-trip.test.ts tests/integration/agent-to-agent-mail.test.ts
```

- [ ] **Step 4: Commit**

```
git add tests/integration/cli-mail-round-trip.test.ts tests/integration/agent-to-agent-mail.test.ts tests/integration/helpers.ts
git commit -m "test(m4-t13): integration — cli-mail-round-trip + agent-to-agent-mail"
```

---

## Task 14 — Integration tests: `mailing-list-fanout` + `session-idle-exit`

**Files:**
- Create: `tests/integration/mailing-list-fanout.test.ts`
- Create: `tests/integration/session-idle-exit.test.ts`

### Steps

- [ ] **Step 1: `mailing-list-fanout.test.ts`**

```ts
describe('mailing-list-fanout', () => {
  it('orchestrator turn.completed → list dispatches to subscribers', async () => {
    const h = composeIntegrationHarness({
      agents: ['claude-assistant', 'claude-researcher'],
      lists: [{ name: 'harness-activity', triggers: ['turn.completed'] }],
      agentSubscriptions: {
        'claude-researcher': ['list:harness-activity'],
      },
    });

    // Emit a synthetic turn.completed via the bus (exposed on the harness for tests).
    h.bus.publish('turn.completed', { agentId: 'claude-assistant', turnId: 'T1' });
    await h.waitForMailDelivered({ to: 'claude-researcher', timeoutMs: 1000 });

    const inbox = h.messageRepo.listInbox('claude-researcher', {});
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe('system');
    expect(inbox[0].to).toContain('agent:claude-researcher');

    // claude-assistant not subscribed → no row in its inbox.
    expect(h.messageRepo.listInbox('claude-assistant', {})).toHaveLength(0);
    h.shutdown();
  });
});
```

- [ ] **Step 2: `session-idle-exit.test.ts`**

```ts
describe('session-idle-exit', () => {
  it('fires inactivity timer and closes stdin on agent-container after idleMinutes', async () => {
    const h = composeIntegrationHarness({
      agents: ['claude-assistant'],
      sessionIdleMinutes: 30,
      // Clock / timer factory DI'd to be advance-able.
    });

    await h.cli.send({ user: 'don', target: 'claude-assistant', body: 'wake me' });
    // Session is now live. Verify:
    expect(h.sessionManager.tokenFor('claude-assistant')).toBeTruthy();

    h.timerFactory.advance(30 * 60 * 1000);

    // Runtime should have received stdin EOF → exited → session cleaned up.
    await h.waitForSessionGone('claude-assistant', { timeoutMs: 100 });
    expect(h.sessionManager.tokenFor('claude-assistant')).toBeNull();
    h.shutdown();
  });
});
```

- [ ] **Step 3: Run + commit**

```
npm test -- tests/integration/mailing-list-fanout.test.ts tests/integration/session-idle-exit.test.ts
git add tests/integration/
git commit -m "test(m4-t14): integration — mailing-list-fanout + session-idle-exit"
```

---

## Task 15 — Integration tests: `thread-cap` + `daemon-restart-kills-containers`

**Files:**
- Create: `tests/integration/thread-cap.test.ts`
- Create: `tests/integration/daemon-restart-kills-containers.test.ts`

### Steps

- [ ] **Step 1: `thread-cap.test.ts`**

```ts
describe('thread-cap', () => {
  it('rejects the 11th mail in a thread with cap=10', async () => {
    const h = composeIntegrationHarness({
      agents: ['claude-assistant'],
      maxMailsPerThread: 10,
    });

    // Seed a thread manually.
    for (let i = 0; i < 10; i++) {
      h.dispatcher.sendMail({
        from: 'cli:don',
        to: ['agent:claude-assistant'],
        body: `msg ${i}`,
        threadId: 'T1',
      });
    }

    // 11th send throws.
    expect(() => h.dispatcher.sendMail({
      from: 'cli:don', to: ['agent:claude-assistant'], body: 'one more', threadId: 'T1',
    })).toThrow(/thread cap/);
    h.shutdown();
  });
});
```

- [ ] **Step 2: `daemon-restart-kills-containers.test.ts`**

```ts
describe('daemon-restart-kills-containers', () => {
  it('kills live teamroom-agent containers on daemon startup', async () => {
    // Mock docker ps to return ['stale-1', 'stale-2'].
    const killed: string[] = [];
    const fakeExec = vi.fn(async (cmd, args) => {
      if (args[0] === 'ps') return { stdout: 'stale-1\nstale-2\n' };
      if (args[0] === 'kill') { killed.push(args[1]); return { stdout: '' }; }
      return { stdout: '' };
    });
    const h = composeIntegrationHarness({ dockerExec: fakeExec });
    await h.start();
    expect(killed.sort()).toEqual(['stale-1', 'stale-2']);
    h.shutdown();
  });
});
```

- [ ] **Step 3: Run + commit**

```
npm test -- tests/integration/thread-cap.test.ts tests/integration/daemon-restart-kills-containers.test.ts
git add tests/integration/
git commit -m "test(m4-t15): integration — thread-cap + daemon-restart-kills-containers"
```

---

## Task 16 — Smoke test update (M4 scenario)

**Files:**
- Modify: `scripts/smoke-test.sh` — replace the M3 DM primitive check with an M4 multi-agent check.

### Steps

- [ ] **Step 1: Update `scripts/smoke-test.sh`**

After the existing M2-era per-provider checks (single-turn, multi-turn codeword), add:

```bash
run_m4_agent_mail_check() {
  echo "--- M4: CLI → claude-assistant → claude-researcher → reply → CLI ---"
  teamroom serve &
  local DAEMON_PID=$!
  trap "kill $DAEMON_PID 2>/dev/null || true" RETURN

  sleep 2 # daemon warmup

  teamroom send claude-assistant "please ask claude-researcher about the current time and summarize the response"

  # tail for up to 60 seconds, watching for a final CLI output containing "researcher".
  local OUTPUT=$(timeout 60 teamroom tail | grep -m1 -i 'researcher')
  if [ -z "$OUTPUT" ]; then
    echo "FAIL: did not see researcher's contribution on the CLI tail"
    return 1
  fi
  echo "PASS: $OUTPUT"
}

run_m4_agent_mail_check
```

- [ ] **Step 2: Run smoke test locally**

```
./scripts/smoke-test.sh
```

Expect PASS with real Anthropic backend + live claude-assistant + live claude-researcher.

- [ ] **Step 3: Commit**

```
git add scripts/smoke-test.sh
git commit -m "test(m4-t16): smoke test — multi-agent mail scenario"
```

---

## Task 17 — Final verification

- [ ] **Step 1: Full test suite**

```
npm test
```

Expected: all green. No skips. If anything fails, investigate — do not move on.

- [ ] **Step 2: Typecheck (both configs)**

```
npm run typecheck
```

Expected: clean. This catches fixture drift, especially on the `Message` type's new fields.

- [ ] **Step 3: Smoke against real backends**

```
./scripts/smoke-test.sh
```

Expected: all provider checks + the M4 agent-mail check pass.

- [ ] **Step 4: Tree clean, no uncommitted work**

```
git status
```

Expected: clean.

- [ ] **Step 5: Final commit (if anything drifted)**

```
git add -A
git commit -m "fix(m4-t17): final verification — fixtures + typecheck drift"
```

---

## Post-plan — close-out work (do AFTER the plan merges; not a task)

1. Write the M4 retrospective per `writing-retros` skill → `docs/retros/YYYY-MM-DD-m4.md`.
2. Memory pass per `capturing-learnings` skill.
3. Write the M4 as-built per `writing-as-built` skill → `docs/as-built/YYYY-MM-DD-teamroom-m4.md`. Purge `docs/specs/2026-04-20-m4-agent-mail-design.md` and this plan after it.
4. Update `docs/roadmap.md`: M4 → Shipped; mark M5 memory as Next.
5. Close out `docs/m3-followups.md` entries §4 (CLI as Channel) and §6 (email on event bus) in the M4 as-built's "carryover resolution" section.
6. Move any M4 execution-time deferrals into `docs/m4-followups.md`.

---

## Source documents

- [`docs/specs/2026-04-20-m4-agent-mail-design.md`](../specs/2026-04-20-m4-agent-mail-design.md) — the spec.
- [`docs/m4-followups.md`](../m4-followups.md) — deferred items (accumulates during execution).
- [`docs/m3-followups.md`](../m3-followups.md) — §6 is the forward thesis this plan implements.
- [`docs/retros/2026-04-19-m3.md`](../retros/2026-04-19-m3.md) — lessons driving this plan (full-chain spike, bundling discipline, real-backend smoke test).
- [`docs/as-built/2026-04-20-teamroom-m3.md`](../as-built/2026-04-20-teamroom-m3.md) — baseline this plan builds on.
