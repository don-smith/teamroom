# Tabled — working-memory scratch pad

This file is the single working-memory location for anything noticed mid-task that we don't want to chase right now: epiphanies, follow-up items, design questions, technical-debt observations, ideas for later. Add an entry as a short bullet with enough context to reconstruct cold; remove it once it's processed (acted on, rolled into another document, or consciously dropped).

Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

**Format for each entry:** a one-line title, a 2–4 line description, and (when known) where its next destination probably is — `docs/roadmap.md#backlog` is the most common destination at milestone close for items still relevant; other destinations include spec, runbook, skill, memory, retro, or drop.

**Milestone-close processing:** at the end of each milestone, sweep this file. Outstanding items worth keeping roll into [`docs/roadmap.md#backlog`](roadmap.md#backlog); completed/obsolete items are dropped. The file ends each milestone empty (or near-empty).

Mechanics in the `epiphany-tabling` skill (imported workflow skill package).

---

## Open entries

- **M6 landing paused at Step 1: RESOLVED.** Land Step 1 complete (production audit + 3 commits: G2 blockers, docs sweep, as-built). Proceeding through Steps 2-10.

- ~~**Consolidate agent runtimes to DeepAgents + Pi, provider backbone to OpenRouter.**~~ **RESOLVED — shipped in persona realignment (2026-06-18).** Plan in `.myflow/artifacts/plans/2026-06-18_22-37-10_teamroom-persona-realignment.md`.

- **Per-agent volume mount permissions (two-part).** Land Step 3 security audit: `/codebase`, `/AGENTS.md`, and `/store` are all mounted `readOnly: false` regardless of persona. Next destination: spec for mount-perms config field + agent-onboarding runbook update; likely pre-M7 cleanup or M7 persona-maturity pass.

- **Team onboarding and self-healing team care.** New-project onboarding should likely start with a human-created project/folder and an explicit Team Room initialization/onboarding step. Out of M6 scope; likely belongs in roadmap/backlog after Archie is accepted.

- **Per-agent fallback models/providers.** Future agent configs should support a primary model plus ordered fallbacks. Out of M6 scope unless needed for acceptance.

- ~~**Per-agent memory and librarian role are high priorities.**~~ **PARTIALLY RESOLVED — Libby (librarian) shipped in persona realignment.** Memory substrate still deferred (M7).

- ~~**Sweep stale provider/runtime enumerations in docs during Task F1.**~~ **RESOLVED — completed in persona realignment Phase 5 (documentation sweep).**

- **Telegram (+ Discord / Slack) as Team Room channels.** The biggest near-term unlock after Archie is a non-CLI external channel. Out of M6 scope.

- **Distinguish trigger cause on `session.spawned` log.** Code review of Task A3 flagged: when boot-spawns, respawns, and mail-driven spawns all share the same `session.spawned` log line.

- **Archie integration follow-ups (from C1+C2+C3 combined review).** Three Important-level items not blocking C4 but wanted before M6 close.

- **Persistent-lifecycle polish follow-ups (from A5+A6+A7 combined review).** Three Important-level items.
