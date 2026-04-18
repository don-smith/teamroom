---
name: Team Room — pre-execution plan review discipline
description: Before approving any implementation plan for execution, both Claude and the user dry-run each test/impl pair mentally and explicitly confirm the plan is complete; catches drifts that otherwise surface as implementer rework
type: feedback
---

Before approving any implementation plan for execution, both Claude **and** the user read and dry-run each test/impl pair mentally. Check for plan-level gaps explicitly — config/secrets handling, test layout, deployment-asset flows (migrations, static files), cross-task identifier consistency, API/SDK shape against actual current types. Then explicitly confirm "the plan is complete and ready to execute" before the first subagent dispatches.

**Why:** During M1 execution, at least seven plan drifts surfaced that a careful pre-execution read would have caught — FileNotifyBus chokidar-ready race, FileNotifyBus close-doesn't-wake-resolvers, FileNotifyBus type-import namespace, `buildDockerRunArgs` test/impl env-order inconsistency, `parseEvent` spread ordering, `processTurn` genId collision, Anthropic SDK `TextBlock` type narrowing, `.gitignore` `.gitkeep` exception. Implementer subagents caught each in-flight, but the fallback isn't a substitute for the discipline. User self-identified missing this review as the root cause of the test-layout drift specifically.

**How to apply:**
- Insert the review as an explicit step between "writing-plans" and "executing-plans."
- Both the user and Claude own the review — not a single-party sign-off.
- Look for: assumptions about external-SDK shape that haven't been verified; tests that contradict each other or the impl; missing config/secrets handling; missing build-asset copy steps; glob/ignore rules that can't actually work; cross-task identifier or env-var drift.
- When in doubt, dry-run the plan against the actual current state of the repo (open the files, check the SDK version, confirm the glob works) rather than against how the plan imagines things are.
- Promote to a skill if a second milestone surfaces drifts that a sharper review would have caught — current state is "inline rhythm in docs/ways-of-working.md"; the second sighting moves it into `.claude/skills/pre-execution-plan-review/`.
