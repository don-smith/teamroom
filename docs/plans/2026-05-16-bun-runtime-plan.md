# Bun Runtime Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Team Room's Node.js/npm/Vitest/`better-sqlite3` runtime stack with Bun-native execution, package management, testing, SQLite, containers, scripts, and live docs.

**Architecture:** Preserve the host/container JSONL boundary and existing module contracts. Run TypeScript directly with Bun instead of compiling production `dist/`; keep `tsc --noEmit` for typechecking. Ringfence `bun:sqlite` behind Team Room-owned DB interfaces so storage consumers do not depend directly on Bun API shapes.

**Tech Stack:** Bun 1.3+, `bun:test`, `bun:sqlite`, TypeScript strict mode, Docker official Bun images, existing Team Room DI/fake implementation patterns.

---

## Important constraints

- Do not keep Node/npm compatibility as a transition path.
- Do not mechanically translate Vitest `vi` usage to Bun mocks. Replace with arrays, tiny fakes, injected functions, or existing real in-memory implementations.
- Historical frozen docs in `docs/as-built/` and `docs/retros/` may continue to mention Node/npm as past state. Live docs, scripts, package metadata, Dockerfiles, and READMEs should not.
- If Claude Code or `@anthropic-ai/claude-agent-sdk` requires a Node fallback, document the blocker and scope the exception to that agent image/path only.
- Commit after every task.

## Pre-flight check

Run:

```bash
git status --short
bun --version
```

Expected:

- Clean tree except the plan/design docs if not yet committed.
- Bun version prints successfully.

---

### Task 1: Establish Bun package metadata and scripts

**Files:**
- Modify: `package.json`
- Delete: `package-lock.json`
- Create: `bun.lock` (generated)

**Step 1: Edit package metadata**

In `package.json`:

- Change `bin.teamroom` from `dist/cli/main.js` to `src/cli/main.ts`.
- Replace scripts with Bun-native commands:

```json
"scripts": {
  "test": "bun test",
  "test:watch": "bun test --watch",
  "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json",
  "install-cli": "bun scripts/install-cli.ts ~/.local/bin --force"
}
```

- Remove `"engines": { "node": ">=22" }`.
- Remove `better-sqlite3`, `@types/better-sqlite3`, and `vitest` from dependencies/devDependencies.
- Add Bun types if typecheck requires them:

```json
"@types/bun": "latest"
```

Keep `typescript` and `@types/node` for typechecking Node-compatible APIs that Bun implements and for package types that reference Node modules.

**Step 2: Regenerate lockfile**

Run:

```bash
rm package-lock.json
bun install
```

Expected:

- `bun.lock` exists.
- `package-lock.json` is gone.
- No `better-sqlite3` or `vitest` in `package.json`.

**Step 3: Smoke package scripts**

Run:

```bash
bun run typecheck
```

Expected at this point: may fail because tests still import Vitest and DB still imports `better-sqlite3`. Record the first failure; do not fix beyond this task yet.

**Step 4: Commit**

```bash
git add package.json bun.lock package-lock.json
git commit -m "chore: switch package metadata to bun"
```

---

### Task 2: Add Bun CLI shebangs and replace the install script

**Files:**
- Modify: `src/cli/main.ts`
- Create: `scripts/install-cli.ts`
- Delete: `scripts/install-cli.mjs`

**Step 1: Add a Bun shebang to the CLI entrypoint**

At the first line of `src/cli/main.ts`, add:

```ts
#!/usr/bin/env bun
```

Keep all existing imports and CLI behavior unchanged.

**Step 2: Replace install script with Bun TypeScript**

Create `scripts/install-cli.ts` with the same behavior as the current `scripts/install-cli.mjs`, but Bun-native:

- Usage: `bun scripts/install-cli.ts <target-dir> [--force]`.
- Resolve `~` using `process.env.HOME`.
- Create the target directory recursively.
- Install a symlink named `teamroom` pointing to the repo's `src/cli/main.ts`.
- If the link/file exists and `--force` is absent, print the same style of remediation and exit non-zero.
- If `--force` is present, remove the existing target first.
- Make `src/cli/main.ts` executable with mode `0o755`.

Core implementation shape:

```ts
#!/usr/bin/env bun
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(repoRoot, "src/cli/main.ts");
// parse args, create directory, validate existing target, symlink cliEntry -> target/teamroom
```

