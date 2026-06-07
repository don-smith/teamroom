# Ways of Working — Building Team Room

*Last reviewed: 2026-06-07. Update the date when this document is revised.*

**Scope of this document.** Ways-of-working holds the **semantic** layer: principles, the knowledge-base model, document inventory, evolution framing, cross-pollination signals, failure modes. The **procedural** layer — the specific rituals we run (epiphany tabling, end-of-artifact checkpoints, retros, as-builts, branch landing, capturing learnings) — lives in invocable skills under `.agents/skills/`. That model-neutral location is intentional: Claude Code, Codex, local models, and future Team Room agents should all be able to discover the same practices. That split keeps this document navigable and makes each practice callable by name when the moment arrives.

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

Six cadences carry the practice. The mechanics of each live in an invocable skill; this section lists them and when they fire.

| Cadence | When it fires | Skill |
|---|---|---|
| **Event-driven: epiphanies** | Anytime a realization surfaces mid-work that is not trivially in-scope. | `.agents/skills/epiphany-tabling/` |
| **Pre-execution plan review** | After a plan is written, before executing. Both the agent and the user read and dry-run the plan before approving. Catches plan-level gaps (config/secrets, test layout, build assets, test/impl inconsistencies) before they become drifts during execution. | `.agents/skills/brainstorming/` for design framing; `.agents/skills/executing-plans/` before implementation begins. |
| **End-of-artifact checkpoint** | After each approved spec, plan, or major commit set. | `.agents/skills/capturing-learnings/` |
| **Development-cycle landing** | At the end of a major piece of work or branch: review code/architecture/security, verify, document, process tabled items, reconcile memory, prepare integration. This is the umbrella closeout ritual that invokes the child skills below. | `.agents/skills/land/` |
| **Significant-work closeout** | When a milestone, major feature, or large refactor closes — produce an as-built and purge the scaffolding. Default expectation is **yes, write one**. | `.agents/skills/writing-as-built/` |
| **End-of-milestone retrospective** | At milestone close, AFTER the as-built + roadmap update + tabled.md processing are done. Running it last means the retro can reflect on the closeout activities themselves (e.g., "the as-built surfaced a doc drift we hadn't noticed"), not just the milestone work. Four sections (keep doing / stop or change / promote to artifact / commit to memory) with concrete owned action items. | `.agents/skills/writing-retros/` |

## Skill inventory and use

Project-local and imported skills live under `.agents/skills/`. Use them by name in conversation and cite the path when making durable docs changes.

| Skill | When Team Room uses it |
|---|---|
| `using-superpowers` | Session orientation for the imported Superpowers skill set and its expectations. |
| `brainstorming` | Early design framing and problem exploration before writing specs/plans. |
| `test-driven-development` | Implementation work where behavior can be driven by tests first. |
| `executing-plans` | Carrying out an approved implementation plan task-by-task. |
| `requesting-code-review` / `receiving-code-review` | Review loops during implementation and before landing. |
| `systematic-debugging` | Root-cause investigations, especially flaky tests, integration failures, and surprising runtime behavior. |
| `verification-before-completion` | Final validation before declaring work complete. |
| `finishing-a-development-branch` | Branch hygiene near the end of implementation, before or alongside `land`. |
| `land` | Umbrella closeout process for a meaningful cycle or branch. In Team Room, it coordinates review, as-built, tabled-item processing, roadmap/status updates, retro, and integration readiness. |
| `epiphany-tabling` | Capture useful out-of-scope thoughts in `docs/tabled.md` without derailing current work. |
| `capturing-learnings` | End-of-artifact checkpoints and deciding whether observations become skills, runbooks, memory, roadmap, or are dropped. |
| `writing-as-built` | Permanent record of what shipped; supersedes in-flight specs/plans at close. |
| `writing-retros` | Milestone retrospective after as-built/roadmap/tabled processing. |
| `using-git-worktrees` | Worktree setup and branch isolation when needed. |

The Superpowers-derived skills are most useful during initial planning, implementation, code review, debugging, verification, and branch finish. Team Room's project-local closeout practices (`land`, `capturing-learnings`, `writing-as-built`, `writing-retros`, `epiphany-tabling`) remain the authoritative landing path for this repository.

## Document inventory

Current set of document categories. Add a row when a new role emerges; merge and remove when a role consolidates. Paths are relative to the repo root.

