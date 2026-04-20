# M4 — Agent Mail (design spec)

*Date: 2026-04-20. Input to the writing-plans skill. Freezes at spec approval; amendments during M4 execution happen inline per our ways-of-working.*

---

## 0. What M4 is

Email on an event-bus backbone — the forward thesis captured in [`docs/m3-followups.md §6`](../m3-followups.md). Replaces M3's DM primitive with a richer, more honest substrate for multi-agent communication. Closes the agent-runtime-wrapping gap that M3's smoke test exposed: agents acquire a `mail.*` MCP tool family, so their natural-language output and their message-passing are two distinct channels — no more parsing JSON out of reply text.

**Architectural unlocks:** durable per-agent inboxes; mailing lists as fan-out primitives; channels as generic event emitters; container lifetime decoupled from per-message ephemerality.

---

## 1. Scope

### In scope
1. **Mail primitive.** `mail.send / reply / list / get / mark_read / archive / delete` exposed via MCP.
2. **Event bus backbone.** In-process, ephemeral, typed publish/subscribe for non-durable signals. No plugin layer; no durability; no delivery guarantees.
3. **Channels as event emitters.** CLI is a channel adapter inline in the daemon. CLI input → event → email; agent reply to `cli:*` → plain CLI outbound row (no email row on the non-inbox side).
4. **Mailing lists with event triggers.** Explicit list registry; mailing lists can declare event triggers for auto-fanout.
5. **Container lifetime rework.** Runtime becomes a wake-driven loop; daemon owns per-agent session + 30-minute inactivity timer.
6. **DM code retirement.** M3's DM stdout verb, subscription-by-topic index, and channel-specific reply routing are deleted.
7. **Second Claude-family agent** (`claude-researcher` or similar) — demonstrates live agent-to-agent mail at milestone close.

### Out of scope
See [`docs/m4-followups.md`](../m4-followups.md) for deferred items + triggers.

### Explicit narrowings (stated for clarity)
- Studio-assistant does **not** participate in M4 mail (no MCP; deferred to M5 memory milestone).
- Only one mailing list seeded (`list:harness-activity`); not a full taxonomy.
- One channel adapter (CLI); no plugin registry.
- Threading is shallow (`thread_id` only; no `in_reply_to`).
- Comprehensive end-to-end tests explicitly de-emphasized — evals (M7) are the right mechanism.

---

## 2. Architecture

### Process topology — unchanged from M3

Three tiers, **no new long-running processes**:

- **CLI** (host, short-lived): `send`, `tail`, `serve`, `status`. Extended: `send` now invokes the mail dispatcher.
- **Daemon** (host, long-lived): adds MCP mail server, event bus, mail dispatcher, session/timer manager, CLI channel adapter, mailing-list registry.
- **Agent container** (Docker): runtime reshaped into a wake-driven loop; MCP mail tools available to the LLM via the `claude-agent-sdk` MCP client.

### MCP transport

Daemon listens on `localhost:<mcp-port>/mcp` (sibling port to the existing `LocalModelProxy`). Containers reach it via `host.docker.internal:<mcp-port>/mcp`. HTTP transport. Matches the M2 proxy pattern — same trust boundary, same plumbing.

**Authentication:** per-spawn token. Daemon issues a fresh token when registering a session, maps token → agent id, passes it via `TEAMROOM_MCP_TOKEN` env var into the container. The claude-agent-sdk attaches it to MCP requests. Inbox ops scoped to the caller's agent id.

### Container lifecycle (new)

Daemon owns container lifetime:

- `sessions: Map<agentId, ContainerSession>` where `ContainerSession = { containerId, stdinStream, lastActivity, timerHandle }`.
- Default idle = 30 min (`TEAMROOM_SESSION_IDLE_MINUTES=30`; `0` disables and falls back to single-turn containers for debugging).
- **Spawn rule.** Mail delivered for an agent with no live session → orchestrator spawns a container, registers a session, writes the initial wake to stdin.
- **Reset rule.** Bus events carrying the agent id (`mail.delivered`, `mail.sent`, `tool.call`) → reset `lastActivity`, re-arm timer.
- **Exit rule.** Timer fires → daemon closes `stdinStream` → runtime reads EOF, finishes any in-flight turn, exits cleanly → daemon removes session.
- **Daemon restart.** Kill-all live containers on startup; new mail respawns on demand (NanoClaw precedent).