Do not run a build from this script. There is no production `dist/` build artifact after this migration.

**Step 3: Verify the script**

Run:

```bash
tmpdir=$(mktemp -d)
bun scripts/install-cli.ts "$tmpdir" --force
"$tmpdir/teamroom" --help
```

Expected:

- Help text prints from Commander.
- No `node` or `dist` path is involved.

**Step 4: Commit**

```bash
git add src/cli/main.ts scripts/install-cli.ts scripts/install-cli.mjs package.json
git commit -m "chore: install cli as bun entrypoint"
```

---

### Task 3: Introduce a Team Room DB interface over Bun SQLite

**Files:**
- Modify: `src/db/database.ts`
- Modify: `src/db/README.md`

**Step 1: Replace `better-sqlite3` import with `bun:sqlite`**

In `src/db/database.ts`, define Team Room-owned interfaces matching the methods used by repositories and migrator:

```ts
import { Database, type SQLQueryBindings } from "bun:sqlite";

export type DbValue = string | number | bigint | boolean | null | Uint8Array;
export type DbParams = SQLQueryBindings[];

export interface Statement {
  run(...params: DbParams): unknown;
  get(...params: DbParams): unknown;
  all(...params: DbParams): unknown[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
  close(): void;
}
```

If `SQLQueryBindings[]` does not typecheck for rest parameters, replace with a local union compatible with Bun:

```ts
export type DbParam = string | number | bigint | boolean | null | Uint8Array;
```

and use `DbParam[]`.

**Step 2: Implement `createDatabase` with Bun**

```ts
export function createDatabase(dsn: string): Db {
  const db = new Database(dsn);
  db.exec("PRAGMA foreign_keys = ON");
  if (dsn !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}
```

If Bun allows WAL for `:memory:`, keeping WAL unconditional is also acceptable. Prefer the smallest passing implementation.

**Step 3: Update README**

In `src/db/README.md`:

- Change `database.ts` description from `better-sqlite3` to `bun:sqlite` behind a local `Db` interface.
- Change `Uses:` from `better-sqlite3 npm package` to `bun:sqlite`.

**Step 4: Verify DB typecheck surface**

Run:

```bash
bun run typecheck
```

Expected: DB-related `better-sqlite3` errors are gone. Remaining failures likely come from Vitest imports or Bun test API differences.

**Step 5: Commit**

```bash
git add src/db/database.ts src/db/README.md package.json bun.lock
git commit -m "refactor(db): back sqlite with bun"
```

---

### Task 4: Make migrations source-relative for direct TypeScript execution

**Files:**
- Modify: `src/db/migrator.ts`
- Modify: `src/db/migrator.test.ts`
- Modify: `docs/runbooks/adding-a-migration.md`

**Step 1: Update migration directory resolution**

Because production no longer runs from `dist/`, simplify `src/db/migrator.ts` so migrations are read from the source tree next to the TypeScript file:

```ts
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
```

This may already be the current source shape. The key requirement is: do not add any build-copy step for migrations.

**Step 2: Add/adjust a test that migrations run from source**

In `src/db/migrator.test.ts`, ensure there is a test that creates `createDatabase(":memory:")`, calls `runMigrations(db)`, and then verifies a current table exists:

```ts
const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
expect(row).toEqual({ name: "messages" });
```

Adjust the expected row shape if Bun returns a null-prototype object; use `expect(row).toMatchObject({ name: "messages" })` if needed.

**Step 3: Update migration runbook**

In `docs/runbooks/adding-a-migration.md`:

- Replace npm commands with Bun commands.
- Remove instructions to confirm SQL files copied into `dist/`.
- State that migrations run directly from `src/db/migrations/` under Bun.

**Step 4: Run focused DB tests**

Run:

```bash
bun test src/db
```

Expected: DB tests pass or fail only on known Vitest import conversion if Task 6 has not happened yet. If tests still import Vitest, defer full pass until Task 6.

**Step 5: Commit**

```bash
git add src/db/migrator.ts src/db/migrator.test.ts docs/runbooks/adding-a-migration.md
git commit -m "chore(db): read migrations from source"
```

---

### Task 5: Convert all test imports from Vitest to Bun test

**Files:**
- Modify: all `src/**/*.test.ts`
- Modify: all `tests/**/*.test.ts`
- Delete: `vitest.config.ts`

