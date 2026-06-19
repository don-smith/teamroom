# Telegram Channel Gateway Retro

*Date: 2026-06-19. Frozen at commit. Future amendments go into a new retro.*

## 1. Keep doing

- **Plan-first, phase-by-phase execution.** The plan artifact with 4 ordered phases, each with explicit success criteria, made execution straightforward. Phase 1 had to land before Phase 2 (structural blocker), and the plan's ordering constraints were respected. Each phase was verified (tests passing, stale-reference grep) before moving to the next.
- **Inline post-edit verification.** After writing new files (`telegram-config.ts`, `telegram-gateway.ts`), running just the relevant test file (`src/gateways/telegram-config.test.ts`) before the full suite caught config issues fast. The config loader tests passed on first run.
- **Plan review table caught real issues.** The artifact-code-reviewer's findings in the plan (missing `grammy` in package.json, missing `composeTelegram` export, unused `HttpError` import) were all fixed during plan generation. No plan-review findings leaked into implementation.
- **Single-file focus for Phase 3.** All 7 voice-pipeline edits landed in one file (`telegram-gateway.ts`). Kept the change surface small and testable.
- **Used existing codebase patterns.** The config loader followed `mailing-lists/loader.ts`. The factory function followed `composeMcpMail` / `composeChannels`. The daemon section insertion followed the existing section-numbering pattern. No new patterns introduced.
- **Structured process gives flexibility to fix.** The MyFlow phase pipeline (plan → implement → verify → land) gave us the confidence to extend scope mid-flight. When verification found the `replyExpected` bug, `bot.start()` hang, and TTS upload issue, we didn't panic — we knew exactly where we were in the process and how to finish it. The phase structure provides a container for discovery-driven fixes without derailing the branch.

## 2. Stop or change

- **Manual end-to-end verification must happen before closeout — second occurrence.** We reached the retro stage and realized we hadn't actually run the daemon with real Telegram credentials to verify the gateway works. This is the second time this has happened (M5 retro also flagged verification gaps). We stopped, ran manual verification, and found three blocking issues (reply expectation, bot.start() hang, TTS upload format) that no automated test would have caught. The closeout almost shipped non-functional code.
  **Change:** The verification stage must include a manual end-to-end test with real external services before land begins. Add a mandatory checkbox or process gate: "Has the feature been verified against live external dependencies?" If not, verification is not complete. This is load-bearing for any branch that integrates with real third-party services (Telegram, OpenAI, etc.).
- **Read previous retro before drafting — catch recurring patterns.** The Land skill says to read the previous retro before drafting, and I did read M5's retro. But I missed picking up the "verification before closeout" pattern from it in this cycle's retro. Reading alone isn't enough — the retro should explicitly call out whether each recurring pain point from the previous retro was addressed or reappeared this cycle.
  **Change:** When reading the previous retro, extract its action items and failure modes, then check each against the current cycle before writing. Surface "same issue again" items prominently in the new retro. (Applicable to the agent side of the process — human and agent share responsibility for this cross-cycle thread.)
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
| 3 | Add "manual end-to-end verification against live external services" as a mandatory gate in the closeout/land process — check before any retro is drafted | next milestone planning | before M5.1 closeout |
| 4 | When reading the previous retro, explicitly check each of its action items and failure modes against the current cycle and surface recurrences in the new retro | each retro session | next retro |