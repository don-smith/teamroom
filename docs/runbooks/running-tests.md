# Running tests

The Team Room test suite runs entirely in-process with real in-memory dependencies (SQLite `:memory:`, `InMemoryBus`, `FakeRunner`). No Docker, no LM Studio, no network — just fast unit + integration coverage. Use this runbook when you want to verify the suite locally, debug a single failure, or watch the suite during TDD.

## Preconditions

- Node.js 20+ installed.
- `npm install` has run in the repo root (look for `node_modules/`).
- You are on the branch you expect; no stray uncommitted files that shouldn't be in scope.

## Steps

1. Run the full suite once:
   ```bash
   npm test
   ```
   Expected: 68/68 passing across 21 files in ~1.5 s.

2. For TDD or to leave it running while you edit:
   ```bash
   npm run test:watch
   ```
   Vitest re-runs on file save. Press `q` to quit.

3. To run a single file or pattern:
   ```bash
   npx vitest run src/daemon/turn-processor.test.ts
   npx vitest run -t "reconciles orphaned"
   ```

4. To run integration tests only:
   ```bash
   npx vitest run tests/integration
   ```

## Verifying success

- Every line ends with a green check and the footer reads `Test Files  XX passed` / `Tests  XX passed`.
- Total runtime under ~3 s on a laptop. If it's dramatically slower, something is hitting the network or disk outside the in-memory seams — investigate before dismissing.
- `npm run typecheck` passes (`tsc --noEmit`).

## Troubleshooting

- **`better-sqlite3` native build fails after Node version bump.** Run `npm rebuild better-sqlite3`. If that fails, delete `node_modules/` and `package-lock.json`, then `npm install` again.
- **Vitest cannot find test files.** Check `vitest.config.ts` — the `include` glob is `src/**/*.test.ts` and `tests/**/*.test.ts`. Tests outside those paths are not discovered.
- **"Cannot find module './foo.js'".** TypeScript source imports use `.js` suffixes (ESM). That is correct; the resolver maps them to `.ts` at test time and to the real `.js` in `dist/` at runtime.
- **One test fails with timing-sensitive assertions.** The test likely assumes wall-clock timing rather than a `ControllableClock`. Use the `Clock` interface — production uses `SystemClock`, tests use `ControllableClock`.
- **Coverage numbers look wrong.** Coverage is not a first-class goal in Team Room; good architecture that produces well-tested seams is. If you're adding coverage tooling, add it behind a flag so the default `npm test` stays fast.

## Related

- `docs/runbooks/smoke-test.md` — end-to-end verification against real Docker + real LM Studio.
- `.claude/skills/` — test-driven-development (superpowers).
- `docs/memory/feedback_teamroom_testability_and_di.md` — why in-memory real implementations instead of mocking.