**Step 1: Mechanical import conversion**

For every test file, change imports from `vitest` to `bun:test`.

Examples:

```ts
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
```

Do not leave any `from "vitest"` import.

**Step 2: Delete Vitest config**

Remove `vitest.config.ts`.

**Step 3: Verify no Vitest imports remain**

Run:

```bash
rg -n "vitest|from ['\"]vitest['\"]|\bvi\b" src tests package.json
```

Expected: only `vi` usages remain at this point if not yet cleaned in later tasks. No `vitest` package/config/import references should remain.

**Step 4: Run tests to expose API gaps**

Run:

```bash
bun test
```

Expected: failures at remaining `vi` sites and possibly matcher differences. Do not fix `vi` sites in this task unless the fix is import-only impossible.

**Step 5: Commit**

```bash
git add src tests vitest.config.ts package.json bun.lock
git commit -m "test: switch test imports to bun"
```

---

### Task 6: Remove simple `vi.fn` usage from event and messaging tests

**Files:**
- Modify: `src/bus/event-bus.test.ts`
- Modify: `src/modules/messaging/messaging.test.ts`
- Modify: `src/modules/mcp-mail/mcp-mail.test.ts`

**Step 1: Replace function mocks with arrays/counters**

In `src/bus/event-bus.test.ts`, replace patterns like:

```ts
const a = vi.fn();
...
expect(a).toHaveBeenCalledOnce();
```

with explicit captures:

```ts
let aCalls = 0;
const a = () => { aCalls += 1; };
...
expect(aCalls).toBe(1);
```

For payload assertions, capture payloads:

```ts
const received: unknown[] = [];
bus.subscribe("tool.call", (payload) => received.push(payload));
expect(received).toEqual([{ agentId: "X", tool: "mail.list" }]);
```

Apply the same style in messaging and MCP-mail tests: arrays for delivered events/callback payloads; counters for call counts.

**Step 2: Verify no `vi` remains in these files**

Run:

```bash
rg -n "\bvi\b" src/bus/event-bus.test.ts src/modules/messaging/messaging.test.ts src/modules/mcp-mail/mcp-mail.test.ts
```

Expected: no matches.

**Step 3: Run focused tests**

```bash
bun test src/bus/event-bus.test.ts src/modules/messaging/messaging.test.ts src/modules/mcp-mail/mcp-mail.test.ts
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/bus/event-bus.test.ts src/modules/messaging/messaging.test.ts src/modules/mcp-mail/mcp-mail.test.ts
git commit -m "test: replace simple mock callbacks"
```

---

### Task 7: Remove Docker exec mocks from container tests

**Files:**
- Modify: `src/container/kill-stale.test.ts`
- Modify: `tests/integration/daemon-restart-kills-containers.test.ts`

**Step 1: Replace `vi.fn` in `kill-stale.test.ts`**

For the empty-container test, use a real async function with captured calls:

```ts
const calls: { cmd: string; args: string[] }[] = [];
const exec: DockerExec = async (cmd, args) => {
  calls.push({ cmd, args });
  return { stdout: "", stderr: "" };
};
expect(await killStaleTeamroomContainers({ dockerExec: exec })).toEqual([]);
expect(calls).toEqual([
  { cmd: "docker", args: ["ps", "-q", "--filter", "label=teamroom-agent=true"] },
]);
```

**Step 2: Replace `vi.fn` in daemon restart integration test**

Use a captured-call array instead of `mock.calls`:

```ts
const calls: { cmd: string; args: string[] }[] = [];
const exec: DockerExec = async (cmd, args) => {
  calls.push({ cmd, args });
  return { stdout: "", stderr: "" };
};
...
expect(calls).toHaveLength(1);
```

Preserve the existing behavior under test.

**Step 3: Verify no `vi` remains in these files**

```bash
rg -n "\bvi\b" src/container/kill-stale.test.ts tests/integration/daemon-restart-kills-containers.test.ts
```

Expected: no matches.

**Step 4: Run focused tests**

```bash
bun test src/container/kill-stale.test.ts tests/integration/daemon-restart-kills-containers.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/container/kill-stale.test.ts tests/integration/daemon-restart-kills-containers.test.ts
git commit -m "test: replace docker exec mocks"
```

---

