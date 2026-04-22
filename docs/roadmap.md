# Team Room Roadmap

*Living document. Supersedes the milestone list in [`team-room-context.md §7`](../team-room-context.md) (which remains as the frozen original snapshot). Updated at each milestone close. Ordering is subject to change as we learn; see each milestone's retro + as-built for the reasoning when it shifts.*

## Milestones

| # | Title | Status | Close date | Artifact |
|---|---|---|---|---|
| M1 | One agent that works | Shipped | 2026-04-18 | [As-built](as-built/2026-04-18-teamroom-m1.md) |
| M2 | Model abstraction layer (multi-model credential proxy) | Shipped | 2026-04-19 | [As-built](as-built/2026-04-19-teamroom-m2.md) |
| M3 | Team substrate (narrowed ship) | Shipped | 2026-04-20 | [As-built](as-built/2026-04-20-teamroom-m3.md) |
| M4 | Agent mail — email on an event-bus backbone | Shipped | 2026-04-21 | [As-built](as-built/2026-04-21-teamroom-m4.md) |
| M4.5 | AI-native harness — `chat` / `watch` / `inbox` | Shipped | 2026-04-21 | [As-built](as-built/) (pending write at M4.5 close) |
| M5 | Multi-agent-family tooling — LangGraph studio + Codex agents | Future | — | Gives the harness non-Claude-only agent support before memory lands. |
| M6 | Per-agent memory | Future | — | Originally M4 in `team-room-context §7`; shifted behind mail (M4) and the tooling expansion (M5). |
| M7 | Scheduling | Future | — | Originally M5. |
| M8 | Evaluations | Future | — | Originally M6. |
| M9 | Team ceremonies + self-learning | Future | — | Originally M7. |

## Why this file exists

`team-room-context.md` is a frozen snapshot of the original brainstorm. Its `§7` milestone list was the best estimate at that time. During M3 execution the team-substrate thesis sharpened: the messaging primitive we inherited from M1/M2 (turn/reply) turned out to be the wrong metaphor for multi-agent communication. Email on an event-bus backbone is the right one. That insight made agent mail the obvious next foundation — memory and scheduling will land on top of a working communication substrate, not alongside it.

Rather than edit the frozen original, this file is the single **living** source of truth for what's next. Every milestone close updates it.

## Update cadence

