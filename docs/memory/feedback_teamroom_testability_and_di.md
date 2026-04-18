---
name: Team Room — design for testability via dependency injection, not mocks
description: For Team Room, testability is an architectural concern — every effectful dependency goes behind an interface with a DI-injected real test implementation; prefer in-memory real implementations over mocking libraries
type: feedback
---
For Team Room, testability is treated as an architectural concern and dependency injection is the preferred pattern. Every effectful dependency (DB, HTTP/LLM, container spawner, filesystem, bus, clock) lives behind a small interface that the daemon composes at startup. Tests compose the same interfaces using **in-memory real implementations**, not mocks. The contract between code-under-test and production is identical to the contract between code-under-test and the test harness.

**Why:** User stated 2026-04-18 during M1 brainstorming: "my preference is to not use mocking, but rather to use dependency injection as a pattern so that we can inject test dependencies in and test those knowing that the contract is the same as the code under test under normal production scenarios." User is explicit that "to have a good testing strategy you have to have code that was designed to be tested in particular ways" and that "we'd rather not paint ourselves in a corner by trying to tack on tests onto a code base that wasn't designed very well to be tested." Testing is treated as a marker of health.

**How to apply:**
- Every effectful module exposes an interface; the concrete (production) implementation is one of several possible. Tests instantiate a real in-memory alternate implementation.
- Preferred concrete test implementations: SQLite `:memory:` for DB, in-process EventEmitter (or similar) for `NotifyBus`, a fake `ContainerRunner` that returns scripted stdout, a controllable `Clock`.
- Avoid `jest.mock`, `vi.mock`, or other module-level mocking. If you feel like reaching for it, the code under test is probably too coupled to the real dependency — fix the seam instead.
- The daemon has a single "composition root" where dependencies are wired. Tests wire the same root with test implementations.
- CLI-tier code should be thin — arg parsing + delegation to services. Logic lives in services that are covered by unit tests via their interface. The CLI itself typically doesn't need direct tests.
- "Unit vs integration" stops being an interesting line — because DB is in-memory and containers are fakes, integration tests run at unit-test speed.
- Real external calls (Anthropic API, real Docker, real files on disk) live only in a small set of explicitly-marked smoke tests that do not run in CI.
- End-to-end tests with a real agent are deferred; user expects they may become a component of the eval system in a later milestone.
- Coverage is not the goal. Good architecture that produces well-tested seams is the goal.
- **Test layout:** co-locate unit tests with their source as `src/<module>/<file>.test.ts`. Reserve `tests/integration/` for cross-module end-to-end tests. Vitest's default glob picks up both; `tsc` excludes `**/*.test.ts` from the production build. Adopted late in M1 after `tests/unit/...` proved noisy during module moves — co-location keeps refactors local.