### Task 8: Replace mailing-list dispatcher mocks with a fake dispatcher

**Files:**
- Modify: `src/mailing-lists/trigger-listener.test.ts`

**Step 1: Add a tiny fake dispatcher in the test file**

At the top of the test file, after imports, add:

```ts
type SentMail = Parameters<MailDispatcher["sendMail"]>[0];

class CapturingMailDispatcher implements MailDispatcher {
  readonly sent: SentMail[] = [];

  sendMail(input: SentMail): void {
    this.sent.push(input);
  }
}
```

If `sendMail` is async in the interface, make the method `async` and await bus-triggered paths as needed. Match the actual `MailDispatcher` type.

**Step 2: Replace all dispatcher mocks**

Replace:

```ts
const dispatcher = { sendMail: vi.fn() } as unknown as MailDispatcher;
```

with:

```ts
const dispatcher = new CapturingMailDispatcher();
```

Replace expectations:

```ts
expect(dispatcher.sendMail).toHaveBeenCalledWith(expected);
```

with:

```ts
expect(dispatcher.sent).toContainEqual(expected);
```

For no-call checks:

```ts
expect(dispatcher.sent).toEqual([]);
```

For fanout:

```ts
expect(dispatcher.sent.map((m) => m.to)).toEqual([["list:l1"], ["list:l2"]]);
```

**Step 3: Run focused test**

```bash
bun test src/mailing-lists/trigger-listener.test.ts
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/mailing-lists/trigger-listener.test.ts
git commit -m "test: use fake mailing list dispatcher"
```

---

### Task 9: Remove session-management spies by testing observable behavior

**Files:**
- Modify: `src/modules/session-management/session-management.test.ts`

**Step 1: Replace `vi.spyOn` assertions**

Do not spy on `sm.sessionManager` methods. Instead, publish bus events and assert the observable effect on the `FakeRunner` or session state.

Use the existing composition:

```ts
const runner = new FakeRunner();
```

Set the runner script so a wake can complete if the session manager starts a container. Then publish:

```ts
void messaging.eventBus.publish("mail.delivered", { to: "agent:foo" });
```

Assert the fake runner received a run for `agent:foo` (inspect `FakeRunner` API; likely `runner.requests` or equivalent). If no public accessor exists, add a minimal read-only accessor to `src/container/fake-runner.ts` rather than spying.

For activity events (`mail.sent`, `tool.call`), assert they update/extend idle timers using a test timer fake if that is the intended behavior. If current code only delegates internally without externally visible state, add a small recording timer factory in the test and assert schedules/cancels.

**Step 2: Keep the test contract high-level**

Rename the test if needed from "subscribes to ..." to the behavior users care about, e.g.:

```ts
it("wakes recipients on delivered mail and records activity on sent/tool events", async () => {
  ...
});
```

**Step 3: Run focused test**

```bash
bun test src/modules/session-management/session-management.test.ts
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/modules/session-management/session-management.test.ts src/container/fake-runner.ts
git commit -m "test: assert session management behavior without spies"
```

---

### Task 10: Remove remaining `vi` references and verify Bun test compatibility

**Files:**
- Modify: any remaining `src/**/*.test.ts` / `tests/**/*.test.ts` containing `vi`

**Step 1: Inventory remaining `vi`**

Run:

```bash
rg -n "\bvi\b" src tests
```

**Step 2: Replace each remaining use with DI/fakes/captures**

Use these patterns:

- Callback count: `let calls = 0`.
- Callback payloads: `const calls: Payload[] = []`.
- Async dependency: hand-written async function that records args.
- Object dependency: tiny class implementing the interface with readonly capture arrays.
- Spying on internal method: prefer asserting through public output; add a test seam only if the production contract already implies one.

**Step 3: Verify no `vi` remains**

```bash
rg -n "\bvi\b|vitest" src tests package.json
```

Expected: no matches.

**Step 4: Run full tests**

```bash
bun test
```

Expected: full suite passes, including real integration tests. If a real backend credential/service is missing, stop and fix environment; do not skip tests.

**Step 5: Commit**

```bash
git add src tests package.json bun.lock
git commit -m "test: finish bun test migration"
```

---