### Runtime reshape

**Old:** read one stdin envelope → run one LLM turn → exit.
**New:** read stdin as a stream of wake envelopes; each wake → one LLM turn; EOF → exit.

The M3 `{type:"reply"}` stdout event is **removed**. Agents communicate exclusively through `mail.*` MCP calls. Natural-language text that the LLM emits is not routed anywhere; it's just model output the MCP client observes.

**Wake envelope shape** (same for the spawn-time initial wake and subsequent wakes):

```json
{ "type": "wake", "events": ["mail"] }
```

`events` is informational — the agent's system prompt tells it to check its environment (inbox, etc.) on wake. The harness doesn't encode meaning beyond "something changed." Future subscription types add event hints without changing the envelope shape.

### Turn concept — narrowed

**Turn = one LLM invocation.** Completes when the LLM's response sequence ends (tool-call sequence + optional natural-language reply). **Reply is not required.** The turn processor must never block or fail on "no reply emitted." Container lifetime spans multiple turns until the inactivity timer fires.

### DM retirement (concrete list for the plan)

Removes:
- `src/container/docker-runner.ts` — `{type:"dm"}` parse path.
- `src/daemon/turn-processor.ts` — `dm` branch in `onEvent`, reply-by-channel branching.
- `src/agent-runtime/runtime.ts` — `{type:"reply"}` emission; `[dm from <X>]\n\n` prompt-prefix (superseded by wake semantics).
- `src/daemon/subscriptions.ts` — `AgentSubscriptionIndex` (DM-topic-based) → replaced by `MailingListSubscriptionIndex` (same shape, renamed).
- M3 DM integration tests (`tests/integration/dm-round-trip.test.ts`) — deleted.
- `agent.yaml` `subscriptions:` field — values now restricted to `list:<name>` entries.

Schema columns that **deprecate** (not dropped in M4; drop in a later cleanup migration):
- `topic`, `from_agent_id`, `conversation_id` — absorbed by `to`, `from`, `thread_id`.
- `channel` stays — distinguishes CLI outbound rows from email rows.

---

## 3. Schema

Migration `003_m4_agent_mail.sql`. Forward-only. Additive.

### Additions to `messages`

| column | type | notes |
|---|---|---|
| `to` | TEXT NOT NULL DEFAULT `'[]'` | JSON array of prefixed addresses |
| `from` | TEXT | sender address (prefixed form) |
| `cc` | TEXT | JSON array, nullable |
| `subject` | TEXT | nullable |
| `thread_id` | TEXT | nullable; minted on fresh send, inherited on reply |
| `read_at` | TIMESTAMP | nullable; set when agent marks read via MCP |
| `archived_at` | TIMESTAMP | nullable |
| `deleted_at` | TIMESTAMP | nullable (soft delete) |

### New indexes

- `idx_messages_inbox ON messages(agent_id, read_at) WHERE archived_at IS NULL AND deleted_at IS NULL` — fast inbox listing per agent.
- `idx_messages_thread ON messages(thread_id)` — thread view.

### Address format

Recipients are prefixed strings:

- `agent:<name>` — agent's inbox. Mail to this form creates an email row in `<name>`'s inbox.
- `cli:<user>` — CLI channel. No inbox; mail to this form creates a plain CLI outbound row (`channel=cli, direction=out`) for `teamroom tail` to render.
- `list:<name>` — mailing list. Dispatcher expands via subscription index to agent subscribers.

### Thread cap

`TEAMROOM_MAX_MAILS_PER_THREAD` (default `10`). Enforced at dispatcher entry: count non-deleted rows where `thread_id=T`; reject at cap with a distinct error. `0` disables. Replaces M3's `TEAMROOM_MAX_TURNS_PER_CONVERSATION` (removed as part of DM retirement).

