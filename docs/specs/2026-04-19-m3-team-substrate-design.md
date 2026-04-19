# Team Room M3 — Team Substrate Design

*Design committed 2026-04-19. Supersedes applicable sections of `team-room-context.md §7`. Purged into the M3 as-built at milestone close per [`docs/ways-of-working.md`](../ways-of-working.md).*

---

## §0 Context

M2 shipped the model abstraction layer: two agents (`studio-assistant`, `claude-assistant`) running against two backends (LM Studio, Anthropic via OAuth) through a single in-daemon credential proxy. See [`docs/as-built/2026-04-19-teamroom-m2.md`](../as-built/2026-04-19-teamroom-m2.md).

The M2 retro teed up M3 as "team substrate." The original pitch in `team-room-context.md §7` scoped five pillars (event store, inter-agent messaging, shared filesystem, permission model, observability slice). During brainstorming, the scope converged down to **three** pillars that together prove the team metaphor without over-building: **inter-agent DM**, **shared codebase**, and **claude-assistant filesystem capability**. Every other pillar (including the aspirational event-bus backbone and the permission model) is explicitly deferred with a real trigger.

The thesis of this milestone is narrow: **two agents can message each other by name, they share a codebase folder, and one of them has filesystem tools.** That's enough to exercise the team-metaphor primitives that matter. Everything richer (pub/sub fan-out, per-subscription wake flags, channel abstraction formalism, observability deep-dive, event sourcing, worktrees, voice/Telegram) earns its place only when a concrete use case demands it.

**Feasibility spike (pre-commit)**: before committing this spec, the author read `daemon/orchestrator.ts`, `daemon/turn-processor.ts`, `db/message-repo.ts`, and `cli/send.ts` to confirm M2's routing shape. Findings are incorporated: orchestrator dispatch is already by `message.agent_id`; subscription resolution happens at **DM-send time** inside `turn-processor`'s existing `onEvent` handler, not at dispatch time. The claim that "M1/M2 integration pattern is unchanged" holds strongly — M3's additions are local to one event-handler branch plus a schema migration.

## §1 Scope

**In:**

- **Inter-agent DM mechanism.** Agent stdout protocol gains `{type: "dm", to: "<agent-name>", body}`. `messages` table gains `topic`, `from_agent_id`, `conversation_id`.
- **Static subscriptions in `agent.yaml`.** Named-string topics, DM-channel only, all subscriptions wake (no `wake: false` flag), no pattern matching.
- **Daemon DM routing.** Subscription lookup at DM-send time inside `turn-processor.onEvent`; one inbound row per matched subscriber.
- **Reply routing for DM context.** An agent's `{type: "reply"}` becomes a return DM when the triggering message was a DM. CLI-triggered replies continue to work unchanged.
- **Self-DM rejection.** Rejected at the source in the stdout-event handler; warn logged; no row written.
- **Conversation cap.** `count(turns WHERE conversation_id = ?) >= N` refuses further dispatch. Default `N = 10`; configurable via `TEAMROOM_MAX_TURNS_PER_CONVERSATION`.
- **Conversation_id propagation.** Fresh per CLI inbound; inherited through DM chains.
- **Shared `/codebase` mount.** Configurable host path (default: `<worktree-root>/codebase`) mounted read-write into every agent container at `/codebase`. `TEAMROOM_CODEBASE_PATH` env var for override.
- **Claude-assistant filesystem tools.** `allowedTools` set to `[Read, Write, Edit, Bash, Glob, Grep]` — the `claude-agent-sdk` built-in set.

**Out (deferred; each with a real trigger, tracked in `docs/m3-followups.md` at milestone close):**

| Deferred item | Trigger that unfreezes it |
|---|---|
| Event bus as architectural backbone | Harness events need agent-side consumption. |
| `wake: true \| false` flag | A topic becomes noisy enough that waking per match is painful. |
| Channel abstraction as a formal interface | A third external channel arrives (Telegram, voice). |
| Topic globs / pub-sub fan-out | Pattern subscriptions become useful. |
| Permission model (topic ACLs, region-level fs perms) | Lockdown becomes real. |
| DB retention / two-tier persistence | DB size starts mattering. |
| Voice (STT / TTS) channels, Telegram | Those adapters are concretely wanted. |
| Studio-assistant LangGraph refit | M4 — the main event there, not a side quest here. |
| Agent-facing `publish` / `post` verb | An agent concretely fires domain events. |
| Worktrees per agent | Two agents need to edit the same files. |
| Runtime subscription modification | Currently tabled in `docs/tabled.md`; graduates if M3 teaches us it's needed. |
| Full event sourcing | Indefinite; likely never, or a much later milestone. |

