# M4 Follow-ups

*Created at M4 brainstorm (2026-04-20) for items explicitly deferred from M4 into later milestones. Will accumulate more entries during M4 execution. Trigger conditions noted on each entry so future brainstorms can decide when to pick them up.*

---

## 1. Studio-assistant tool-calling / LangGraph refit

Studio-assistant doesn't speak MCP; in M4 it stays as a passive, non-mail-participating agent. Upgrade to LangGraph (or equivalent tool-capable runtime) planned for M5 (memory) or its own milestone.

**Trigger:** M5 memory needs agent tool-use; or an earlier concrete need for studio to participate in mail / fs / scheduling.

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

*End of M4 follow-ups. Items accumulate during execution; entries resolved at milestone close migrate to the as-built's "known limitations" section or are dropped.*
