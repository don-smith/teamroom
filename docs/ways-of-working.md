# Ways of Working — Building Team Room

*Last reviewed: 2026-04-18. Update the date when this document is revised.*

## Why this document exists

Team Room is a product about building healthy agentic software teams — teams with explicit roles, shared context, observability, rituals, and continuous-improvement habits. The premise is that teams like that produce excellent systems.

This document captures the same practices applied to *us* — the people and AI assistants building Team Room. The product is a mirror of its own development practice. Divergence between "how we build Team Room" and "what Team Room is meant to produce" is a signal that either the practice or the product is off. That signal is as valuable as any other observability we invest in.

## Principles

1. **Meta-consistency.** We use the practices we want Team Room's agents to use. Explicit roles, deliberate communication, observability, retrospectives, continuous improvement — these apply to our own work, not just to what we ship.
2. **Reflection is a practice, not an event.** Small reflections compound. The milestone retro is the culmination, not the whole practice.
3. **Capture and iterate.** When something works, name it and keep doing it. When something doesn't, name it and change. Preserve learnings as durable artifacts (skills, runbooks, memory entries, scripts) so they outlive the conversation that produced them.
4. **Deliberate about markdown.** The markdown set is a knowledge base — treated as one, maintained as one. Every file has a purpose, a freshness owner, and a probable half-life. Proliferation is a failure mode.
5. **Reflection produces action, not more reflection.** Every retro ends with concrete items — changes adopted, artifacts created or removed. Meta-theater is a failure mode to watch for.

## The knowledge base — four memory types mapped to markdown

We are not implementing a memory system until M4. We apply the memory framing now to how we organize our own markdown, because the discipline is valuable on its own and because living the shape early will inform the product.

| Memory type | What it holds | Where it lives for us |
|---|---|---|
| **Working** | Transient, currently-relevant context. Scratch thoughts, tabled epiphanies, in-flight notes. | `docs/tabled.md` (always in place; entries are added and removed) |
| **Episodic** | Time-indexed records of events — what happened, when, with what outcome. | `docs/retros/YYYY-MM-DD-<milestone>.md` |
| **Semantic** | Concepts, facts, why-it-is-this-way. The knowledge of the system. | `docs/specs/`, future architecture docs, and `README.md` files placed throughout the repo as navigation/orientation nodes |
| **Procedural** | How to do things — reusable procedures. | `docs/runbooks/` |

**The knowledge graph.** Files are nodes; hyperlinks are edges. Every document liberally links to related documents, definitions, and the closest next-deeper-detail — so both humans and agents can navigate by following thought rather than by searching filenames. READMEs anchor folders. Specs link to the retros that followed them. Runbooks link to the skills they compose. Proximity is signal.

**Claude's cross-conversation memory system** sits orthogonal to this map. It persists recurring user preferences and project context across sessions and draws on all four types as appropriate. It is not a replacement for the markdown knowledge base; it is a pointer-layer that keeps future conversations oriented.

## Reflection rhythms

Three cadences plus one event-driven practice.

### Event-driven: epiphanies

When something unexpected surfaces mid-work — a realization, a fork in the road, a pattern we almost missed — we don't stop and redesign. We **table it**: add a short entry to `docs/tabled.md` with enough context to reconstruct later, then keep going. Tabled entries are processed later (during an end-of-artifact checkpoint or retro) into their probable destinations: spec amendments, runbook seeds, skill candidates, memory entries, or conscious drops.

The rule: an epiphany is either acted on immediately (if trivially cheap) or tabled. Never lost, never derailing.

### End-of-artifact checkpoints

After each approved spec, plan, or major commit set. Before proceeding to the next artifact, four questions:

1. Is the current artifact solid — does it include what it should?
2. Are we carrying an assumption that hasn't been tested?
3. What in `tabled.md` is ready to be processed?
4. What should be promoted to an artifact (skill, runbook, memory) or remembered going forward?

### End-of-milestone retrospective

When a milestone closes, a dedicated retro covering four sections:

- **Keep doing** — what worked and should continue.
- **Stop or change** — what did not work and should adjust.
- **Promote to artifact** — patterns worth extracting into skills, runbooks, scripts, or memory entries.
- **Commit to memory** — what, if anything, belongs in Claude's cross-conversation memory system.

Retros live at `docs/retros/YYYY-MM-DD-<milestone>.md` and are frozen once committed.

## Document inventory

Current set of document categories. Add a row when a new role emerges; merge and remove when a role consolidates. Paths are relative to the repo root.

