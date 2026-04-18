# Ways of Working — Building Team Room

*Last reviewed: 2026-04-18. Update the date when this document is revised.*

## Why this document exists

Team Room is a product about building healthy agentic software teams — teams with the right roles, responsibilities, observability, rituals, and continuous-improvement habits. The premise is that teams like that produce excellent systems.

This document captures the same practices applied to *us* — the people and AI assistants building Team Room. The product is a mirror of its own development practice. Divergence between "how we build Team Room" and "what Team Room is meant to produce" is a signal that either the practice or the product is off.

## Principles

1. **Meta-consistency.** We use the practices we want Team Room's agents to use. Explicit roles, deliberate communication, observability, retrospectives, continuous improvement — these apply to our own work, not just to what we ship.
2. **Reflection is a practice, not an event.** Regular checkpoints are embedded throughout the work, not only at milestone boundaries. Small reflections compound; the milestone retro is the culmination, not the whole practice.
3. **Capture and iterate.** When something works, name it and keep doing it. When something doesn't, name it and change. Preserve learnings as durable artifacts (skills, runbooks, memory entries, scripts) so they outlive the conversation that produced them.
4. **Deliberate about markdown.** Every document has a purpose. Avoid proliferation. Prefer updating an existing document to creating a new one. Before creating any new doc, answer: who reads it, what do they do with it, what makes it go stale, and how does it stay fresh?
5. **Reflection produces action, not more reflection.** Every retro ends with concrete items — changes adopted, artifacts created or removed. Meta-theater (performing reflection without acting on it) is a failure mode to watch for.

## Reflection rhythms

Four cadences, from shortest to longest.

**Mid-section check-ins** — during a working session, when a meaningful section of a design, plan, or implementation sub-task is complete. Two questions, asked by either side: *does this still match the intent?* and *is there something we should capture before moving on?*

**End-of-artifact checkpoints** — after each approved spec, plan, or major commit set. Before proceeding to the next artifact: *is the current one solid? Does it include what it should? Are we carrying an untested assumption?*

**End-of-milestone retrospective** — when a milestone closes, a dedicated retro covering three sections:

- **Keep doing** — what worked and should continue.
- **Stop or change** — what did not work and should adjust.
- **Promote to artifact** — patterns worth extracting into skills, runbooks, scripts, or memory entries.

Retros are captured in `docs/retros/YYYY-MM-DD-<milestone>.md` and are frozen once committed.

**Ad-hoc capture** — if a learning surfaces outside a structured window, name it in the moment. Either update the right document immediately or file a short note so the next retro picks it up.

## Document inventory

This is the current set of document categories for Team Room. When a new role emerges, add a row; when a role consolidates, merge and remove.

| Document | Role | Freshness |
|---|---|---|
| `team-room-context.md` | Original brainstorming snapshot. Historical reference. | Frozen — superseded content goes in specs. |
| `docs/ways-of-working.md` (this doc) | Practices for building Team Room. | Update when practices evolve; note the date. |
| `docs/superpowers/specs/YYYY-MM-DD-*-design.md` | Approved designs per milestone. | Update on explicit amendment; otherwise frozen at approval. |
| `docs/superpowers/plans/YYYY-MM-DD-*-plan.md` | Implementation plans. | Live during implementation; closed at milestone end. |
| `docs/retros/YYYY-MM-DD-<milestone>.md` | Milestone retrospectives. | Frozen at milestone close. |
| `docs/runbooks/*.md` | Operational procedures (e.g., "add a new agent," "add a new channel"). | Kept current — runbooks rot fast; check on use. |
| `CLAUDE.md` (repo root; may also appear per-agent) | Standing instructions to Claude for this repo or agent. | Update when standing instructions change. |
| Memory entries (Claude's memory system) | Recurring user preferences and project context that survives conversations. | Update or remove as context shifts. |

**Proliferation test** before creating any new markdown file: does the content belong in one of the above? If yes, extend. If no, justify the new category explicitly and add a row to this table in the same change.

## Capturing learnings

Three artifact types carry learnings forward. Each has a different half-life and audience.

- **Skills** — process-level guidance that applies across projects. Lives in the Claude skills system. Promote to a skill when a pattern is general.
- **Runbooks** — procedure-level guidance specific to Team Room, in `docs/runbooks/`. Promote to a runbook when a procedure will be repeated more than once.
- **Memory entries** — recurring preferences, constraints, or project context that Claude should carry across conversations. Update when context shifts; remove when stale.

Promotion rule: **once is a moment; twice is a pattern.** Don't formalize on first occurrence — premature formalization is its own drag. Wait for the second sighting, then capture.

## Failure modes to watch for

- **Silent drift.** Practices on paper diverging from practices in use. Retros catch this — but only if they are honest.
- **Doc sprawl.** A collection of markdown files that no one reads, none obviously authoritative. The inventory above is the mitigation. Consolidate aggressively; delete willingly.
- **Meta-theater.** Reflection that produces more reflection rather than better work. Every retro ends with concrete items, not essays.
- **Practice/product divergence.** If what we actually do while building Team Room looks nothing like what Team Room is meant to enable, something is off. Treat the gap as data.

## Cross-pollination between practice and product

When a gap in our own practice surfaces, ask: *is this also something Team Room should provide for its agents?* When we ship a capability in Team Room (event bus, observability, scheduling, evals, memory), ask: *should we apply it to our own development practice?*

Examples to watch for:
- If we struggle to correlate what happened across artifacts, that's a signal Team Room's cross-agent tracing matters more than we thought.
- If we find retros hard to remember or structure, that's a signal Team Room's ceremony support (M7) should have opinionated scaffolding.
- If we invent a runbook format here, it's a candidate to become the format Team Room uses internally for its own agents' runbooks.
