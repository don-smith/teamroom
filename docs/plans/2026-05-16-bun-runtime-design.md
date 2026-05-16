# Team Room Bun Runtime Migration — Design

*Date: 2026-05-16.*

## Goal

Migrate Team Room from Node.js/npm/Vitest/`better-sqlite3` to a Bun-native stack. This is a clean cutover, not a dual-runtime compatibility project. Node/npm references should be removed except for documented dependency-specific fallback exceptions.

Acceptance requires:

- `bun install` succeeds.
- `bun run typecheck` succeeds.
- `bun test` runs the full suite, including integration tests.
- The Docker-based smoke test passes.
- Manual CLI scenarios from the smoke-test/manual runbooks pass.
- A repository sweep finds no Node/npm runtime references except documented fallback exceptions.

## Recommended approach

Use a Bun-native cutover with staged compatibility checkpoints. The final state is cleanly Bun-native, but implementation should proceed through attributable checkpoints:

1. Establish Bun package/runtime/scripts and remove npm lockfile usage.
2. Convert host CLI/daemon entrypoints to direct TypeScript execution via Bun.
3. Replace `better-sqlite3` with `bun:sqlite` behind Team Room-owned DB interfaces.
4. Convert tests from Vitest to `bun test`, removing `vi` usage via DI/real implementations.
5. Rebuild agent Dockerfiles on official Bun images.
6. Run smoke/manual acceptance and sweep Node/npm references.

This avoids a debugging big bang while still landing as a clean runtime replacement.

## Runtime architecture

Team Room becomes Bun-native across host and containers.

- Host CLI and daemon entrypoints run TypeScript directly with `bun`, not `node dist/...`.
- `dist/` stops being the production runtime artifact. `tsc --noEmit` remains for typechecking.
- `package-lock.json`, npm scripts, npm install docs, and Node engine requirements are removed or replaced with Bun equivalents.
- The host/container JSONL contract stays unchanged. The migration changes the runtime, not Team Room's daemon orchestration model or agent protocol.
- Agent Dockerfiles use official Bun base images by default.
- A non-Bun fallback image or runtime is allowed only for a documented dependency-specific exception, such as a Claude Code/SDK incompatibility discovered during implementation.

The load-bearing host/container boundary remains unchanged: host code runs in the daemon/CLI process; `src/agent-runtime/` runs inside containers.

## Dependencies, SQLite, and package management

The dependency layer becomes Bun-native.

- `bun install` replaces `npm install`.
- `bun.lock` replaces `package-lock.json`.
- `bun run ...` replaces npm scripts in docs, runbooks, and shell scripts.
- `better-sqlite3` is removed.
- Database access moves to `bun:sqlite`.

The DB module should preserve existing repository and migrator contracts where practical. `bun:sqlite` should be ringfenced behind a Team Room-owned adapter/interface so higher-level modules do not depend directly on Bun's SQLite API shapes. Bun is the selected runtime, but storage consumers should continue to depend on Team Room storage contracts rather than raw `bun:sqlite` handles.

DB tests should continue to verify repository behavior against the new Bun-backed implementation.

## Test migration and mocking cleanup

Tests move from Vitest to `bun test`.

- `vitest` and `vitest.config.ts` go away.
- Test imports (`describe`, `it`, `expect`, `beforeEach`, and related helpers) come from `bun:test`.
- `vi` usage is not mechanically translated to Bun mocks.
- Each current mock site should be replaced with a real test seam: injected functions, in-memory real implementations, or small fake implementations consistent with existing project patterns (`FakeRunner`, `CapturingLogger`, controllable clock, etc.).
- `bun test` remains the full suite, including integration tests. There are no skipped real-backend tests or opt-in gates.
- `bun run typecheck` runs both production and test TypeScript configs, preserving fixture-drift detection.

The success criterion is behavioral: tests verify the same contracts after migration, and removed `vi` usage strengthens DI rather than weakening assertions.

## Containers, CLI, scripts, and docs

### Containers

- Agent Dockerfiles move from `node:22-alpine` to official Bun images.
- Containers run the TypeScript runtime entrypoint directly with Bun, for example `bun /app/agent-runtime/main.ts`.
- Docker builds copy the TypeScript source required by `agent-runtime` and its local imports, plus `package.json` and `bun.lock`.
- Anthropic/Claude images may install whatever Claude Code requires. Any non-Bun runtime fallback must be documented as an explicit exception.

### CLI and scripts

- The `teamroom` installation path points at a Bun-executable TypeScript entrypoint, likely via a generated shim or Bun shebang.
- `scripts/install-cli.mjs` becomes a Bun script or is replaced by a simpler Bun-aware install path.
- `scripts/smoke-test.sh` calls Bun commands and TypeScript entrypoints directly; it does not call `npm` or `node` except for documented fallback exceptions.
- README, runbooks, and module docs remove npm/Node instructions and replace them with Bun-native commands.

## Error handling and compatibility checks

Compatibility issues should be surfaced explicitly, not hidden behind silent fallbacks.

- If Claude Code or `@anthropic-ai/claude-agent-sdk` requires Node, document the exact blocker and scope the fallback to the affected agent image/path only.
- If Bun direct TypeScript execution changes runtime path semantics, fix the entrypoint/import layout deliberately rather than reintroducing a production build artifact.
- If `bun:sqlite` differs from `better-sqlite3` in transaction, migration, or result-shape behavior, capture the difference inside the DB adapter and tests.

## Testing and acceptance

The implementation is complete only when all of the following pass or are documented as an approved exception:

1. `bun install`
2. `bun run typecheck`
3. `bun test`
4. Docker-based smoke test
5. Manual CLI scenarios from the runbook
6. Repository sweep for stale Node/npm/Vitest/`better-sqlite3` references

The repository sweep should distinguish historical frozen docs (`docs/as-built/`, retros) from live instructions. Historical records may mention Node/npm as past state; live docs and commands should not.