## §2 Architecture

The M1/M2 integration pattern is **unchanged**. The `messages` table remains the single integration point. The daemon's existing `orchestrator.tickOnce()` polls `messageRepo.findPendingInbound()` and dispatches each to `processTurn` by `message.agent_id`. M3 adds three things, all local:

### 2.1 Schema migration

Add to `messages`:
- `topic` TEXT NOT NULL DEFAULT `''`
- `from_agent_id` TEXT NULL
- `conversation_id` TEXT NULL

Add to `turns`:
- `conversation_id` TEXT NULL

Existing M2 rows backfill to: `topic = ''`, `from_agent_id = NULL`, `conversation_id = NULL`. NULL conversation_id means "pre-M3 row" and is ignored by the cap check.

### 2.2 Subscription index

New module `src/daemon/subscriptions.ts`. At daemon boot, reads every `agents/*/agent.yaml`, collects each agent's `subscriptions:` list, and builds an in-memory `Map<string, Set<string>>` keyed by `${channel}:${topic}`. For M3, every key is prefix `dm:`. Exposes `lookup(channel, topic) → agentId[]`.

Rebuild requires daemon restart. No hot-reload in M3.

### 2.3 DM send-time subscription resolution

Inside `turn-processor.ts`'s existing `onEvent` handler, add a new branch for `{type: "dm", to, body}`:

1. **Self-DM rejection.** If `to === <current agent>`, log `self-dm.rejected` at warn with `{from, to}` and return. No row written.
2. **Subscription lookup.** `subscribers = subscriptionIndex.lookup("dm", to)`.
3. **Dispatch.** If `subscribers.length === 0`, log `message.undelivered` at warn with `(channel, topic)` and return. Otherwise, for each subscriber, insert a new row:
   ```
   messages: {
     id,
     agent_id: <subscriber>,
     channel: "dm",
     direction: "in",
     body: <stdout body>,
     turn_id: NULL,
     trace_id: <new trace for the incoming turn>,
     topic: to,
     from_agent_id: <current agent>,
     conversation_id: <current turn's conversation_id>,
     created_at: <now>,
   }
   ```
4. The orchestrator picks up the new inbound rows on its next tick and dispatches each via `processTurn` using `message.agent_id` exactly like today.

### 2.4 Reply routing in DM context

In the existing `{type: "reply"}` branch of `onEvent`, branch on `inbound.channel`:

- `inbound.channel === "cli"` — **unchanged from M2.** Insert an outbound row on the CLI channel; `NotifyBus` delivers to tail.
- `inbound.channel === "dm"` — insert an **inbound** row routed back to the DM's original sender:
  ```
  messages: {
    id,
    agent_id: <inbound.from_agent_id>,
    channel: "dm",
    direction: "in",
    body: <reply body>,
    turn_id: NULL,
    trace_id: <new trace>,
    topic: <inbound.from_agent_id>,
    from_agent_id: <current agent>,
    conversation_id: <inbound.conversation_id>,
    created_at: <now>,
  }
  ```

The original DM sender is thus woken up naturally — by the orchestrator's usual dispatch of the new inbound row.

### 2.5 Conversation cap

At the top of `processTurn`, before any other work (before token mint, before `bus.publish("turn.started")`):

```
if (inbound.conversation_id != null &&
    turnRepo.countByConversationId(inbound.conversation_id) >= N) {
  turnLogger.warn("conversation.limit_reached", { conversationId, N });
  turnRepo.markError(turnId, "conversation_cap", ...);
  return;
}
```

N defaults to 10; read from `TEAMROOM_MAX_TURNS_PER_CONVERSATION` env var. NULL conversation_id (pre-M3 rows) skips the cap.

### 2.6 Conversation_id lifecycle

- `cli/send.ts`: generate a fresh `conversation_id` (UUID) per CLI message.
- `turn-processor.ts` `onEvent`: when creating new inbound rows from stdout events (DMs and DM-context replies), inherit `inbound.conversation_id`.
- Turn rows copy `conversation_id` from their triggering message at creation.
- Migration defaults existing M2 rows to NULL.

