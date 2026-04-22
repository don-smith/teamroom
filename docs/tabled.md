# Tabled — working-memory scratch pad

This file is the single working-memory location for anything noticed mid-task that we don't want to chase right now: epiphanies, follow-up items, design questions, technical-debt observations, ideas for later. Add an entry as a short bullet with enough context to reconstruct cold; remove it once it's processed (acted on, rolled into another document, or consciously dropped).

Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

**Format for each entry:** a one-line title, a 2–4 line description, and (when known) where its next destination probably is — `docs/roadmap.md#backlog` is the most common destination at milestone close for items still relevant; other destinations include spec, runbook, skill, memory, retro, or drop.

**Milestone-close processing:** at the end of each milestone, sweep this file. Outstanding items worth keeping roll into [`docs/roadmap.md#backlog`](roadmap.md#backlog); completed/obsolete items are dropped. The file ends each milestone empty (or near-empty).

Mechanics in the `epiphany-tabling` skill (`.claude/skills/epiphany-tabling/`).

---

## Open entries

- **First real agent role to consider for Team Room — possibly architect.**
  Surfaced during M4.5 retro reflection. Today the harness hosts only placeholder/test agents (`studio-assistant`, `claude-assistant`, `claude-researcher`). When deciding which real role to introduce first, the user keeps coming back to "architect" — an agent that holds and tracks the project's architecture, notices smells, suggests improvements over time. Alternative candidate: "doctor" / QA-tester. Less compelling than architect because the assistant + user already cover PM/priority and dev concerns, and the historian role is being filled by as-builts/retros — but the architect role isn't currently held by anyone. Destination: roadmap milestone scoping when M5 (LangGraph multi-agent-family runtime) lands and we have the substrate to give a non-Claude-family agent a real role.
