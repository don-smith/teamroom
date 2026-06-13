# Running tests

The default `bun test` suite spans both fast in-memory seam tests (SQLite `:memory:`, `EventBus`, `FakeRunner`) and the repo's real-provider integration tests under `tests/integration/`. The integration tests fail loudly when LM Studio or Anthropic credentials are absent; use targeted file/pattern runs while iterating on an isolated seam, then return to the full suite before calling work done.

## Preconditions

- Bun 1.3+ installed.
- `bun install` has run in the repo root (look for `node_modules/`).
- For the full suite: `.env` populated with `LM_STUDIO_API_TOKEN`, LM Studio running with a model loaded, and Anthropic credentials discoverable. Those same preconditions are described in [`smoke-test.md`](smoke-test.md) and [`anthropic-auth.md`](anthropic-auth.md).
- You are on the branch you expect; no stray uncommitted files that shouldn't be in scope.

## Steps

1. Run the full suite once:
   ```bash
   bun test
   ```
   Expected: all unit/module tests and the real-provider integration tests pass.

2. For TDD or to leave it running while you edit:
   ```bash
   bun test --watch
   ```
   Bun re-runs on file save. Press `q` to quit.

3. To run a single file or pattern:
   ```bash
   bun test src/daemon/turn-processor.test.ts
   bun test -t "reconciles orphaned"
   ```

4. To run integration tests only:
   ```bash
   bun test tests/integration
   ```

## Verifying success

- Bun exits `0` and reports every test file passing.
- The fast in-memory files should still finish quickly; the real LM Studio / Anthropic integration tests take materially longer because they make live upstream calls.
- `bun run typecheck` passes.

## Troubleshooting

- **`LM_STUDIO_API_TOKEN missing from .env` or `LM Studio not reachable ...`** The full suite includes `tests/integration/lm-studio-real.test.ts`. Fix the environment, or run a targeted file while you iterate on an unrelated seam.
- **`no Anthropic credential discoverable`** The full suite includes `tests/integration/anthropic-oauth-real.test.ts`. Configure credentials per `anthropic-auth.md`, or temporarily run a targeted file while you work elsewhere.
- **"Cannot find module './foo.js'".** TypeScript source imports use `.js` suffixes (ESM). That is correct; Bun/TypeScript resolves them to `.ts` during tests and direct source execution.
- **One test fails with timing-sensitive assertions.** The test likely assumes wall-clock timing rather than a `ControllableClock`. Use the `Clock` interface — production uses `SystemClock`, tests use `ControllableClock`.
- **Coverage numbers look wrong.** Coverage is not a first-class goal in Team Room; good architecture that produces well-tested seams is. If you're adding coverage tooling, add it behind a flag so the default `bun test` stays fast.

## Related

- `docs/runbooks/smoke-test.md` — end-to-end verification against real Docker + real LM Studio.
- Imported workflow skill packages (e.g., `@locksmithdon/dons-flow`) — test-driven-development, systematic-debugging, verification-before-completion.
- `docs/memory/feedback_teamroom_testability_and_di.md` — why in-memory real implementations instead of mocking.
