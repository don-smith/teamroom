---
name: Team Room — integration harnesses and prod composition must share their wiring shape
description: When a test harness manually wires subscriptions/resolvers/mounts that prod composition also needs, extract a shared builder or add a composition-snapshot test. Deferred wiring in a "future work" comment is the exact bug 100% green test suites miss
type: feedback
---

When a subsystem is composed of multiple pieces that need to be explicitly wired together (bus subscriptions, token resolvers, mount lists, port files, etc.), the **integration test harness** and the **production composition** must share their wiring shape — either literally the same code, or verified by a snapshot-style test that asserts every expected wire is present in the prod builder's output.

If the two diverge — even temporarily, with a `// future work` comment — unit and integration tests can be 100% green while the production path is broken.

**Why:** During M4 execution (agent mail), Task 11's daemon composition deliberately left the `SessionTimerManager` unwired to the bus:

```ts
// The MCP server's tokenResolver will be wired up when the session
// manager is in place (future work); for now resolve to null
```

268 tests passed because `composeIntegrationHarness` (the test harness) wired the subscriptions correctly — but `startDaemon` did not. First manual test (CLI → agent → reply) found the bug in ~30 seconds: `mail.delivered` fired on the bus, no subscriber existed, no container was ever spawned. The gap was invisible to the suite entirely.

This is a different failure mode from the one `tsconfig.test.json` catches (fixture drift on data types). That failure mode is "the shape changed and a fixture forgot to update"; this one is "the wiring is underspecified and drifted between two callers." Both are parity problems; both need a structural mitigation, not a vigilance one.

**How to apply:**

- **For any subsystem wired in both a test harness and a prod composition**, prefer extracting a shared `composeFooStack(deps)` builder. Test harness and prod entrypoint both call it. Differences (e.g., FakeRunner vs. DockerRunner) are passed as `deps`, not as divergent wiring.
- **When a shared builder is hard to extract cleanly** (e.g., due to lifetime or teardown differences), add a composition-snapshot test: assert that `startDaemon`'s output has the expected bus subscriptions, registered endpoints, written files. A dumb "here are the subscribed event types" assertion is enough — the goal is to catch divergence, not enforce a perfect shape.
- **Never ship a `// future work` comment in composition code** without either an immediate test that would catch the missing wiring, or a loud `throw new Error("not wired")` at the point of use. A silent `() => null` resolver is the same foot-gun as `TODO`.
- **At code review time**, if a PR adds wiring to a harness that doesn't appear in `startDaemon` (or vice versa), flag it. Diff both callers together, not separately.

**Source:** M4 manual-test bug surface, 2026-04-20. Commit `39c3b9e` retrofit; M4 retro §2; M4.5 action items in `docs/m4-followups.md §15a` and §15b.
