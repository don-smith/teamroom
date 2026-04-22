# Tabled — working-memory scratch pad

This file is the single working-memory location for anything noticed mid-task that we don't want to chase right now: epiphanies, follow-up items, design questions, technical-debt observations, ideas for later. Add an entry as a short bullet with enough context to reconstruct cold; remove it once it's processed (acted on, rolled into another document, or consciously dropped).

Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

**Format for each entry:** a one-line title, a 2–4 line description, and (when known) where its next destination probably is — `docs/roadmap.md#backlog` is the most common destination at milestone close for items still relevant; other destinations include spec, runbook, skill, memory, retro, or drop.

**Milestone-close processing:** at the end of each milestone, sweep this file. Outstanding items worth keeping roll into [`docs/roadmap.md#backlog`](roadmap.md#backlog); completed/obsolete items are dropped. The file ends each milestone empty (or near-empty).

Mechanics in the `epiphany-tabling` skill (`.claude/skills/epiphany-tabling/`).

---

## Open entries

- **Verify studio-assistant ↔ claude-assistant mail round-trip end-to-end.** User flagged during M6 brainstorm: unclear whether studio-assistant (LangGraph runtime, mail-MCP tool surface) can actually send mail *to* and receive replies *from* the claude-assistants in live operation. M5 manual acceptance Scenario 1 was "Claude↔Studio round-trip" so this may be implicitly proven, but worth an explicit re-check before M6 integration work relies on peer-mail-between-heterogeneous-agents as a baseline. Next destination: pre-M6 verification step (either a pre-plan manual sanity check or the first task in the M6 plan's "prep" phase).
