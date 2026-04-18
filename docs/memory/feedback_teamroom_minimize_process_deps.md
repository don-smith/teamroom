---
name: Team Room — minimize long-running process dependencies
description: For Team Room, prefer designs where the long-running orchestrator has no dependencies on other long-running processes
type: feedback
---
For Team Room, prefer designs where the long-running orchestrator process has no runtime dependencies on other long-running processes (databases, message brokers, caches, etc.). In-process / embedded alternatives (e.g. SQLite over Postgres) are preferred when they can credibly do the job.

**Why:** User stated 2026-04-18 during M1 brainstorming: "I would like to try to avoid the long-running process taking any dependencies on other running processes if we can get away with it." Solo-dev ergonomics and ops simplicity matter more than scaling hypotheticals at this stage.

**How to apply:**
- When evaluating infrastructure choices (DB, event bus, cache, queue), prefer in-process/embedded options first. Reach for out-of-process only when the in-process option genuinely can't do the job.
- When a choice is close, weight "no separate process to run" heavily.
- Does not preclude Docker/containers for *agent turns* (those are short-lived, not long-running dependencies).
- Revisit if/when the product genuinely outgrows the embedded option — don't preemptively introduce external services.