### 2.7 Data flow — DM round-trip

```
human → CLI send →
  messages: (agent_id=claude-assistant, channel=cli, conversation_id=<new>)
             ↓ orchestrator poll → processTurn
  spawn claude-assistant
             ↓
  [reads /codebase; decides to DM studio-assistant]
             ↓
  stdout: {type:"dm", to:"studio-assistant", body:"…"}
             ↓ onEvent handler:
               - reject self-DM? no
               - subscribers = lookup("dm","studio-assistant") → ["studio-assistant"]
               - insert inbound: (agent_id=studio-assistant, channel=dm,
                 topic=studio-assistant, from=claude-assistant,
                 conversation_id=<inherited>)
             ↓ orchestrator poll → processTurn
  spawn studio-assistant
             ↓
  stdout: {type:"reply", body:"…"}
             ↓ onEvent handler (inbound.channel=="dm"):
               - insert inbound: (agent_id=claude-assistant, channel=dm,
                 topic=claude-assistant, from=studio-assistant,
                 conversation_id=<inherited>)
             ↓ orchestrator poll → processTurn
  spawn claude-assistant
             ↓
  stdout: {type:"reply", body:"…"}
             ↓ onEvent handler (inbound.channel=="cli"):
               - insert outbound on cli → NotifyBus → tail → user
```

### 2.8 What doesn't change

- `src/bus/NotifyBus` — untouched. CLI `tail` continues to work via the same mechanism.
- `src/daemon/orchestrator.ts`, `src/daemon/reconcile.ts` — untouched.
- `src/container/`, `src/model-proxy/`, `src/clock/`, `src/logger/`, `src/env/` — untouched.
- `src/agent-runtime/` — untouched. (The stdout `dm` verb is emitted by agents and parsed by the **daemon-side** stdout handler; inside the container, nothing new.)
- `src/cli/` — untouched. `send.ts` gains a one-line `conversation_id` generation; `tail.ts` is unchanged.
- Container lifecycle, model proxy, reconciler, safety nets — all as-is.

## §3 Agent surface + subscription schema

### 3.1 Stdout verbs (what the agent writes)

| Verb | Shape | Semantics |
|---|---|---|
| `reply` | `{type: "reply", body}` | Reply to whoever started this turn. Daemon branches on `inbound.channel`: CLI → outbound CLI row → tail. DM → inbound DM back to `inbound.from_agent_id`. |
| `dm` | `{type: "dm", to: "<agent-name>", body}` | Direct-message another agent. Daemon resolves subscribers for `("dm", to)` and inserts one inbound row per subscriber. Self-DMs rejected. |

No other verbs in M3. No `publish`, `subscribe`, `post`, or any pub/sub vocabulary. Communication in communication terms.

### 3.2 Stdin envelope (what the agent reads when woken)

M2's envelope (`{prompt, messageId, turnId, traceId}`) gains the minimum additional context needed for the agent to understand how it was woken:

```json
{
  "prompt": "<body>",
  "messageId": "<message id>",
  "turnId": "<turn id>",
  "traceId": "<trace id>",
  "channel": "cli" | "dm",
  "from": "cli" | "<agent-name>"
}
```

Enough to answer "who woke me?" and no more. The agent does not see `topic` (redundant with its own identity for DMs) or `conversation_id` (daemon-internal).

### 3.3 Subscription schema in `agent.yaml`

```yaml
subscriptions:
  - "<topic>"
```

- Each entry is a topic string. Channel is implicit (`dm`) — this field is exclusively for DM subscriptions in M3.
- **CLI routing does NOT use subscriptions.** CLI `send` resolves the target agent directly; `messages.agent_id` is set at send-time. No subscription lookup involved.
- The minimum useful M3 `agent.yaml` lists the agent's own name so it receives DMs addressed to it:

```yaml
# agents/claude-assistant/agent.yaml
subscriptions:
  - "claude-assistant"

# agents/studio-assistant/agent.yaml
subscriptions:
  - "studio-assistant"
```

Explicit — each agent owns what DM topics wake it up. Matches the team-metaphor principle that drove the design.

### 3.4 Forward-compatible shape (NOT implemented in M3)

When `wake`, `channel`, or globs graduate, the yaml parser will accept an alternate object shape alongside strings:

```yaml
subscriptions:
  - "simple-topic"                                             # string form, works forever
  - { channel: "telegram", topic: "chat-12345", wake: true }   # future object form
```