---

## 4. Components

### 4.1 Mail MCP server (`src/mail-mcp/`)

HTTP MCP server hosted by the daemon on a separate port. Tools:

- `mail.send(to[], cc[]?, subject?, body, thread_id?) → {id, thread_id}`
- `mail.reply(id, body, cc_all?) → {id}` — inherits `thread_id`; sets `to = [original.from]`. If `cc_all` is `true`, the reply's `cc` is populated from the original's `to ∪ cc` minus the replier's own address; default `false`.
- `mail.list(unread_only?, thread_id?, include_archived?, limit?) → summaries`
- `mail.get(id) → {full row}`
- `mail.mark_read(id)`
- `mail.archive(id)`
- `mail.delete(id)` (soft)

**Non-MCP sibling endpoint removed** — the runtime does *not* call a `/runtime/wait-for-mail` endpoint. Lifecycle is daemon-driven via stdin streaming; the runtime has no idle endpoint.

Caller identity resolved from MCP token → agent id. Inbox ops scoped to the caller. **Every** MCP call (read or write) publishes `tool.call{agentId, tool}` on the bus — reads count as activity so an LLM turn that's still inspecting the inbox keeps the session's idle timer fresh.

### 4.2 Mail dispatcher (`src/mail-dispatcher/`)

Internal; not MCP-exposed. API:

```
sendMail(from, to[], cc[]?, subject?, body, thread_id?) → { id, thread_id }
```

**Multi-recipient semantics.** Before any row is written, the dispatcher **expands** every `list:<name>` occurrence in `to` and `cc` to its subscriber agent addresses. The expansion snapshots list membership at send time — subsequent membership changes don't retroactively touch already-dispatched mail.

After expansion, `to` and `cc` contain only `agent:<name>` and `cli:<user>` addresses (no `list:*`). The dispatcher then writes rows per recipient. **All rows share identical `to`, `from`, `cc`, `subject`, `body`, `thread_id`** — only `agent_id` and row-specific state (`read_at`, `archived_at`, etc.) differ. This preserves group-discussion semantics: any recipient can `mail.reply(..., cc_all=true)` and reach the whole group, with the shared `thread_id` binding all responses into one thread visible to every participant.

Per recipient (after expansion):
- `agent:<name>` → insert email row (`agent_id=<name>, direction=in, from=<from>, to=<expanded to[]>, cc=<expanded cc>, subject, body, thread_id`) → publish `mail.delivered{to: <name>}`.
- `cli:<user>` → insert plain CLI outbound row (`channel=cli, direction=out, body, thread_id`); publish `channel.cli.out{user}`. Note: the CLI tail renders body only — the full envelope isn't shown to the human.

Validation: unknown agent / unknown list → atomic reject of the entire send. Thread cap enforcement (counts rows — a multi-recipient dispatch counts N toward the cap). Thread_id minting when absent. A list that expands to zero subscribers is not an error; it just produces no rows for that slot.

### 4.3 Event bus (`src/bus/`)

In-process, typed publish/subscribe. API:

```ts
bus.publish(type, payload)
bus.subscribe(type, handler) → unsubscribe()
```

No durability, no delivery guarantees. Crashes drop in-flight events. Per the agreed scope — DB-for-durability (mail), bus-for-notification (everything else).

**Seed event types:**
- `mail.delivered{to: agentId}`
- `mail.sent{from: agentId}`
- `tool.call{agentId, tool}`
- `channel.cli.in{user, body, target}`
- `channel.cli.out{user, body, thread_id}`
- `session.spawned{agentId, containerId}`
- `session.idle_exit{agentId}`
- `turn.started{agentId, turnId}` (orchestrator)
- `turn.completed{agentId, turnId}` (orchestrator)

### 4.4 Mailing-list registry + trigger listener (`src/mailing-lists/`)

Loads `lists.yaml` at daemon boot:

```yaml
lists:
  - name: harness-activity
    triggers: [turn.started, turn.completed]
```

