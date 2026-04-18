---
name: writing-as-built
description: Use when wrapping up a significant piece of work (milestone, major feature, large refactor) to produce the single permanent artifact — an as-built doc — and purge the scaffolding (spec + plan) that got us there
---

# Writing an As-Built

## Overview

Specs and plans are scaffolding. The **as-built** is the permanent high-signal record of what actually shipped. When the work closes, we write one as-built, then purge the spec and plan. Git history preserves the scaffolding; the repo stays small and the as-built is the document future-us actually reads.

**Announce at start:** "I'm using the writing-as-built skill to produce the as-built for `<topic>`."

## Why we write as-builts

An as-built is the place a future agent or human goes when they are curious about an episodic change — "what actually shipped in M1, why, and what changed from the intent?" It sits at the crossing of semantic, episodic, and historical context:

- **Semantic** — the permanent description of what the code now is and why it is that shape.
- **Episodic** — a dated record of the piece of work that produced it.
- **Historical** — the adaptations and drifts from spec/plan, preserved so future readers understand anti-regression reasoning rather than re-discovering it the hard way.

The signal-to-noise ratio is the whole point. Specs are long and speculative; plans are long and mechanical; retros focus on process. The as-built is short, high-signal, and durable — the first thing a new agent should read to orient on a body of shipped work.

## When to Use — default is yes

**Default expectation:** whenever we finish a piece of work, we write an as-built. This is especially true when:

- A spec and/or plan exist for the work (they will be purged — an as-built is their replacement, not an optional successor).
- A retro is being written (retros and as-builts are complementary: the retro captures how we worked; the as-built captures what we built).
- A milestone closes.
- A major feature ships.
- A large refactor lands.

**Skipping is an explicit, negotiated decision — not a default.** If the assistant or the user believes the change is too small to warrant an as-built (e.g., a few README edits are sufficient to capture the shape of the change), that call is made explicitly in conversation before closing the work. Absent that explicit conversation, produce an as-built.

## Inputs

Gather all of these before writing:

- The design spec (`docs/specs/YYYY-MM-DD-<topic>-design.md`) — plus any in-flight amendments.
- The plan (`docs/plans/YYYY-MM-DD-<topic>-plan.md`) — distill, don't copy.
- `docs/tabled.md` — especially any plan drifts processed during execution.
- The retro, if one exists (`docs/retros/YYYY-MM-DD-<milestone>.md`).
- Git log for the branch, from plan-landed to close: `git log --oneline <plan-sha>..HEAD`.
- Current code state (read the actual files as they are now, not as the spec says they will be).

## Output

One file: `docs/as-built/YYYY-MM-DD-<topic>.md`. Frozen at commit.

## Structure

```markdown
# <Topic> — As Built

*Date: YYYY-MM-DD. Frozen at commit. Future changes happen in a new as-built, not here.*

## 1. What was delivered

One or two paragraphs. Name the shipped capability. Reference exit criteria from the spec
and confirm they were met (or document what shifted).

## 2. Architecture as built

Describe what actually exists in the repo now:

- Processes and their lifecycles.
- Boundaries (host vs. container, inter-process, inter-module).
- File/directory layout (point at real paths).
- Data model (tables, schemas, event shapes).
- Contracts between moving parts.

The spec said what we intended. This section says what the code now does. Where they
diverge, the as-built wins and the spec is retired.

## 3. Key design decisions and their WHY

Bulleted list. Each decision gets:
- The decision itself.
- **Why:** the reason — usually a constraint, a prior incident, a principle, or a
  stakeholder ask. Preserved so future readers understand anti-regression reasoning.

This section is the most valuable part of the doc. Readers in six months will read
this list before they touch the code.

## 4. Adaptations during execution

What we thought we were building vs. what we built. Pivots, plan drifts, scope changes,
renamed concepts. Each item:
- What changed.
- Why it changed.
- Where in the code the change landed (file paths, if useful).

Pull these from `tabled.md` (processed drifts), the retro's "stop or change" and
"spec amendments" sections, and your own reading of the git log.

## 5. Known limitations and debts for future work

What isn't done or isn't clean. Flag explicit debts so the next milestone's planning
can pick them up deliberately rather than stumbling over them. Link to the source of
each item (retro section, tabled entry, subagent review comment).
```

## Process

1. Read all inputs listed above.
2. Draft the as-built top to bottom. Keep each section tight — this is a reference
   document, not a narrative.
3. For §2 "Architecture as built," open the actual files before describing them. The
   spec might say X; the code might say Y. Describe Y.
4. For §3 "Key design decisions," pull WHY explicitly — a decision without a reason
   becomes a candidate for removal the next time someone touches it.
5. Save to `docs/as-built/YYYY-MM-DD-<topic>.md`.
6. Commit the as-built on its own so it's reviewable.

## Post-action: purge the scaffolding

After the as-built is committed and the user has reviewed it:

1. `git rm docs/specs/YYYY-MM-DD-<topic>-design.md`
2. `git rm docs/plans/YYYY-MM-DD-<topic>-plan.md`
3. Ensure `docs/specs/.gitkeep` and `docs/plans/.gitkeep` exist so the folders survive.
4. Commit the purge as a separate commit with message
   `docs: purge <topic> spec+plan; superseded by as-built`.

Git history retains every version of the spec and plan. The working tree stays small
and the as-built is the single source of truth for shipped work.

## Freshness

The as-built is **frozen at commit**. If the architecture changes later, write a new
as-built (or fold the change into the next milestone's as-built) — do not edit this
one. Episodic + semantic: it records both what we shipped on a date and the knowledge
that informed it.