Both shapes coexist when that day comes. Not part of M3.

## §4 Edge cases and safety

(Routing mechanics are covered in §2.3–2.5; this section enumerates edge-case behaviour.)

| Scenario | Behaviour |
|---|---|
| Agent DMs itself | Rejected at source in `onEvent`; warn logged `self-dm.rejected` with `{from, to}`; no row written. |
| DM `to` matches no subscriber | No rows written; warn logged `message.undelivered` with `{channel: "dm", topic: to}`. No retry. |
| DM `to` matches multiple subscribers | Unused in M3 (each topic matches ≤1 agent by convention) but supported for free: one inbound row per subscriber. |
| Agent emits >1 DM in one turn | Each is handled independently, in stdout line order. |
| Daemon restart mid-conversation | Unprocessed inbound rows are still in the DB; M2's `reconcile` sweeps orphaned turns. Conversation resumes naturally on daemon restart. |
| Conversation exceeds cap | `processTurn` refuses at entry; warn logged `conversation.limit_reached` with `{conversationId, N}`; turn marked errored; no spawn. |
| NULL `conversation_id` on an inbound | Pre-M3 row. Cap check skipped for that turn; no propagation needed. |

**Concurrency** carries forward from M2: per-agent serialization (one turn at a time per agent). Multi-agent DM dispatch is parallel across agents, serial within agent.

## §5 Shared codebase + Claude fs tools

### 5.1 Shared codebase mount

- `codebase/` directory at the worktree root (already created by the user with subfolders + README).
- Daemon mounts `<worktree-root>/codebase` → `/codebase` **read-write** into every agent container on spawn.
- Host path configurable via `.env`: `TEAMROOM_CODEBASE_PATH` (defaults to `<repo-root>/codebase`). Future direction: this will point at arbitrary target codebases (including the self-referential case of agents working on Team Room itself).
- Uniform across agents in M3 — no per-agent override, no RO flag (deferred per §1).
- Implementation: add `{ hostPath, containerPath: "/codebase", readOnly: false }` to the mounts array in `turn-processor.ts` alongside the existing `/AGENTS.md` and `/store` mounts.
- **Studio-assistant** gets the mount even without tools to use it — harmless; ready for when it grows tools.

### 5.2 Claude-assistant filesystem tools

- `agents/claude-assistant/agent.yaml`: `allowedTools: []` → `allowedTools: [Read, Write, Edit, Bash, Glob, Grep]` (names per the `claude-agent-sdk` built-in set).
- No custom tool wiring — the SDK provides these.
- Tool-call telemetry flows through the SDK's native stderr / log output. **Structured tool-call bus events are deferred** per `m3-followups #3`; they depend on the event-bus backbone, also deferred.

### 5.3 Studio-assistant

`allowedTools: []` unchanged. The `/codebase` mount is passive; no other config change. Studio-assistant becomes tool-capable when it gets the LangGraph refit in M4.

## §6 Testing + staged delivery order

### 6.1 Testing principles (unchanged from M1/M2)

- Unit tests co-located with source (`src/<module>/<file>.test.ts`).
- Integration tests in `tests/integration/` using `:memory:` SQLite + `InMemoryBus` + `FakeRunner`.
- Zero mocking libraries; in-memory real implementations only.
- Smoke tests against real LM Studio + real Anthropic (OAuth default). **No opt-in gates.** Fail loudly if prerequisites missing. Pass means full E2E success.

### 6.2 New unit tests

- Subscription index loader — reads yaml, builds map keyed by `${channel}:${topic}`.
- Stdout `dm` verb parsing (including self-DM rejection).
- Conversation_id propagation: CLI start → DM inheritance → return-DM inheritance.
- Conversation cap: count turns per conversation, refuse at N.
- Reply-routing branching: CLI-triggered → CLI outbound; DM-triggered → return-DM inbound.

### 6.3 New integration tests

- DM round-trip (FakeRunner scripted for both agents; assert full chain).
- Conversation cap triggering (fabricate a loop, assert dispatch refused at N+1).
- `/codebase` mount verification (spawn a container, assert mount visible with expected contents).

### 6.4 Smoke test extension

A new scenario added to the existing smoke test: the **exit demo**.

