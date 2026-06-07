---
name: land
description: Use at the end of a major piece of work to bring the cycle to a clean close — review the work, document what changed, capture lessons, and prepare for the next cycle
---

# Land

Bring the current piece of work to a clean close. Review what was built, document what changed, capture lessons, and leave the codebase ready for the next cycle.

## When to Use

- a design phase is complete and agreed
- an implementation plan has been fully executed and verified
- a significant milestone has materially changed project state
- before starting the next meaningful piece of work

## When Not to Use

- mid-work checkpoints
- small fixes that do not materially change project shape
- session endings where the work is not at a natural boundary

## The Process

Land has 10 ordered sub-steps. Each sub-step is a conversation between agent and human, not unilateral execution.

See [`docs/ways-of-working.md`](../../../docs/ways-of-working.md) for the canonical lifecycle description.

Hard ordering rules:

- reviews happen before documentation closeout
- the as-built is written before the spec/plan scaffolding is purged
- the retro is written last, after as-built, roadmap/status updates, and tabled-item processing

### 1. Code Review

Review all code that landed during the cycle. Fix small issues now. Capture larger follow-ups in `docs/tabled.md`.

### 2. Architectural Review

Review the structural consequences of the work. Look for new patterns, stress points, and architectural drift.

### 3. Security Review

Review the security implications of the work and capture anything substantive before closeout.

### 4. As-Built Documentation

Capture what changed and why in `docs/as-built/YYYY-MM-DD-<topic>.md` using the `writing-as-built` skill. The as-built is the permanent source of truth for shipped work and supersedes the in-flight spec/plan.

### 5. Doc / Knowledge-Graph Review

Review touched docs for truthfulness, signal, and navigability. Add or refresh README files only where they clearly help.

### 6. AGENTS.md Updates

Update `AGENTS.md` only where the current repo entrypoint truly changed.

### 7. Memory Reconcile

Review `docs/memory/MEMORY.md` and any referenced entries for stale or duplicated pointers. Announce memory writes before changing `docs/memory/`, per `AGENTS.md`.

### 8. Roadmap + Tabled Items + Next Piece of Work

Review `docs/roadmap.md` intentionally. Resolve every item in `docs/tabled.md` by either:

- deciding it now and removing it
- moving its substance into `docs/roadmap.md#backlog`
- capturing it durably elsewhere and removing it
- consciously leaving it tabled with a clear next destination

Then identify the next piece of work.

### 9. Retro

Write a retro in `docs/retros/YYYY-MM-DD-<milestone>.md` using the `writing-retros` skill.

Start by reading the previous relevant retro in `docs/retros/`. Review the draft with the user before committing because retros are frozen episodic records.

### 10. Integrate

If on a feature branch, handle merge or PR closeout deliberately.

If on `main`, stage the closeout changes and present a grouped summary for review before committing.

For Team Room milestone branches, normal integration readiness means: validation is recorded, the as-built is committed, the spec/plan are purged in a follow-up commit, the roadmap points at the as-built, `docs/tabled.md` has been processed, and the retro is committed last.

## Key Principles

- each sub-step is a conversation
- child skills own detailed execution for their own domain
- closeout docs live under `docs/as-built/` and `docs/retros/`
- every cycle should leave the next agent with clear status and navigation

## Anti-Patterns

- merging before closeout is complete
- treating sub-steps as checkboxes instead of review points
- carrying stale tabled items forward indefinitely