### Task 11: Fix TypeScript configuration for Bun direct execution

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.test.json`

**Step 1: Add Bun types if needed**

If typecheck reports missing `bun:sqlite` or `bun:test` types, add to `tsconfig.json`:

```json
"types": ["bun-types", "node"]
```

or the form required by the installed `@types/bun`/Bun version. Use the smallest change that makes `bun run typecheck` pass.

**Step 2: Keep strict settings**

Do not relax:

- `strict`
- `noUncheckedIndexedAccess`
- `noImplicitOverride`
- `isolatedModules`

**Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: both production and test TS configs pass.

**Step 4: Commit**

```bash
git add tsconfig.json tsconfig.test.json package.json bun.lock
git commit -m "chore: typecheck bun runtime sources"
```

---

### Task 12: Convert agent Dockerfiles to official Bun images

**Files:**
- Modify: `agents/studio-assistant/Dockerfile`
- Modify: `agents/claude-assistant/Dockerfile`
- Modify: `agents/claude-researcher/Dockerfile`
- Modify: `src/agent-runtime/README.md`

**Step 1: Update studio assistant Dockerfile**

Replace Node image/npm/dist pattern with Bun/source pattern:

```dockerfile
FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src /app/src

ENTRYPOINT ["bun", "/app/src/agent-runtime/main.ts"]
```

If Alpine causes native package issues for an agent dependency, try the official non-Alpine Bun image before documenting any Node fallback.

**Step 2: Update Claude Dockerfiles**

Use official Bun image by default. Preserve Claude Code installation if compatible with Bun:

```dockerfile
FROM oven/bun:1.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
RUN bun install -g @anthropic-ai/claude-code

COPY src /app/src