Subscribers resolved via each `agent.yaml`'s `subscriptions: [list:<name>, ...]`. Reverse index (`list → agentId[]`) built at boot; same mechanism as M3's `AgentSubscriptionIndex`, renamed `MailingListSubscriptionIndex`.

Trigger listener subscribes to every referenced trigger event on the bus; on fire, calls `dispatcher.sendMail({ from: 'system', to: [list:<name>], body: <event-derived>, thread_id: null })`. Dispatcher handles expansion.

### 4.5 Session + timer manager (`src/session-manager/`)

Owns container lifecycle. State: `Map<agentId, ContainerSession>`.

Actions:
- `onMailDelivered(agentId)` → if no session: spawn container + register session + initial wake; else: write wake to stdin + reset timer.
- `onAgentActivity(agentId)` → reset timer (bus listener for `mail.sent`, `tool.call`).
- Timer fire → close `stdinStream` → session removed on container exit.

### 4.6 CLI channel adapter (`src/channels/cli.ts`)

Inline module. Two surfaces:
- **Inbound.** `teamroom send <target> <body>` → `dispatcher.sendMail(from: cli:<user>, to: [agent:<target>], body)`.
- **Outbound.** Dispatcher already writes the CLI row when it sees a `cli:*` recipient. `teamroom tail` renders `channel=cli, direction=out` rows as today.

No plugin registry in M4. The pattern is intentional so Telegram/Slack/etc. can slot in identically when the second channel arrives.

### 4.7 Runtime (container side) (`src/agent-runtime/`)

Wake-driven loop:

```ts
for await (const wake of readWakesFromStdin()) {
  await runLlmTurn(wake);  // LLM uses MCP tools; no auto-reply-from-text
}
// stdin closed → exit cleanly
```

MCP client configured via `claude-agent-sdk` options pointing at `http://host.docker.internal:<mcp-port>/mcp` with `TEAMROOM_MCP_TOKEN` header. System prompt tells the LLM to check inbox on wake.

### 4.8 Component boundaries

- **Email-row writes:** mail dispatcher only.
- **CLI-row writes:** mail dispatcher (for outbound `cli:*` recipients). Inbound CLI rows go through dispatcher too. One writer per row type.
- **Container lifecycle:** session/timer manager exclusively. Orchestrator requests spawn; doesn't hold handles.
- **LLM invocations:** runtime exclusively. Daemon never talks to an LLM.

---

## 5. Data flow walkthroughs

### 5.1 CLI user → agent → reply (happy path)

1. Human: `teamroom send claude-assistant "do X"`.
2. CLI → `dispatcher.sendMail(from: cli:don, to: [agent:claude-assistant], body: "do X")`.
3. Dispatcher mints `thread_id=T1`; inserts email row in claude-assistant's inbox; publishes `mail.delivered{to:claude-assistant}`.
4. Session manager: no live session → spawn container, register session, write initial wake `{events:["mail"]}` to stdin.
5. Runtime reads wake → LLM turn → `mail.list` → `mail.get(<id>)` → `mail.reply(<id>, body:"did X")`.
6. Dispatcher: `cli:don` recipient → skip email row; insert CLI outbound row; publish `channel.cli.out{user:don}`.
7. `teamroom tail` renders the CLI row.
8. 30 min idle → timer fires → daemon closes stdin → runtime reads EOF, exits → session removed.

### 5.2 Agent-to-agent conversation

1. Steps 1–4 as above (claude-assistant spawned, reads mail).
2. LLM calls `mail.send(to:[agent:claude-researcher], thread_id:T1, body:...)`.
3. Dispatcher inserts row in researcher's inbox; publishes `mail.delivered{to:claude-researcher}`.
4. Session manager: no live researcher session → spawn, register, initial wake.
5. Researcher reads → `mail.reply(..., thread_id:T1)`.
6. Dispatcher inserts row in claude-assistant's inbox; publishes `mail.delivered`.
7. claude-assistant's session still live (timer reset on its earlier send, reset again on inbound delivery). Daemon writes another wake envelope to its stdin.
8. Next stdin read → new LLM turn → reads researcher's reply → `mail.reply` to original CLI thread → CLI row rendered.
9. Both sessions idle 30 min → both exit.