| Location | Memory type | Role | Freshness |
|---|---|---|---|
| `team-room-context.md` | Episodic | Original brainstorming snapshot; historical reference. | Frozen — superseded content goes in specs. |
| `docs/roadmap.md` | Semantic | Living milestone roadmap. Supersedes `team-room-context §7`. Updated at every milestone close. | Update at each milestone close; reorder "Future" rows when learning demands it. |
| `docs/ways-of-working.md` (this doc) | Procedural | Practices for building Team Room. | Update when practices evolve; note the date at top. |
| `docs/tabled.md` | Working | Single working-memory scratch pad — epiphanies, tabled follow-up items, anything noticed mid-task that we don't want to chase right now. At milestone close: outstanding items worth keeping roll into `docs/roadmap.md#backlog`; completed/obsolete items are dropped; the file ends each milestone empty (or near-empty). | Always in place; entries added/removed continuously; processed at milestone close. |
| `docs/specs/YYYY-MM-DD-*-design.md` | Semantic | **In-flight** designs for the active milestone. Purged into the as-built at milestone close; the folder is empty between milestones (retains `.gitkeep`). | Live during design → implementation; removed at close. |
| `docs/plans/YYYY-MM-DD-*-plan.md` | Semantic | **In-flight** implementation plans. Purged into the as-built at milestone close; the folder is empty between milestones (retains `.gitkeep`). | Live during implementation; removed at close. |
| `docs/as-built/YYYY-MM-DD-<topic>.md` | Semantic + Episodic | **Permanent** record of shipped work — architecture, decisions with WHY, adaptations, known limitations. Written via the `writing-as-built` skill at the close of any significant piece of work (milestone, major feature, large refactor). Default expectation: one as-built per piece of closed work. | Frozen at commit; never edited. |
| `docs/retros/YYYY-MM-DD-<milestone>.md` | Episodic | Milestone retrospectives. | Frozen at milestone close. Narrow exception: stale paths/links may be corrected when leaving them broken would mislead future agents; do not rewrite conclusions or process history. |
| `docs/runbooks/*.md` | Procedural | Operational procedures (e.g., "add a new agent," "add a new channel"). | Kept current — runbooks rot fast; check on use. |
| `README.md` (repo root and folder-level) | Semantic | Orientation and navigation; anchors for the knowledge graph. | Update when a folder's shape changes. |
| `AGENTS.md` (repo root; may also appear per-agent) | Procedural | Standing instructions to AI assistants working in this repo or on this agent. Model-agnostic (Claude reads it, others do too). | Update when standing instructions change. |
| `docs/memory/*.md` (index at `MEMORY.md`) | Cross-cutting | Recurring user preferences and project context, in-repo so they are visible to git, the user, and any AI agent. Replaces the prior Claude-private auto-memory location. | Update or remove as context shifts; announce writes in conversation. |

**Proliferation test** before creating any new markdown file: does the content belong in one of the above? If yes, extend. If no, justify the new category explicitly and add a row in the same change. The inventory is load-bearing — it's how the knowledge base stays navigable. (Mechanics in the `capturing-learnings` skill.)

## Capturing learnings

Learnings turn into durable artifacts — skills, runbooks, memory entries, as-builts — or they turn into nothing. Four artifact types carry them forward:

- **Skills** — tactical, reusable how-tos. Live in `.agents/skills/<name>/` for project-local or imported skills, or in a marketplace for cross-project skills.
- **Runbooks** — broader processes or practices that may compose multiple skills. Live in `docs/runbooks/`.
- **Memory entries** — recurring preferences, constraints, or project context that survive across conversations. Live in `docs/memory/`.
- **As-builts** — permanent records of shipped work. Live in `docs/as-built/`.

**The promotion rule: once is a moment; twice is a pattern.** Don't formalize on first occurrence. Premature formalization has the same cost structure as premature abstraction in code. Wait for the second sighting, then capture.

The mechanics of the end-of-artifact checkpoint, the skill-vs-runbook heuristic, and the proliferation test live in the `capturing-learnings` skill (`.agents/skills/capturing-learnings/`).

## Working with subagents for Team Room delivery

Project-local addenda that sit *around* the upstream `superpowers:writing-plans` and `superpowers:subagent-driven-development` skills — not replacing them. Read alongside those skills whenever a plan is being written or subagents are being dispatched. Each item cites the M4.5 sighting that promoted it.

- **Bundling pass after a plan is written.** Before dispatching subagents, group same-shape, same-review-surface plan tasks into execution groups. Bundling cuts reviewer dispatches without sacrificing rigor when groups are thematically tight. *(M4.5 retro §3 — 38 plan tasks reduced to 24 dispatched groups.)*
- **Grep the publisher before specifying the subscriber.** When a plan task defines a bus-event subscriber, locate the publisher first and verify the event name + payload shape. Pattern is general: read the producer before specifying the consumer. *(M4.5 retro §2 — Group 13 plan specified a `mail.delivered` subscription; the dispatcher actually publishes `channel.cli.out` for channel recipients.)*
- **Flag spec assertions about infrastructure as check-before-implementing items.** When a spec claims "this requires X infrastructure change," treat it as a hypothesis to verify during plan writing, not a commitment to implement. Carry it as a check-before-implementing item in the plan. *(M4.5 retro §2 — spec described migration 004 as TS-extended migrator; plan-writing discovered plain SQL + SQLite JSON1 was sufficient.)*
- **Inline follow-up commits per review.** When a subagent review surfaces Important items, fix them in a follow-up commit *immediately*, before dispatching the next group. Do not accumulate a review backlog. Keeps per-group state clean and as-builts honest. *(M4.5 retro §1 — every group of M4.5.)*
- **Combined spec + code review once a pattern is well-established.** After several groups have executed the same shape cleanly, combine spec and code reviews into a single subagent dispatch to save a round-trip. Revert to separate reviews if a group introduces a novel pattern or touches unusual surfaces. *(M4.5 retro §3 — Groups 15 onward.)*

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
- **Doc updates as follow-up rather than part of the change.** When a change invalidates a README, a root doc, a `.env.example`, or any cross-reference, the doc update is part of the *same* change — not a later cleanup. In M1 both the root README and `agent-runtime/README.md` drifted to reference Anthropic after the LM Studio pivot; both were caught by the README-convention pass, but they should have been caught at pivot time. The discipline: if a change invalidates a doc, the doc update lands in the same commit (or the same PR at minimum).