ENTRYPOINT ["bun", "/app/src/agent-runtime/main.ts"]
```

If `bun install -g @anthropic-ai/claude-code` fails or the Claude Code binary fails at runtime because it requires Node, document the exact failure and use the narrowest fallback image for Claude agents only.

**Step 3: Update agent runtime README**

In `src/agent-runtime/README.md`:

- Replace `COPY dist/agent-runtime` references with `COPY src` / Bun direct TypeScript execution.
- Replace Node `fs` wording with Bun runtime plus Node-compatible built-ins where appropriate.
- Keep the host/container boundary language unchanged.

**Step 4: Build images**

```bash
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .
docker build -t teamroom-agent-claude-assistant:latest -f agents/claude-assistant/Dockerfile .
docker build -t teamroom-agent-claude-researcher:latest -f agents/claude-researcher/Dockerfile .
```

Expected: all build, unless a Claude-specific blocker is found and documented.

**Step 5: Commit**

```bash
git add agents/studio-assistant/Dockerfile agents/claude-assistant/Dockerfile agents/claude-researcher/Dockerfile src/agent-runtime/README.md
git commit -m "chore(containers): run agent runtime with bun"
```

---

### Task 13: Convert smoke test to Bun and direct TypeScript

**Files:**
- Modify: `scripts/smoke-test.sh`
- Modify: `docs/runbooks/smoke-test.md`

**Step 1: Remove build step**

In `scripts/smoke-test.sh`, replace:

```bash
echo "==> Building TypeScript"
npm run build
```

with:

```bash
echo "==> Typechecking"
bun run typecheck
```

**Step 2: Replace CLI invocations**

Replace every:

```bash
node dist/cli/main.js ...
```

with:

```bash
bun src/cli/main.ts ...
```

This includes diagnostics, daemon start, send, and inbox polling.

**Step 3: Ensure Docker builds use Bun Dockerfiles**

Keep the `docker build` commands, now using Bun Dockerfiles from Task 12.

**Step 4: Update smoke runbook**

In `docs/runbooks/smoke-test.md`:

- Replace Node/npm prerequisites with Bun.
- Replace `npm run build` with `bun run typecheck` or the smoke script.
- Remove `dist/` references.

**Step 5: Run smoke test**

```bash
scripts/smoke-test.sh
```

Expected: both agents respond and provider spans are present.

**Step 6: Commit**

```bash
git add scripts/smoke-test.sh docs/runbooks/smoke-test.md
git commit -m "test: run smoke test through bun"
```

---

### Task 14: Update live README and runbooks from npm/Node to Bun

**Files:**
- Modify: `README.md`
- Modify: `src/README.md`
- Modify: `src/cli/README.md`
- Modify: `docs/runbooks/running-tests.md`
- Modify: `docs/runbooks/agent-onboarding.md`
- Modify: `docs/runbooks/manual-cli-testing.md`
- Modify: any other live docs found by the sweep

**Step 1: Sweep live docs**

Run:

```bash
rg -n "npm|node |Node\.js|node:20|node:22|dist/|package-lock|vitest|better-sqlite3" README.md src docs/runbooks agents scripts package.json --glob '!docs/as-built/**' --glob '!docs/retros/**'
```

**Step 2: Update live instructions**

Use these replacements where accurate:

- `npm install` → `bun install`
- `npm test` → `bun test`
- `npm run typecheck` → `bun run typecheck`
- `npm run install-cli -- ~/bin` → `bun run install-cli -- ~/bin` or `bun scripts/install-cli.ts ~/bin --force`
- `node dist/cli/main.js ...` → `bun src/cli/main.ts ...`
- `dist/` build caveats → remove; direct TypeScript is now the runtime model
- `better-sqlite3` → `bun:sqlite` behind `src/db/database.ts`'s `Db` interface

**Step 3: Preserve historical docs**

Do not edit frozen `docs/as-built/` or `docs/retros/` merely to remove historical Node/npm mentions.

**Step 4: Re-run sweep**

```bash
rg -n "npm|node |Node\.js|node:20|node:22|dist/|package-lock|vitest|better-sqlite3" README.md src docs/runbooks agents scripts package.json --glob '!docs/as-built/**' --glob '!docs/retros/**'
```

Expected: no matches except intentional documented fallback exceptions or references to Node-compatible built-in module specifiers (`node:fs`, `node:http`) where source code uses them. If `node:` source imports appear in this broad sweep, they are allowed when Bun supports them; the removal target is Node/npm as the required runtime/tooling.

**Step 5: Commit**

```bash
git add README.md src docs/runbooks agents scripts package.json
git commit -m "docs: document bun runtime workflow"
```

---

### Task 15: Verify direct Bun CLI behavior manually

**Files:**
- No planned source changes unless failures reveal bugs

**Step 1: Install CLI into a temp bin**

```bash
tmpdir=$(mktemp -d)
bun scripts/install-cli.ts "$tmpdir" --force
PATH="$tmpdir:$PATH" teamroom --help
```

Expected: help text prints.

**Step 2: Run a lightweight command without daemon**

```bash
PATH="$tmpdir:$PATH" teamroom status || true
```

Expected: reports daemon not running; exits non-zero without crashing.

**Step 3: Run manual CLI scenarios**

Follow `docs/runbooks/manual-cli-testing.md` using Bun commands. At minimum, exercise:

- `teamroom serve`
- `teamroom send <agent> <message>`
- `teamroom inbox <agent>`
- `teamroom chat <agent>` if the runbook requires it

**Step 4: Commit only if fixes were needed**

If no changes:

```bash
git status --short
```

Expected: clean.

If fixes were needed:

```bash
git add <fixed files>
git commit -m "fix: support bun cli workflow"
```

---

### Task 16: Final verification and stale-reference sweep

**Files:**
- Modify: any files needed to fix verification failures

**Step 1: Full automated verification**

Run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
scripts/smoke-test.sh
```

Expected:

- All commands pass.
- No skipped/opt-in integration tests.

**Step 2: Stale runtime reference sweep**

Run:

```bash
rg -n "npm|node |Node\.js|node:20|node:22|dist/cli|package-lock|vitest|better-sqlite3" README.md package.json tsconfig*.json src tests docs/runbooks agents scripts --glob '!docs/as-built/**' --glob '!docs/retros/**'
```

Expected:

- No stale live-tooling references.
- `node:` import specifiers in source are acceptable if they appear from broader searches; Bun supports Node-compatible built-ins.
- Any Claude-specific fallback exception is explicitly documented near the Dockerfile/runbook that needs it.

**Step 3: Check git state**

```bash
git status --short
```

Expected: clean after any final fixes are committed.

**Step 4: Final commit if needed**

```bash
git add <files>
git commit -m "chore: finish bun runtime migration"
```

---

## Handoff notes

- Start execution with `superpowers:executing-plans`.
- If a task encounters a failing test, stop and investigate with `superpowers:systematic-debugging`; do not proceed downstream on a red tree.
- Before claiming completion, use `superpowers:verification-before-completion` and cite the exact verification commands and results.
