# M4 Follow-ups

*Created at M4 brainstorm (2026-04-20) for items explicitly deferred from M4 into later milestones. Will accumulate more entries during M4 execution. Trigger conditions noted on each entry so future brainstorms can decide when to pick them up.*

---

## 1. Studio-assistant tool-calling / LangGraph refit

Studio-assistant doesn't speak MCP; in M4 it stays as a passive, non-mail-participating agent. Upgrade to LangGraph (or equivalent tool-capable runtime) is now scheduled — see §17 for the post-M4 sequencing (mini-milestone §15 lands first so the new agent can be driven + observed with `chat` / `watch` / `inbox`).

**Trigger:** §15 ships. Superseded-by: §17.

## 2. Second channel (Telegram, Slack, voice, etc.)

M4 ships one channel adapter (CLI) inline in the daemon. Plugin registry deliberately deferred.

**Trigger:** concrete need for a non-CLI channel. At that point: (a) introduce a plugin registry, (b) extract the CLI adapter to a plugin, (c) implement the new channel.

## 3. In-reply-to / deep threading

M4 uses `thread_id` only (shallow threading). No reply chains with forks/branches.

**Trigger:** agents actually need richer thread semantics (e.g., forked replies, conversation trees). §6 of m3-followups listed `in_reply_to` and `references` as familiar email headers — pick up the richer fields then.

## 4. Richer system events + mailing-list taxonomy

M4 seeds one mailing list (`list:harness-activity` with `turn.started`/`turn.completed`). Infrastructure supports more; we just haven't wired them. Examples mentioned during M3→M4 thinking: `list:test.failed`, `list:deploy.broken`, `list:merge.landed`.

**Trigger:** concrete agent need subscribes to another event type. Prefer explicit wiring over speculative taxonomy.

## 5. Mail retention / purge policy

Soft delete only in M4. No automatic purge. DB could grow if agents don't actively delete.

**Trigger:** DB size becomes visible, or archived-mail volume starts stressing indexes. Fix candidates: periodic purge job; per-agent quotas; TTL on archived rows.

## 6. Session reattach on daemon restart

M4 kills all live containers on daemon restart (NanoClaw precedent). Session continuity across daemon restarts is not preserved; mid-turn LLM state is lost (mail content is preserved).

**Trigger:** daemon restarts become visible as disruptions, or long-running agent tasks warrant session persistence.

## 7. Per-agent container idle-timer tuning

M4 uses a global 30-minute default (`TEAMROOM_SESSION_IDLE_MINUTES`).

**Trigger:** different agent types need different idle behavior (e.g., a batch worker wants 2-hour idle; a triage agent wants 5 min). Likely a per-agent.yaml field when it lands.

## 8. Durable event bus

M4 bus is ephemeral / in-process. Crashes drop events. Dispatched mails are durable (DB); observability events are not.

**Trigger:** cross-process delivery guarantees needed; a subsystem wants historical event replay; or multi-host deployment requires it. Candidates per m3-followups §6: NATS JetStream embedded; SQLite-backed pub/sub; in-process with SQLite persister.

## 9. Per-thread LLM context accumulation

M4 uses fresh LLM context per wake (per mail). The agent can re-read thread history via MCP but the LLM doesn't automatically see prior mails in its context window.

**Trigger:** M5 (memory) addresses context/thread memory properly. Options include thread-scoped context loading, summary-on-reach, or agent-managed memory tools. Revisit the mechanism alongside memory design.

## 10. Mail attachments / structured payloads

M4 ships body-only mail (TEXT). No attachments, no structured-data envelopes (JSON blobs, files, images).

**Trigger:** concrete need for structured data between agents (e.g., passing a file diff, a JSON config, an image).

## 11. Additional MCP servers (memory, scheduling, filesystem)

M4 ships the mail MCP server as the first of its kind. The `/mcp` endpoint, token auth, and daemon-hosting pattern generalize — but only the mail server is wired.

**Trigger:** subsequent milestones (M5 memory, M6 scheduling, etc.) add their own MCP servers using the same host-daemon pattern. Likely each gets a sibling port or sibling path on the same port.

## 12. Unified mail across external channels (Telegram-as-email, etc.)

`m3-followups §6` envisioned each agent having e.g. a Telegram account, with Telegram threads delivered as mail. Deferred pending first external channel integration.