| Location | Memory type | Role | Freshness |
|---|---|---|---|
| `team-room-context.md` | Episodic | Original brainstorming snapshot; historical reference. | Frozen — superseded content goes in specs. |
| `docs/ways-of-working.md` (this doc) | Procedural | Practices for building Team Room. | Update when practices evolve; note the date at top. |
| `docs/tabled.md` | Working | Scratch pad for tabled epiphanies. | Always in place; entries added and removed as processed. |
| `docs/specs/YYYY-MM-DD-*-design.md` | Semantic | Approved designs per milestone. | Update on explicit amendment; otherwise frozen at approval. |
| `docs/plans/YYYY-MM-DD-*-plan.md` | Semantic | Implementation plans. | Live during implementation; closed at milestone end. |
| `docs/retros/YYYY-MM-DD-<milestone>.md` | Episodic | Milestone retrospectives. | Frozen at milestone close. |
| `docs/runbooks/*.md` | Procedural | Operational procedures (e.g., "add a new agent," "add a new channel"). | Kept current — runbooks rot fast; check on use. |
| `README.md` (repo root and folder-level) | Semantic | Orientation and navigation; anchors for the knowledge graph. | Update when a folder's shape changes. |
| `AGENTS.md` (repo root; may also appear per-agent) | Procedural | Standing instructions to AI assistants working in this repo or on this agent. Model-agnostic (Claude reads it, others do too). | Update when standing instructions change. |
| `docs/memory/*.md` (index at `MEMORY.md`) | Cross-cutting | Recurring user preferences and project context, in-repo so they are visible to git, the user, and any AI agent. Replaces the prior Claude-private auto-memory location. | Update or remove as context shifts; announce writes in conversation. |

**Proliferation test** before creating any new markdown file: does the content belong in one of the above? If yes, extend. If no, justify the new category explicitly and add a row in the same change. The inventory is load-bearing — it's how the knowledge base stays navigable.

## Capturing learnings

Three artifact types carry learnings forward. Each has a different half-life and audience.

- **Skills** — process-level guidance that applies across projects. Lives in the Claude skills system. Promote to a skill when a pattern is general.
- **Runbooks** — procedure-level guidance specific to Team Room, in `docs/runbooks/`. A runbook composes one or more skills into a Team-Room-specific procedure. *The skill/runbook boundary is still being refined — see `docs/tabled.md` for the current heuristic.*
- **Memory entries** — recurring preferences, constraints, or project context that Claude should carry across conversations.

**Promotion rule: once is a moment; twice is a pattern.** Don't formalize on first occurrence. Premature formalization has the same cost structure as premature abstraction in code. Wait for the second sighting, then capture.

## Evolution — from assistant to team to harness

Team Room (the product) is a harness for an agentic software team. Team Room (this project) is being built following the same path that Team Room is meant to enable, in miniature:

1. **Phase 1 — single assistant.** Today. User plus one AI assistant (Claude). All roles collapse into a single collaborator with broad context. No harness needed.
2. **Phase 2 — first dedicated agent.** Introduced only when there is a concrete need that justifies a separate context window, a distinct tool set, a permission boundary, or a specialist role. Each new agent is "hired" the way an employee would be — for a real reason, not speculatively.
3. **Phase 3 — multiple agents, no harness.** A small set of agents coordinating via ad-hoc means (files, messages, shared memory of the user). Works for 2–3 agents. Breaks somewhere past that.
4. **Phase 4 — harness.** When agents need to know about each other, share substrate, subscribe to events, and be observed as a team — that's where Team Room applies.

There are roughly seven roles currently anticipated for Team Room's eventual team composition. None of them are promoted to actual agents yet. The path to Team Room's end state is itself a demonstration of what Team Room is for: introduce complexity only as it is earned.

This mirrors industry guidance (notably OpenAI's practical guide) to start single-agent and split only when prompt bloat, diverging instructions, or security boundaries force it.

## Cross-pollination between practice and product

When a gap in our own practice surfaces, ask: *is this also something Team Room should provide for its agents?* When we ship a capability in Team Room (event bus, observability, scheduling, evals, memory), ask: *should we apply it to our own development practice?*

Examples to watch for:

- If we struggle to correlate what happened across artifacts, that's a signal Team Room's cross-agent tracing matters more than we thought.
- If we find retros hard to remember or structure, that's a signal Team Room's ceremony support (M7) should have opinionated scaffolding, not just a blank slate.
- If we invent a runbook format here, it's a candidate to become the format Team Room uses internally for its own agents' runbooks.
- If our `tabled.md` discipline works, that's a signal Team Room should give each agent a working-memory scratchpad with similar semantics.

## Failure modes to watch for

- **Silent drift.** Practices on paper diverging from practices in use. Retros catch this — only if they are honest.
- **Doc sprawl.** A collection of markdown files that no one reads, none obviously authoritative. The inventory is the mitigation. Consolidate aggressively; delete willingly.
- **Meta-theater.** Reflection that produces more reflection rather than better work. Every retro ends with concrete items, not essays.
- **Practice/product divergence.** If what we actually do while building Team Room looks nothing like what Team Room is meant to enable, something is off. Treat the gap as data.
- **Working-memory overflow.** `docs/tabled.md` growing past a screen of content. When it does, process — don't let it sprawl.
