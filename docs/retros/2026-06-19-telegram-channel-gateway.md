# Telegram Channel Gateway Retro

*Date: 2026-06-19. Frozen at commit. Future amendments go into a new retro.*

## 1. Keep doing

- **Plan-first, phase-by-phase execution.** The plan artifact with 4 ordered phases, each with explicit success criteria, made execution straightforward. Phase 1 had to land before Phase 2 (structural blocker), and the plan's ordering constraints were respected. Each phase was verified (tests passing, stale-reference grep) before moving to the next.
- **Inline post-edit verification.** After writing new files (`telegram-config.ts`, `telegram-gateway.ts`), running just the relevant test file (`src/gateways/telegram-config.test.ts`) before the full suite caught config issues fast. The config loader tests passed on first run.
- **Plan review table caught real issues.** The artifact-code-reviewer's findings in the plan (missing `grammy` in package.json, missing `composeTelegram` export, unused `HttpError` import) were all fixed during plan generation. No plan-review findings leaked into implementation.
- **Single-file focus for Phase 3.** All 7 voice-pipeline edits landed in one file (`telegram-gateway.ts`). Kept the change surface small and testable.
- **Used existing codebase patterns.** The config loader followed `mailing-lists/loader.ts`. The factory function followed `composeMcpMail` / `composeChannels`. The daemon section insertion followed the existing section-numbering pattern. No new patterns introduced.

## 2. Stop or change

- **Verify `bun install` on fresh worktrees before diagnosing failures.** When I reported "8 pre-existing test failures," it was actually just missing `node_modules` on the fresh worktree. The investigation cost some time and doubt. Protocol: on a fresh worktree or clone, run `bun install` before any test run; if tests fail, check `node_modules` before assuming real failures. (This is the first fresh worktree on this project, so this is the first sighting — add a runbook entry or worktree-setup step.)
- **Run targeted test files during phased changes, not just at the end.** The `channel.out` subscriber-count test in Phase 4 failed only when running the full suite — the assertion used `toBe(beforeChOut - 1)` but couldn't account for other bus subscribers cleaned up during `daemon.stop()`. Had I run the daemon test file after the Phase 4 edit, I'd have caught this immediately rather than in the full-suite pass.
- **Edit tool double-escaping hazard.** The first `channels.ts` edit produced garbage text (`registry.register( registry.register(\"telegram");"}])` due to escaping issues in the edit call. This corrupt state broke all subsequent test runs until caught and fixed. Action: when constructing `edit` calls with nested quotes, test the edit on a small unique oldText first, or use `write` for multi-line replacements where escaping is error-prone.

## 3. Promote to artifact

- **"Fresh-worktree bootstrap" as a runbook step.** First sighting. Worktree was created but `bun install` wasn't run. The immediate symptom was 8 mysteriously failing tests that all resolved after install. Candidate: add a verification step to the `using-git-worktrees` skill or equivalent — "after creating a worktree, confirm `bun install` has been run (or run it) before making changes."

- **Edit-tool escaping awareness for quote-heavy TypeScript edits.** First sighting (the `channels.ts` corruption). The edit tool's oldText/newText are JSON-stringified, so nested quotes require careful escaping. When editing a file that contains string literals with escaped quotes, consider using `write` for the replacement region or reading the exact bytes first. Worth noting in the project's memory or ways-of-working as an operational hazard.

- **"Phase-by-phase plan execution with per-phase verification gates"** as a pattern. Not a new pattern (M5 and earlier already did this), but this branch demonstrated the model clearly: 4 phases, each with success criteria, each verified before proceeding. The plan artifact itself was the implementation tracker — phases marked approved at generation, implemented in order, verified before next phase. This is the core value proposition of the plan artifact.

## 4. Commit to memory

- **No new memory entries.** All observations from this cycle are either process notes (fresh-worktree bootstrap, edit-tool escaping) or reinforce existing patterns (plan-before-implement, per-phase verification). The "channel.out event generalization" is documented in the as-built. The daemon section-6 wiring pattern follows existing conventions.

## Action items

| # | Outcome | Owner | When |
|---|---|---|---|
| 1 | Add "after creating a worktree, run `bun install`" to worktree-setup guidance (runbook or skill) | next worktree usage | before next worktree-based change |
| 2 | Document edit-tool escaping hazard for multi-level quote scenarios in ways-of-working or project memory | next session | before next edit-heavy change |