At every milestone close:
- Mark the completed milestone's status (Shipped) and link its as-built.
- Re-examine the "Future" order in light of what the milestone taught us.
- If the order changes, note why (a one-liner in the rationale column is enough; deeper rationale goes in the milestone's retro).
- Process [`docs/tabled.md`](tabled.md): outstanding items worth keeping roll into the Backlog below; completed/obsolete items are dropped; the file ends the milestone empty (or near-empty).

## Backlog

Items identified during prior milestones, still outstanding, not yet slotted into a future milestone. Updated at each milestone close.

### Channel architecture evolution

- **Second channel (Telegram, Slack, voice, etc.).** M4 ships one channel adapter (CLI). When a concrete need for a non-CLI channel arrives: introduce a plugin registry, extract the CLI adapter to a plugin, implement the new channel.
- **`channel.cli.out` event generalization.** The dispatcher hard-codes `channel.cli.out` for CLI delivery; a second channel requires either a generic `channel.out` event (preferred) or per-channel event names. See M4.5 Backlog §3 for the fix shape. Trigger: second channel implementation.
- **`ChannelRegistry` → dispatcher strict-deliver wiring.** The dispatcher accepts channel-kind addresses unconditionally; the registry is consulted only by `ChatServer`. Adding `knownChannels` to `MailDispatcherOpts` closes the gap. Trigger: when the second channel lands, or as a standalone hardening pass.
- **Unified mail across external channels.** Each external channel (Telegram, etc.) delivers messages as mail to agents and receives agent replies as outbound channel messages. Deferred pending first external channel integration; same design pass as the second-channel work.

### Mailing lists and event bus

- **Mailing-list system end-to-end verification (turn-event publication as vehicle).** The infrastructure works mechanically but `list:harness-activity` is silent in live operation — `SessionTimerManager` doesn't publish `turn.started` / `turn.completed`. Publishing those events (~30 lines + test) is the vehicle for proving the full mailing-list-from-system-events path works end-to-end. Deeper design questions: does `list` deserve a top-level address prefix? subscription discovery? per-list authz? Trigger: when a concrete agent use case needs lists for real coordination.
- **Richer system-event mailing-list taxonomy.** M4 seeds one list (`list:harness-activity`). The infrastructure supports more (`list:test.failed`, `list:deploy.broken`, `list:merge.landed`, etc.) but none are wired. Trigger: a concrete agent subscribes to another event type; prefer explicit wiring over speculative taxonomy.
- **Durable event bus.** Current bus is ephemeral / in-process; crashes drop events. Dispatched mails are durable (DB); observability events are not. Candidates: NATS JetStream embedded, SQLite-backed pub/sub, in-process with SQLite persister (no separate long-running process). Trigger: cross-process delivery guarantees, historical event replay, or multi-host deployment.

### Agent ergonomics

- **Cap-warning feature.** When a thread nears the cap (default 40 post-M4.5), agents get no signal. The last 10 messages should include a `warning: "thread_approaching_cap"` + `messagesRemaining` field in `mail.send` / `mail.reply` responses so agents can wrap up gracefully. Trigger: sooner is better; ~50 lines + test + AGENTS.md update.
- **`ccAll` default on reply.** When a thread has multiple participants, `mail.reply` should default `ccAll: true` so secondary participants aren't silently dropped. Trigger: same milestone as cap-warning.
- **CLI `cc` support.** The `teamroom chat` REPL has no way to set `cc` on a publish, even though the WebSocket protocol accepts `cc: string[]`. A slash-command or header-style syntax needed. Trigger: human-driven multi-party threads.
- **System prompts for mail-aware agents.** Claude-assistant and other agents need system prompts that explicitly teach inbox-check → reply → peer-mail patterns. Content evolves with use; expect prompt iteration over several milestones.

### Mail substrate evolution

- **In-reply-to / deep threading.** M4 uses `thread_id` only (shallow threading). No reply chains with forks or branches. The `in_reply_to` and `references` fields from the M3 email-metaphor design are the obvious extension. Trigger: agents actually need richer thread semantics.
- **Mail retention / purge policy.** Soft delete only; no automatic purge. DB could grow unboundedly if agents don't actively delete. Fix candidates: periodic purge job, per-agent quotas, TTL on archived rows. Trigger: DB size becomes visible or archived-mail volume stresses indexes.
- **Mail attachments / structured payloads.** M4 ships body-only mail (TEXT). No attachments, no JSON blobs, no files or images. Trigger: concrete need for structured data between agents (file diff, JSON config, image).
- **Removal of deprecated schema columns.** Migration `003` left `topic`, `from_agent_id`, `conversation_id` in place. A schema-cleanup migration (`004_…`) removes them once the new shape has settled. Trigger: M5 or later, when confident no read-path still references the deprecated columns.

### Operability

- **Session reattach on daemon restart.** Daemon restart kills all live containers; mid-turn LLM state is lost (mail content preserved). Trigger: daemon restarts become visible disruptions, or long-running agent tasks warrant session persistence.
- **Per-agent container idle-timer tuning.** Global 30-minute default (`TEAMROOM_SESSION_IDLE_MINUTES`). Different agent types want different idle behavior (batch worker: 2h; triage agent: 5 min). Likely a per-`agent.yaml` field. Trigger: concrete agent with different idle needs.
- **`teamroom send` no-ack 30ms sleep.** `src/cli/send.ts` sleeps 30ms before closing the WebSocket because the chat protocol has no ack frame. Fix: add an `ack` frame to the protocol; `send` waits for ack instead of sleeping. Trigger: `send` flakiness reports, or chat-protocol hardening pass.
- **Model-proxy log readability.** Full request/response bodies in JSONL make the daemon log hard to scan. Options: truncate long fields, verbose-mode flag, `teamroom logs` pretty-printer subcommand, or split high-volume spans to a separate file. Trigger: anyone debugging LLM interactions and finding raw logs unreadable.
- **`teamroom status` enrichment.** Currently shows PID + port files. Could add active session count, per-agent state, last-mail-delivered timestamp, connected channel clients, MCP server health. Trigger: operators wanting a quick health check beyond log grepping.
- **Agent-container observability.** When a container runs but produces no visible progress, there's no way to tell why — tool calls are captured at the daemon side but container runtime output (wake received, LLM start/done, errors) is on stderr, returned only at exit. Options: `{type:"log"}` stdout envelopes from the runtime forwarded by the session manager; or an MCP logging tool so agents log structured events from inside the turn. Trigger: next time a container is stuck and the cause is unclear.

### Future infrastructure

- **Additional MCP servers (memory, scheduling, filesystem).** M4 ships the mail MCP server as the first using the daemon-hosted pattern. Subsequent milestones (M5 memory, M7 scheduling, etc.) add their own MCP servers using the same pattern. Trigger: each respective milestone.
- **LM Studio model swap.** The currently loaded qwen model emits XML-shaped tool-call fragments mid-response, hypothesized to be the source of the `lm-studio-real.test.ts` multi-turn flake. A better-behaved model should be selected during M5 LangGraph work (LangGraph will use LM Studio as its primary non-Anthropic test model anyway). Trigger: M5 LangGraph work.
- **Mail-MCP / daemon coupling architectural review.** The mail-MCP HTTP server lives in-process with the daemon (same trust boundary). Running it as a separately-addressable surface (for multi-host deployment, or hosting mail without sessions) is unexplored. Trigger: a deployment scenario needing that separation, or a security review of the in-process trust boundary.
- **Multi-model per-agent and per-request model selection.** Agents will eventually have access to multiple models and choose per-request, with per-agent skill arrays mapping work types to models. `agent.yaml` carries a future-list-shape comment. Trigger: a concrete agent with a real per-call model-selection need.
- **Streaming model responses.** Proxy buffers the full response before replying (required for `extractUsage`). Streaming requires SSE pipe, usage parsing from `message_stop`, `deadlineMs` in addition to idle timeout, and possible container↔proxy transport re-evaluation. Trigger: an agent surface needing realtime streaming (long completions, voice, etc.).

### Code quality

- **WebSocket protocol parser dedup.** `src/modules/channels/protocol.ts` and `src/modules/mail/protocol.ts` share validation scaffolding (object-shape narrowing, type-discrimination, error message style). A shared `src/modules/protocol-helpers.ts` with generic narrowing helpers would shrink both. Pure cleanup; no behavior change. Trigger: third WebSocket protocol, or a non-trivial change to one of the two parsers where the duplication makes the diff awkward.

## Related

- [`team-room-context.md §7`](../team-room-context.md) — frozen original roadmap. Consult for historical context; do not edit.
- [`docs/ways-of-working.md`](ways-of-working.md) — document inventory including this file.
- [`docs/retros/`](retros/) — per-milestone retrospectives; each one's action items feed back here.