```
teamroom send claude-assistant "ask studio-assistant what day of the week it is"
  → claude-assistant reads /codebase/README.md (or similar)
  → claude-assistant DMs studio-assistant with a question
  → studio-assistant replies
  → claude-assistant receives the reply and replies to the CLI user
  → user sees the final answer via tail
```

Runs against real LM Studio + real Anthropic (OAuth). No opt-in gate; fails loud if either backend is unreachable.

### 6.5 Staged delivery order

Each phase ends with passing tests and a demonstrable behaviour. Order is chosen so that each layer can be validated before the next is built on top.

**Phase 1 — Foundations.**
- Schema migration: `topic`, `from_agent_id`, `conversation_id` on `messages`; `conversation_id` on `turns`.
- `src/daemon/subscriptions.ts`: loader module; reads all `agent.yaml`s at boot; builds map.
- Wire subscription loader at daemon boot in `main.ts` / `daemon.ts`.
- *Demonstrable:* unit tests pass; daemon boots with populated subscription index.

**Phase 2 — Conversation_id propagation.**
- `cli/send.ts`: generate fresh `conversation_id` per CLI message.
- `turn-processor.ts`: propagate `inbound.conversation_id` through turn creation.
- M2 smoke tests still pass with the new column populated.
- *Demonstrable:* every CLI message has a non-NULL `conversation_id`; turn rows inherit it.

**Phase 3 — DM primitive.**
- `turn-processor.ts` `onEvent`: add `dm` branch (subscription lookup, inbound inserts, self-DM rejection, undelivered logging).
- Stdout event parser extended to recognise the `dm` type.
- Update `agents/*/agent.yaml` with own-name subscriptions.
- *Demonstrable:* one agent DMs another; round-trip works at the FakeRunner level.

**Phase 4 — Reply routing for DM context.**
- Extend the existing `reply` handler in `onEvent` to branch on `inbound.channel`: CLI → outbound (unchanged); DM → return-DM inbound.
- *Demonstrable:* full CLI → DM → reply → CLI multi-hop flow works with FakeRunner and real-runner integration tests.

**Phase 5 — Conversation safety.**
- Cap check at `processTurn` entry; `conversation.limit_reached` logging.
- Configurable via `TEAMROOM_MAX_TURNS_PER_CONVERSATION` env var.
- *Demonstrable:* a synthetic loop hits the cap; conversation ends cleanly.

**Phase 6 — Capability layer.**
- Shared `/codebase` mount added to the mounts array in `turn-processor.ts`.
- `TEAMROOM_CODEBASE_PATH` config wired through daemon config.
- Claude-assistant `allowedTools` updated.
- *Demonstrable:* claude-assistant reads a file from `/codebase`.

**Phase 7 — Full exit scenario.**
- Smoke-test extension passes against real LM Studio + real Anthropic.
- Multi-hop CLI → DM → reply → CLI flow proven end-to-end.

Each phase produces a commit (or small commit series) that leaves the tree in a passing-tests state. If any phase discovers an assumption violation, the finding is tabled to `docs/tabled.md` and the spec amended in-flight (per the M2 pattern).

## §7 Feasibility spike summary

Spike completed before spec commit. Files read:
- `src/daemon/orchestrator.ts`
- `src/daemon/turn-processor.ts`
- `src/db/message-repo.ts`
- `src/cli/send.ts`
- `src/types.ts`

**Findings:**
- `messages` already has `channel` and `trace_id` columns — no additions needed there beyond `topic`, `from_agent_id`, `conversation_id`.
- `orchestrator.tickOnce()` dispatches by `message.agent_id` directly; subscription lookup does **not** need to happen in the orchestrator.
- CLI `send.ts` resolves the target agent at send-time and inserts with that `agent_id`; the CLI path is untouched by subscriptions.
- The only code changes outside schema are:
  - New module: `src/daemon/subscriptions.ts`.
  - One branch added to `turn-processor.ts` `onEvent` (`dm` handling).
  - One branch added to existing `reply` handling in `onEvent` (channel-aware routing).
  - One mount added in `turn-processor.ts`.
  - One config field in daemon config (`codebasePath`).
  - One yaml field change in `claude-assistant/agent.yaml` (`allowedTools`).
- Zero changes to: orchestrator, reconcile, NotifyBus, container runner, model proxy, agent-runtime, CLI.

**Verdict:** M3 is a smaller surface than the M2 retro anticipated. No DB-flow inversion; no major refactor. Additive changes within existing modules.

---

*End of design.*
