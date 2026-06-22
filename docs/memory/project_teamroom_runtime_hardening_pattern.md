---
name: Team Room — runtime hardening: bounded cleanup, actionable CLI errors
description: Best-effort daemon startup operations must be bounded with timeouts, log failures loudly, and never silently block; interactive CLIs must preflight connectivity and report human-actionable errors
type: feedback
---

Runtime hardening pattern for daemon and CLI: (1) best-effort startup operations (Docker cleanup, health checks) should be bounded with short timeouts, log failures audibly, and never silently block the daemon from starting; (2) interactive CLIs should preflight connectivity before constructing protocol-level objects and report failures in human-actionable terms (e.g., "is the daemon running?") instead of letting low-level errors escape.

**Why:** Live validation during MyFlow agent onboarding revealed two concrete failures:
- `src/container/kill-stale.ts` could hang indefinitely on `docker ps` when Docker Desktop was unhealthy, silently blocking daemon startup and leaving stale port files.
- `src/cli/chat.ts` would crash with a raw WebSocket `ErrorEvent` when connecting to a dead daemon at a stale port, giving no actionable guidance.

The fixes (3s timeout + `kill-stale.list-failed` log; TCP preflight + human-readable error) established a pattern that applies to any future best-effort startup operation or CLI surface.

**How to apply:**
- Any daemon startup operation that is "best-effort" (not load-bearing for core function) must (a) have a timeout, (b) log a distinct failure event when it times out or fails, and (c) never prevent the daemon from reaching a ready state.
- Any interactive CLI surface that depends on a running daemon must preflight connectivity and report failures in terms the user can act on ("is the daemon running?") rather than leaking raw protocol errors.
- Tests for daemon composition must inject no-op substitutes for real Docker operations so the test suite does not depend on a running Docker daemon.
- When adding a new CLI surface or daemon startup step, apply this pattern proactively — don't wait for a live-validation failure to discover the gap.