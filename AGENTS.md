# AGENTS.md — Standing instructions for AI assistants working on Team Room

Read in this order when joining a session:

1. `docs/ways-of-working.md` — how we build Team Room (reflection rhythms, knowledge base model, memory-type mapping, document inventory).
2. `docs/specs/2026-04-18-teamroom-m1-design.md` — current milestone design.
3. `docs/plans/2026-04-18-teamroom-m1-plan.md` — current implementation plan and progress.
4. `docs/tabled.md` — tabled epiphanies awaiting processing.

## Principles locked in the M1 spec

- **Deliberate coupling and extensibility.** State what is shared vs. isolated for every boundary.
- **Minimize long-running process dependencies.** Prefer in-process / embedded over separate services.
- **See only as far as needed, not further.** Formalize at N=2, not N=1.
- **Nothing silent, nothing inconsistent, nothing crashes.** Global safety nets in the daemon; containers run to completion or the daemon kills them.
- **Design for testability via DI.** Every effectful dependency behind an interface; tests use in-memory real implementations, never `vi.mock` / `jest.mock`.

## Working practices

- **Epiphanies** are tabled to `docs/tabled.md`, not pursued mid-task.
- **Once is a moment; twice is a pattern.** Don't formalize on first occurrence.
- **Proliferation test** before creating new markdown files: does the content fit in an existing doc?

## Language and style

- TypeScript strict mode. `any` is a smell.
- Small files, one responsibility each. Interfaces at the boundary.
- Every module under `src/` has an entry file matching its folder name (or `index.ts` only if that reads better in context).
