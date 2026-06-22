---
name: Team Room — agent runtime changes require live manual verification
description: Unit tests are not sufficient for changes to container mounts, skill prompts, mail tools, daemon startup, or chat UX — live validation must be run before closeout
type: project
---

Changes to agent runtime behavior — container mounts, skill prompts, mail tool contracts, daemon startup, chat UX — cannot be fully verified by unit tests alone. A live manual verification (smoke test) must be run before milestone closeout, with rebuilt agent images and a restarted daemon.

**Why:** The persona realignment cycle shipped without a smoke test and the missing step was flagged in the retro. The MyFlow agent onboarding cycle ran live Archie/Libby validation and caught real issues: Docker cleanup hanging silently on startup, stale chat port files producing bad CLI errors, and DeepAgents mail reply JSON corruption. These would not have surfaced in unit tests.

**How to apply:**
- Before declaring a milestone done, run the smoke test from `docs/runbooks/smoke-test.md` with freshly rebuilt agent images.
- Treat live validation failures as blocking — fix before closeout, or explicitly table with a documented decision.
- The checklist in the smoke-test runbook covers: daemon startup, agent mail round-trips (all 4 agents), chat UX, and proxy span verification.
- When the change touches DeepAgents agents (Libby, Archie), validate mail replies specifically — malformed JSON fallback paths are runtime-only.
- Image rebuild and daemon restart prerequisites must be listed before verification begins so runtime fixes are tested in the intended environment.