**Trigger:** first non-CLI channel lands (see item #2). Likely the same design pass.

## 13. System prompts / AGENTS.md updates for mail-aware agents

Claude-assistant and the new second Claude-family agent both need system prompts that instruct them: "on wake, check inbox via `mail.list`; reply via `mail.reply`; send to peers via `mail.send`; team roster here." The spec lists the requirement but the content itself evolves as we learn what agents actually need.

**Trigger:** ongoing. Expect prompt iteration during and after M4 execution. Capture surprises in retro.

## 14. Removal of deprecated schema columns

Migration `003` leaves `topic`, `from_agent_id`, `conversation_id` in place even though M4 code no longer uses them. Removing is a schema-cleanup migration (`004_…`) once the new shape has settled.

**Trigger:** M5 or later, when we're confident no read-path still references the deprecated columns.

---

## 15. AI-native harness — `chat` / `watch` / `inbox` (mini-milestone)

The next milestone after M4 closes. Three thin CLI surfaces that reuse M4 plumbing to make the harness self-testable by an AI collaborator (and less friction for humans) without hacking the DB directly:

- **`teamroom chat <agent> "<text>"`** — synchronous send-and-wait. Same HTTP path as `send`, but blocks until the target replies to `cli:*`, goes idle without replying, or a timeout fires. Prints the reply(ies) inline. Removes the "tail in one terminal, send in another" two-window friction.
- **`teamroom watch`** — structured JSONL stream of the in-process bus events (`mail.delivered`, `mail.sent`, `tool.call`, `session.spawned` / `session.idle_exit`, `channel.cli.out`) as they happen. Single pane showing what each agent is actually doing mid-turn.
- **`teamroom inbox <agent>` / `teamroom thread <id>`** — read-only DB views that replace ad-hoc SQL.

Implementation shape: two new HTTP endpoints on the mail-MCP server (`/cli/chat` = long-poll/SSE for a matching CLI-outbound row; `/events` = SSE stream of bus events), three CLI commands. ~400 lines.

**Acceptance scenarios for this mini-milestone** (these were the "worth testing" list from M4 manual testing; rather than do them by hand, we use them to validate the new CLI commands work end-to-end):

- `ccAll` group thread: three-party thread stays coherent; `mail.reply(..., ccAll: true)` reaches all participants.
- Thread cap (default 10): 11th send returns a clean MCP error; the agent recovers by archiving or starting a fresh thread.
- Idle exit: `TEAMROOM_SESSION_IDLE_MINUTES=1`, send one mail, wait 2min, verify `docker ps` shows the session gone.
- Daemon-restart kills stale containers: start daemon, send mail, Ctrl-C, restart, verify the previous agent container is killed at startup.
- Self-mail: agent mails itself; no deadlock.
- Concurrent spawn: two CLI sends to different agents in rapid succession; both sessions spawn without MCP-token collision.
- Invalid recipient: dispatcher error surfaces to the LLM via MCP, LLM reports it to the user.

**Trigger:** ship M4 first, close the retro/as-built, then open this as the next milestone's plan.

## 16. Mailing-list fanout trigger events (`turn.started` / `turn.completed`)

`MailingListTriggerListener` + `MailingListRegistry` are wired end-to-end, but M4's session-driven runtime doesn't actually publish `turn.started` / `turn.completed` on the `EventBus` — those events were responsibilities of the old M3 turn-processor and the M4 session-manager path bypasses it. Result: the `list:harness-activity` list works mechanically (verified in the integration test, which publishes the events manually) but is silent in live operation.

**Fix shape:** have `SessionTimerManager` publish `turn.started` before each `writeEnvelope` and `turn.completed` after the runtime's reply completes (or after an idle-timeout-driven stdin close, if we want "session ended" visibility). Small change, maybe 30 lines + test.

**Trigger:** bundled into the mini-milestone above (§15), since mailing-list observability is itself a testing primitive.

## 17. Studio-assistant tool-calling via LangGraph (second-agent-family milestone)

After the AI-native-harness mini-milestone (§15) lands, the next milestone lifts studio-assistant from a passive non-mail-participating agent into a LangGraph-backed tool-capable agent. Rationale: Team Room should not only host Claude-family agents. LangGraph gives a provider-neutral runtime we can point at any model, which keeps the harness honest about multi-provider support.

Sequencing: §15 first (so the new agent can be driven and observed by the chat/watch/inbox tools), §17 second (lifts studio-assistant), Codex-family agent third (additional runtime), then memory (M5 as originally planned).

**Trigger:** §15 ships.

## 18. Agent-container observability (logging as an MCP tool)

Manual testing during M4 surfaced that when a container is running but the LLM isn't making any visible progress, there's no good way to tell WHY. We capture tool calls at the daemon side via the `tool.call` bus event, but that only fires for MCP calls — the container's own runtime output (wake received, LLM starting, LLM done, errors) is currently only on stderr, which docker-runner accumulates and returns at exit time.

Two shapes worth considering:
- Runtime emits `{type:"log"}` stdout envelopes on wake-received / LLM-start / LLM-done / errors. Daemon's session manager subscribes to each container's `onEvent` and forwards to the daemon JSONL log.
- **User's idea (worth capturing):** expose a logging MCP tool (e.g., `mcp__observability__log`) so the *agent itself* can log structured events from inside the LLM turn. Advantage: observability lives in the host, not the container, so no log-forwarding plumbing; same trust/auth as mail MCP.

**Trigger:** next time we can't tell whether a container is stuck vs. running vs. silently deciding not to act. Likely bundled with M5 memory if memory adds another MCP surface.

---

*End of M4 follow-ups. Items accumulate during execution; entries resolved at milestone close migrate to the as-built's "known limitations" section or are dropped.*