### 5.3 Mailing-list fanout (system event)

1. Orchestrator publishes `turn.completed{agentId, turnId}` on bus.
2. List-trigger listener: `turn.completed` is a trigger for `list:harness-activity`.
3. `dispatcher.sendMail(from:"system", to:[list:harness-activity], body:"turn X completed", thread_id:null)`.
4. Dispatcher expands `list:harness-activity` → `[agent:claude-researcher]`. (If the list had multiple subscribers, all would appear in every delivered row's `to`.)
5. Inserts one email row per subscriber; **each row's `to` carries the full expanded subscriber set**. Publishes `mail.delivered` per row.
6. Session manager wakes each subscriber (spawn if needed, else push wake to existing stdin).
7. Any subscriber can `mail.reply(..., cc_all=true)` — the reply preserves `thread_id`, fans out to the whole group, and every participant sees the whole conversation in their inbox under one thread. Slack-style group discussion; each participant can also archive or mute their own copy without affecting others.

### 5.4 Idle timeout

1. Session spawned at t=0; timer armed at `t + 30min`.
2. Any bus event carrying this agent id → push timer to `now + 30min`.
3. 30 min of no such event → timer fires.
4. Daemon closes `session.stdinStream`.
5. Runtime's stdin read returns EOF → finishes any in-flight turn → exits.
6. Container exits; daemon removes session from the map.
7. Future mail for this agent → fresh spawn.

---

## 6. Error handling and edge cases

### MCP tool errors
- Invalid recipient on `send`/`reply`: dispatcher validates upfront; atomic reject; MCP returns error; nothing persisted.
- Missing message id on `reply`/`get`/`mark_read`/`archive`/`delete`: MCP error.
- Cross-agent inbox access: MCP scopes by caller id; returns error.
- Missing/invalid MCP token: HTTP-layer reject.

### Multi-recipient atomicity
Atomic. Any invalid recipient → whole send fails. A valid list recipient with zero subscribers **succeeds silently** (empty fanout is not an error).

### Self-mail
Allowed. Creates a row in agent's own inbox. Next wake processes. Useful for deferred self-notes.

### Thread cap
Enforced at dispatcher entry. Exceeded → reject with a distinct error. Agent sees the error via MCP and can archive/summarize to free headroom, or start a fresh thread.

### Runtime crash mid-turn
Container exits non-zero → session manager detects → cleans up session → reconcile marks the in-flight turn errored. Mail already persisted (dispatcher writes before publishing `mail.delivered`) → never lost. Next wake / spawn reads unread mail.

### Daemon restart
Kill-all live containers on startup (NanoClaw precedent). Session map starts empty; new mail respawns on demand. Mid-turn LLM state is lost; mail-row persistence protects actual content.

### Concurrent wakes mid-turn
Daemon writes wake N+1 to stdin while runtime is mid-turn. Runtime's stdin reader queues it. After current turn, runtime loops and processes the next. Multiple queued wakes are fine — `mail.list` returns all unread in one shot, so the LLM sees everything regardless of wake count.

### Bus event loss
Bus is ephemeral; crashes drop events. Acceptable: mail persistence is in the DB, not on the bus. A dropped wake notification is recovered by the next mail delivery → fresh wake.

### Orphaned session (container died unnoticed)
Periodic reconcile pass polls container status; mismatched state → clean up session. Reuses M3 reconcile infrastructure.

---

## 7. Testing strategy

Strong unit + targeted integration; minimal E2E (evals in M7 serve the broader need).

### Unit (co-located `*.test.ts`)
- `MessageRepo`: email column round-trips, thread_id, soft delete, index usage.
- `MailDispatcher`: recipient validation, atomic reject, list expansion, thread_id minting, thread-cap enforcement.
- `MailMcpServer`: tool surface per agent token; caller scoping; auth failures.
- `SessionTimerManager`: spawn/kill, timer reset on bus events, stdin write.
- `MailingListRegistry`: `lists.yaml` parsing; trigger listener; reverse-index build from agent yamls.
- `CliChannelAdapter`: inbound → dispatcher; outbound CLI-row emission.
- `Bus`: typed publish/subscribe semantics.
- `Runtime`: wake loop; clean EOF exit.

### Integration (FakeRunner-based, DI everything)
- `cli-mail-round-trip` — CLI send → mail in claude-assistant's inbox → reply → CLI outbound row visible.
- `agent-to-agent-mail` — two FakeRunner agents exchange mail; thread grows; no cap errors.
- `mailing-list-fanout` — `turn.completed` → list-trigger listener → dispatcher → subscribers' inboxes.
- `session-idle-exit` — spawn session; advance DI'd `Clock` past 30 min; verify stdin close + clean exit; session removed.
- `thread-cap` — send 10 mails in a thread; 11th rejected.
- `daemon-restart-kills-containers` — spawn session → restart daemon → live container killed.

### E2E / smoke (one scenario at milestone close)
**One live end-to-end smoke:** real Anthropic backend, two live Claude-family agents. CLI → claude-assistant → claude-researcher → reply → CLI renders final answer. Matches the M3 retro's "real-backend smoke at milestone exit" discipline that caught the runtime-wrapping gap.

Keep M2-era per-provider smoke checks (single-turn, multi-turn codeword) for regression.

**Explicitly not in scope:** comprehensive E2E for every feature combination. Evals (M7) serve that need.

### Test infrastructure carries over
- **Clock DI** for timer tests (M2 pattern).
- **Bus DI'd** via constructor.
- **FakeRunner** extended for scripted mail exchanges.
- **`tsconfig.test.json`** continues catching fixture drift.

---

## 8. Execution notes for the plan

- **Full-chain feasibility spike first.** Verify both runtime-side (claude-agent-sdk MCP client config; existing docker runner's ability to stream stdin) and daemon-side (MCP HTTP server library choice; session manager's interaction with orchestrator) before committing the plan. M3 retro promoted this pattern — use the sharper version here.
- **DM retirement is a discrete task** in the plan, not bundled with new-feature tasks. Keeps the tree in a known state between "new code lands" and "old code goes."
- **Migration is additive only.** Schema-column drops defer to a later cleanup migration after the new shape settles.
- **M3 carryover closures:**
  - `m3-followups §4` (CLI as Channel) — **closes** with M4.
  - `m3-followups §6` (email on event bus) — **closes** with M4.
  - `m3-followups §3` (tool-call telemetry as child spans) — partially addressable; MCP tool calls are natural spans. Consider incorporating into the bus event shape (`tool.call` carries `agentId, tool, traceId?, parentSpanId?`).

---

## 9. Source documents

- [`docs/m3-followups.md §6`](../m3-followups.md) — forward thesis (the M4 direction).
- [`docs/retros/2026-04-19-m3.md`](../retros/2026-04-19-m3.md) — pivotal lessons.
- [`docs/as-built/2026-04-20-teamroom-m3.md`](../as-built/2026-04-20-teamroom-m3.md) — starting point.
- [`docs/memory/MEMORY.md`](../memory/MEMORY.md) — bias layer; particularly `feedback_teamroom_flexibility_on_discovery` and `feedback_teamroom_minimize_process_deps`.

---

## Appendix — Glossary

- **Wake.** Stdin envelope `{type:"wake", events:[...]}` delivered from daemon to running agent container. Signals "something changed; check your environment." Not mail-specific.
- **Session.** Daemon-side record of a live agent container: `{ containerId, stdinStream, lastActivity, timerHandle }`.
- **Thread.** Grouping of related mails; propagated via `thread_id`. Shallow — no reply chains or forks.
- **List.** Named mailing list (`list:<name>`). Defined in `lists.yaml`; subscribers declared in agent.yamls.
- **Channel.** Non-mail delivery surface (CLI today; Telegram/Slack/etc. future). Adapter in daemon translates between channel-native and mail primitives.
- **Dispatcher.** Internal daemon module that performs validated mail sends, per-recipient routing, and bus event emission.
- **Turn.** One LLM invocation within a session. Completes when the LLM's response sequence ends; reply is optional.
