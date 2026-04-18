# M2 — Model Abstraction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-daemon HTTP proxy that gives containers credential-isolated access to multiple model providers (Anthropic + LM Studio at exit), with two agents (`studio-assistant` and `claude-assistant`) exercising both backends end-to-end.

**Architecture:** New `src/model-proxy/` module exposes a `ModelProxy` seam owned by the daemon. Per-turn ephemeral routing tokens, minted at turn start and evicted on turn end, identify the agent in the proxy's in-memory registry; the proxy substitutes routing tokens for real upstream credentials (real API key in API-key mode; cached OAuth-exchange temp keys in OAuth mode) before forwarding. Container-side `AnthropicLlmClient` is mode-agnostic — vanilla `@anthropic-ai/sdk` configured with `apiKey = routing-token`. Five M1 debts are absorbed in-flight (reconciler `pending`-blind-spot, daemon shutdown polish, `parseEvent` ordering, agent-onboarding runbook skeleton, conditional Node 22 bump).

**Tech Stack:** TypeScript strict, Node.js (`>=20`, conditional bump to `>=22`), Vitest, better-sqlite3, chokidar (existing), `@anthropic-ai/sdk` (new), Docker, LM Studio (local), Anthropic API (real).

**Source spec:** [`docs/specs/2026-04-18-m2-model-abstraction-design.md`](../specs/2026-04-18-m2-model-abstraction-design.md). Read sections 2 (architecture), 4 (data flow), and 6 (auth modes) before starting.

**Working principle.** Per the M1 retro: nothing silent, nothing inconsistent, nothing crashes. Every effectful dependency stays behind an interface; tests use real in-memory implementations (`SQLite :memory:`, real `http.createServer` on `127.0.0.1:0` for the proxy + fake-upstream test servers, `InMemoryBus`, `FakeRunner`). No `vi.mock` / `jest.mock` anywhere.

**Pre-execution review.** Both Claude and the user dry-run this plan before approving execution (per ways-of-working). Capture any drifts in `docs/tabled.md` or update the plan inline before starting Task 1.

---

## File Structure (locked decisions)

**New files:**

- `src/model-proxy/README.md`
- `src/model-proxy/model-proxy.ts` — `ModelProxy` interface
- `src/model-proxy/local-model-proxy.ts` — in-process http server impl
- `src/model-proxy/local-model-proxy.test.ts`
- `src/model-proxy/token-registry.ts`
- `src/model-proxy/token-registry.test.ts`
- `src/model-proxy/span.ts` — span-id generator + log-record builder helpers
- `src/model-proxy/adapters/adapter.ts` — `ProviderAdapter` interface
- `src/model-proxy/adapters/anthropic-adapter.ts`
- `src/model-proxy/adapters/anthropic-adapter.test.ts`
- `src/model-proxy/adapters/anthropic-oauth-cache.ts`
- `src/model-proxy/adapters/anthropic-oauth-cache.test.ts`
- `src/model-proxy/adapters/lm-studio-adapter.ts`
- `src/model-proxy/adapters/lm-studio-adapter.test.ts`
- `src/agent-runtime/anthropic-llm-client.ts`
- `src/agent-runtime/anthropic-llm-client.test.ts`
- `agents/claude-assistant/agent.yaml`
- `agents/claude-assistant/AGENTS.md`
- `agents/claude-assistant/Dockerfile`
- `agents/claude-assistant/store/.gitkeep`
- `tests/integration/proxy-end-to-end.test.ts`
- `docs/runbooks/anthropic-auth.md`
- `docs/runbooks/agent-onboarding.md`

**Renamed:**

- `agents/assistant/` → `agents/studio-assistant/` (folder + `agent.yaml.name` + ~25 references)

**Modified:**

- `src/types.ts` — add `Provider`, `AuthMode`, span-shape types
- `src/agent-config/agent-config.ts` — parse + return `provider` field
- `src/agent-config/agent-config.test.ts`
- `src/daemon/daemon.ts` — start ModelProxy; static fs import; PID unlink on stop; `stopped` guard
- `src/daemon/daemon.test.ts` (or similar) — shutdown idempotency tests
- `src/daemon/main.ts` — credential discovery + wire ModelProxy into daemon options
- `src/daemon/turn-processor.ts` — replace `modelBaseUrl/modelApiToken` deps with `modelProxy`; mint/evict tokens; markRunning ordering fix
- `src/daemon/turn-processor.test.ts`
- `src/daemon/reconcile.ts` — aged-`pending` sweep
- `src/daemon/reconcile.test.ts`
- `src/daemon/safety-nets.ts` — already minimal; check + tests
- `src/container/docker-runner.ts` — `parseEvent` spread fix; AGENTS.md mount becomes `readOnly: false`
- `src/container/docker-runner.test.ts` (or `parseEvent`'s home test file)
- `src/agent-runtime/main.ts` — provider factory
- `src/bus/README.md` — YAGNI principle line
- `agents/studio-assistant/agent.yaml` — add `provider: lm-studio`
- `.env.example` — add Anthropic vars (OAuth preferred)
- `README.md` — note both backends, rename references
- `docs/runbooks/smoke-test.md` — extend for Anthropic; rename references
- `docs/runbooks/manual-cli-testing.md` — rename references
- `package.json` — `engines.node` and `@types/node` conditional bump; add `@anthropic-ai/sdk`
- `scripts/smoke-test.sh` — exercise both agents
- `tests/integration/end-to-end.test.ts` — add ModelProxy to its composition
- Module READMEs that the above edits invalidate (per ways-of-working: same-change rule)

**Not touched (frozen historical docs):**

- `docs/as-built/2026-04-18-teamroom-m1.md`
- `docs/retros/2026-04-18-m1.md`
- `team-room-context.md`

---

## Phase 1 — Cross-cutting cleanups (do first; low entanglement)

These are small, safe-to-revert changes that get the M1 debts out of the way before the substantive M2 work. Doing the rename first means later commits don't have to deal with renaming half-touched files.

---

### Task 1: Rename `agents/assistant/` → `agents/studio-assistant/`

**Files:**
- Move: `agents/assistant/` → `agents/studio-assistant/` (entire folder via `git mv`)
- Modify: `agents/studio-assistant/agent.yaml` (`name: assistant` → `name: studio-assistant`)
- Modify: `scripts/smoke-test.sh` (any `--agent assistant` → `--agent studio-assistant`)
- Modify: `tests/integration/end-to-end.test.ts`
- Modify: `src/db/agent-repo.test.ts`, `src/db/turn-repo.test.ts`, `src/db/message-repo.test.ts`
- Modify: `src/cli/send.test.ts`, `src/cli/tail.test.ts`
- Modify: `src/daemon/turn-processor.test.ts`, `src/daemon/reconcile.test.ts`, `src/daemon/orchestrator.test.ts`
- Modify: `src/agent-config/agent-config.test.ts`
- Modify: `src/types.test.ts`
- Modify: `src/container/docker-command.test.ts`
- Modify: `src/agent-runtime/runtime.test.ts`, `src/agent-runtime/session-store.test.ts`, `src/agent-runtime/runtime.ts`, `src/agent-runtime/session-store.ts` (only if any literal `"assistant"` is used as the agent name)
- Modify: `README.md`
- Modify: `docs/runbooks/smoke-test.md`, `docs/runbooks/manual-cli-testing.md`
- Modify: `AGENTS.md` (only if it references the agent by literal name)
- **Do NOT touch:** `docs/as-built/2026-04-18-teamroom-m1.md`, `docs/retros/2026-04-18-m1.md`, `team-room-context.md`, `docs/ways-of-working.md`, `.claude/skills/writing-as-built/SKILL.md` (generic uses of "assistant" are OK).

- [ ] **Step 1: Move the folder**

```bash
cd /Users/don/projects/teamroom/teamroom-worktrees/teamroom/model-abstraction-layer
git mv agents/assistant agents/studio-assistant
```

- [ ] **Step 2: Update agent.yaml name field**

In `agents/studio-assistant/agent.yaml`, change `name: assistant` to `name: studio-assistant`. Leave `model:` and `image_tag:` untouched for now (image tag will get updated in Step 3).

- [ ] **Step 3: Update agent.yaml image_tag**

In `agents/studio-assistant/agent.yaml`, change `image_tag: teamroom-agent-assistant:latest` to `image_tag: teamroom-agent-studio-assistant:latest`.

- [ ] **Step 4: Find every other reference**

Run:

```bash
grep -rn "assistant" --include="*.ts" --include="*.sh" --include="*.md" --include="*.yaml" \
  --exclude-dir=node_modules --exclude-dir=dist \
  --exclude-dir=docs/as-built --exclude-dir=docs/retros \
  --exclude=team-room-context.md --exclude=ways-of-working.md \
  | grep -v "^Binary"
```

Expected: a list of ~25–30 lines. For each, decide:
- Is "assistant" used as the agent identifier (e.g., `--agent assistant`, `id: "assistant"`, `agentName: "assistant"`, `teamroom-agent-assistant`)? → change to `studio-assistant`.
- Is it generic English (e.g., "the assistant agent", "AI assistant" prose)? → leave alone.
- Is it part of a different identifier (e.g., `claude-assistant` in this plan)? → leave alone.

- [ ] **Step 5: Make the changes file-by-file**

For each file flagged in Step 4 with an agent-identifier match, replace the literal. Most replacements are mechanical (`"assistant"` → `"studio-assistant"`, `--agent assistant` → `--agent studio-assistant`, `teamroom-agent-assistant:latest` → `teamroom-agent-studio-assistant:latest`).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — all 68 M1 tests still green. Any failures here are missed references; go back to Step 4.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Build and rebuild image to verify the build path**

Run:
```bash
npm run build
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .
```
Expected: clean build of both `dist/` and the Docker image. Old image `teamroom-agent-assistant:latest` is not removed (manual cleanup later); new image is what Tasks 2+ will use.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(agents): rename assistant → studio-assistant

Cross-cutting rename ahead of M2's hiring of claude-assistant.
Naming convention going forward: agents are named after their
backing model/provider so the role is obvious from the name.
Frozen historical docs (M1 as-built, retro, team-room-context)
intentionally not modified — they describe M1 reality.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.4, §9
"
```

---

### Task 2: Daemon shutdown polish (M1 debt #2)

**Files:**
- Modify: `src/daemon/daemon.ts:1, ~62, ~95-100`
- Modify: `src/daemon/main.ts` (PID file location knowledge for unlinking)
- Modify: `src/daemon/daemon.test.ts` (or create if not present — verify with `ls src/daemon/*.test.ts`)

- [ ] **Step 1: Confirm current shape**

Read `src/daemon/daemon.ts` lines 1–10 and 60–103. Note:
- Line 62 has `const { readdirSync, statSync } = await import("node:fs");` — dynamic import.
- `stop()` (lines 95–100) does not unlink the PID file written at line 49.
- `stop()` calls `db.close()` unconditionally; calling `stop()` twice would throw on the second `db.close()`.

- [ ] **Step 2: Static fs import**

In `src/daemon/daemon.ts`, change line 1 from:

```ts
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
```

to:

```ts
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
```

Then remove the dynamic `await import("node:fs")` line in the agent-discovery loop.

- [ ] **Step 3: PID unlink + idempotency guard in `stop()`**

Replace the `stop` implementation (around lines 95–100):

```ts
const pidFile = join(opts.dataDir, "teamroom.pid");
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  orchestrator.stop();
  await loopPromise;
  await bus.close();
  db.close();
  try { unlinkSync(pidFile); } catch { /* PID file already gone */ }
};
```

(Move the `pidFile` const up so the `writeFileSync` at line 49 also uses it.)

- [ ] **Step 4: Write the failing test**

In `src/daemon/daemon.test.ts` (create if missing), add:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./daemon.js";

describe("daemon shutdown", () => {
  let dataDir: string;
  let agentsDir: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "teamroom-daemon-"));
    dataDir = join(root, "data");
    agentsDir = join(root, "agents");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
  });

  it("unlinks the PID file on clean stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      modelBaseUrl: "http://example.invalid",
      modelApiToken: "x",
    });
    const pidFile = join(dataDir, "teamroom.pid");
    expect(existsSync(pidFile)).toBe(true);
    await daemon.stop();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stop() is idempotent", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      modelBaseUrl: "http://example.invalid",
      modelApiToken: "x",
    });
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Run the test to verify FAIL → PASS**

Run: `npx vitest run src/daemon/daemon.test.ts`
Expected: PASS (since Steps 2–3 already implemented the changes). If FAIL, fix and re-run.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: 68 + 2 = 70 tests passing. No regressions.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/daemon.ts src/daemon/daemon.test.ts
git commit -m "fix(daemon): static fs import, PID unlink, idempotent stop (M1 debt #2)

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §9 item 2
"
```

---

### Task 3: Fix `parseEvent` spread ordering (M1 debt #3)

**Files:**
- Modify: `src/container/docker-runner.ts` (find `parseEvent`)
- Modify: `src/container/docker-runner.test.ts` (or wherever `parseEvent` is tested)

- [ ] **Step 1: Find parseEvent**

Run: `grep -n "parseEvent" src/container/docker-runner.ts`
Note the line number and read the function.

- [ ] **Step 2: Diagnose the bug**

The current shape probably looks like `return { type, ...parsed };` where `parsed` is the JSON-parsed line. If the malformed JSON itself contains a `type` field, that overwrites the typed `type` we extracted.

- [ ] **Step 3: Write the failing test**

In `src/container/docker-runner.test.ts` (create if needed) add:

```ts
import { describe, it, expect } from "vitest";
import { parseEvent } from "./docker-runner.js";  // export parseEvent if not already

describe("parseEvent", () => {
  it("a typed event field wins over a malformed JSON's own 'type'", () => {
    // Synthesize a payload that JSON-parses but contains 'type: \"reply\"' in the body
    // mimicking a malformed agent event that we should NOT trust.
    const raw = JSON.stringify({ type: "reply", body: "hi", spurious: { type: "evil" } });
    const evt = parseEvent(raw);
    expect(evt?.type).toBe("reply");
  });

  it("non-object JSON returns undefined or a warn-classified event", () => {
    const evt = parseEvent("42");
    expect(evt).toBeUndefined();
  });

  it("invalid JSON returns undefined", () => {
    const evt = parseEvent("not json");
    expect(evt).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails (or already passes)**

Run: `npx vitest run src/container/docker-runner.test.ts`
Expected: FAIL on the first case if the bug is present.

- [ ] **Step 5: Apply the spread-order fix**

In `parseEvent`, ensure the typed extracted `type` is on the right side of the spread:

```ts
// before (buggy):
return { type, ...parsed };
// after (fixed):
return { ...parsed, type };
```

If `parseEvent` isn't exported, add `export` to it.

- [ ] **Step 6: Run the test to verify it now passes**

Run: `npx vitest run src/container/docker-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: All previous tests still passing.

- [ ] **Step 8: Commit**

```bash
git add src/container/docker-runner.ts src/container/docker-runner.test.ts
git commit -m "fix(container): parseEvent spread ordering (M1 debt #3)

Typed 'type' field always wins over malformed JSON payload.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §9 item 3
"
```

---

### Task 4: Bus README YAGNI principle

**Files:**
- Modify: `src/bus/README.md`

- [ ] **Step 1: Add a one-line principle**

Add a new short section near the top of `src/bus/README.md` (after the existing one-paragraph intro):

```markdown
## Adding new events

Don't add events without a real consumer. Even observability is fair game only when something actually subscribes to the new event — span-shaped log records cover the analytic use case until M3's bus rewrite lands a proper telemetry destination.
```

- [ ] **Step 2: Commit**

```bash
git add src/bus/README.md
git commit -m "docs(bus): YAGNI principle for new events

Codifies the M2 brainstorming decision (Q6 + Section 8): don't fire
bus events without a real consumer. Span-shaped logs carry the
observability load until M3.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §9 item 7
"
```

---

### Task 5: Conditional Node 22 bump (M1 debt #4)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Check whether any dep blocks Node 22**

Run:

```bash
npm ls --depth=0 2>&1 | grep -i "node@" || true
node -e "const ls = require('child_process').execSync('npm ls --all --json'); const data = JSON.parse(ls.toString()); function walk(n, depth=0){ if(n.engines?.node) console.log(n.name+' requires node '+n.engines.node); for (const k of Object.keys(n.dependencies||{})) walk(n.dependencies[k]); } walk(data);"
```

If any dep requires `<22`, **STOP** — leave `engines.node: ">=20"` and `@types/node: ^20.0.0` as-is, commit a one-line note in `docs/tabled.md` explaining which dep blocks the bump, then skip Steps 2–4 and go to Task 6.

- [ ] **Step 2: Bump engines.node and @types/node**

In `package.json`:

```json
"devDependencies": {
  "@types/better-sqlite3": "^7.6.11",
  "@types/node": "^22.0.0",
  "typescript": "^5.6.3",
  "vitest": "^2.1.3"
},
"engines": {
  "node": ">=22"
}
```

- [ ] **Step 3: Reinstall and verify**

```bash
npm install
npm run typecheck
npm test
```

Expected: clean install, clean typecheck, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump @types/node and engines.node to 22 (M1 debt #4)

Verified no transitive dep requires <22.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §9 item 4
"
```

---

## Phase 2 — agent.yaml schema: add `provider` field

---

### Task 6: Add `provider` field to AgentConfig

**Files:**
- Modify: `src/types.ts` (add `Provider` type)
- Modify: `src/agent-config/agent-config.ts` (parse + validate `provider`)
- Modify: `src/agent-config/agent-config.test.ts`
- Modify: `agents/studio-assistant/agent.yaml` (add `provider: lm-studio`)

- [ ] **Step 1: Add `Provider` type to `src/types.ts`**

Append to `src/types.ts`:

```ts
export type Provider = "anthropic" | "lm-studio";
```

- [ ] **Step 2: Write the failing test**

In `src/agent-config/agent-config.test.ts`, add:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "./agent-config.js";

describe("loadAgentConfig — provider field", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    mkdirSync(join(dir, "store"));
    writeFileSync(join(dir, "AGENTS.md"), "# test");
  });

  it("returns provider when present", () => {
    writeFileSync(join(dir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n");
    const cfg = loadAgentConfig(dir);
    expect(cfg.provider).toBe("anthropic");
  });

  it("throws when provider is missing", () => {
    writeFileSync(join(dir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\n");
    expect(() => loadAgentConfig(dir)).toThrow(/provider/);
  });

  it("throws when provider is not in the allowed set", () => {
    writeFileSync(join(dir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openai\n");
    expect(() => loadAgentConfig(dir)).toThrow(/provider/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/agent-config/agent-config.test.ts`
Expected: FAIL — `cfg.provider` is undefined; the error-cases also fail.

- [ ] **Step 4: Implement provider in agent-config.ts**

In `src/agent-config/agent-config.ts`, add `provider: Provider` to `AgentConfig`, import `Provider`, parse it from yaml:

```ts
import type { Provider } from "../types.js";

export interface AgentConfig {
  name: string;
  model: string;
  imageTag: string;
  provider: Provider;
  configPath: string;
  agentsMdPath: string;
  storePath: string;
}

// ... in loadAgentConfig, after the existing imageTag check:
const provider = parsed.provider;
if (typeof provider !== "string" || (provider !== "anthropic" && provider !== "lm-studio")) {
  throw new Error(`agent.yaml 'provider' must be 'anthropic' or 'lm-studio'`);
}

return { name, model, imageTag, provider, configPath, agentsMdPath, storePath };
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run src/agent-config/agent-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Update studio-assistant/agent.yaml**

Edit `agents/studio-assistant/agent.yaml` to add the `provider` field:

```yaml
name: studio-assistant
model: <existing model value>
image_tag: teamroom-agent-studio-assistant:latest
provider: lm-studio
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: all green. Any tests that construct an `AgentConfig` literal will need `provider: "lm-studio"` (or `"anthropic"` where appropriate) added — fix them inline.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(agent-config): require provider field in agent.yaml

Adds 'provider: anthropic | lm-studio' to AgentConfig.
studio-assistant declares 'provider: lm-studio' explicitly.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.4
"
```

---

## Phase 3 — Build the model-proxy module bottom-up

Each task in this phase is a self-contained unit with TDD. The pieces compose: types → token registry → span helpers → adapters → cache → proxy.

---

### Task 7: Define shared model-proxy types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add types**

Append to `src/types.ts`:

```ts
export type AuthMode = "api-key" | "oauth";

// Span-shaped log record fields shared across daemon/proxy/container.
export interface SpanFields {
  event: string;            // e.g., "model.call.completed", "turn.started"
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId?: string;
  turnId?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (the new types are exported but unused — TS strict tolerates that).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add AuthMode and SpanFields for model-proxy

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1
"
```

---

### Task 8: TokenRegistry

**Files:**
- Create: `src/model-proxy/token-registry.ts`
- Create: `src/model-proxy/token-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/model-proxy/token-registry.test.ts
import { describe, it, expect } from "vitest";
import { TokenRegistry } from "./token-registry.js";

const baseEntry = {
  agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic" as const, model: "m",
};

describe("TokenRegistry", () => {
  it("mintToken returns a non-empty string and lookup returns the entry", () => {
    const r = new TokenRegistry(() => "fixed-token");
    const tok = r.mint(baseEntry);
    expect(tok).toBe("fixed-token");
    expect(r.lookup(tok)).toEqual(baseEntry);
  });

  it("evict removes the entry; lookup-after-evict returns undefined", () => {
    const r = new TokenRegistry();
    const tok = r.mint(baseEntry);
    r.evict(tok);
    expect(r.lookup(tok)).toBeUndefined();
  });

  it("concurrent mints produce distinct tokens", () => {
    const r = new TokenRegistry();
    const tokens = new Set([r.mint(baseEntry), r.mint(baseEntry), r.mint(baseEntry)]);
    expect(tokens.size).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/model-proxy/token-registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement TokenRegistry**

```ts
// src/model-proxy/token-registry.ts
import { randomUUID } from "node:crypto";
import type { Provider } from "../types.js";

export interface TokenEntry {
  agentId: string;
  turnId: string;
  traceId: string;
  provider: Provider;
  model: string;
}

export class TokenRegistry {
  private readonly map = new Map<string, TokenEntry>();
  private readonly genId: () => string;

  constructor(genId: () => string = randomUUID) {
    this.genId = genId;
  }

  mint(entry: TokenEntry): string {
    const tok = this.genId();
    this.map.set(tok, entry);
    return tok;
  }

  lookup(token: string): TokenEntry | undefined {
    return this.map.get(token);
  }

  evict(token: string): void {
    this.map.delete(token);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/model-proxy/token-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model-proxy/token-registry.ts src/model-proxy/token-registry.test.ts
git commit -m "feat(model-proxy): add TokenRegistry

In-memory routing-token → entry map. Tokens minted per turn,
evicted on turn end. genId injectable for deterministic tests.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1
"
```

---

### Task 9: Span helpers

**Files:**
- Create: `src/model-proxy/span.ts`
- Create: `src/model-proxy/span.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/model-proxy/span.test.ts
import { describe, it, expect } from "vitest";
import { newSpanId, buildSpan } from "./span.js";

describe("span helpers", () => {
  it("newSpanId returns distinct ids", () => {
    const a = newSpanId();
    const b = newSpanId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("buildSpan composes the standard envelope", () => {
    const s = buildSpan({
      event: "model.call.completed",
      traceId: "tr-1",
      spanId: "sp-1",
      agentId: "a", turnId: "t",
      extra: { latencyMs: 12, status: "ok" },
    });
    expect(s).toMatchObject({
      event: "model.call.completed",
      traceId: "tr-1", spanId: "sp-1",
      agentId: "a", turnId: "t",
      latencyMs: 12, status: "ok",
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/model-proxy/span.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement span helpers**

```ts
// src/model-proxy/span.ts
import { randomUUID } from "node:crypto";
import type { SpanFields } from "../types.js";

export function newSpanId(): string {
  return randomUUID();
}

export interface BuildSpanInput extends SpanFields {
  extra?: Record<string, unknown>;
}

export function buildSpan(input: BuildSpanInput): Record<string, unknown> {
  const { extra, ...base } = input;
  return { ...base, ...(extra ?? {}) };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/model-proxy/span.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model-proxy/span.ts src/model-proxy/span.test.ts
git commit -m "feat(model-proxy): add span helpers

newSpanId() + buildSpan(). Used by proxy to emit span-shaped
log records under a consistent vocabulary.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §8
"
```

---

### Task 10: ProviderAdapter interface + LMStudioAdapter

**Files:**
- Create: `src/model-proxy/adapters/adapter.ts`
- Create: `src/model-proxy/adapters/lm-studio-adapter.ts`
- Create: `src/model-proxy/adapters/lm-studio-adapter.test.ts`

- [ ] **Step 1: Write the failing test for LMStudioAdapter**

```ts
// src/model-proxy/adapters/lm-studio-adapter.test.ts
import { describe, it, expect } from "vitest";
import { LmStudioAdapter } from "./lm-studio-adapter.js";

describe("LmStudioAdapter", () => {
  it("upstreamUrl returns the configured base URL", () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://localhost:1234", realKey: "real-tok" });
    expect(a.upstreamUrl()).toBe("http://localhost:1234");
  });

  it("authMode is always 'api-key'", () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "k" });
    expect(a.authMode).toBe("api-key");
  });

  it("injectAuth replaces Authorization with the real key", () => {
    const a = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "real-tok" });
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    a.injectAuth(headers);
    expect(headers.authorization).toBe("Bearer real-tok");
    // x-api-key is also passed through but LM Studio uses Bearer; still cleared:
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("extractUsage reads OpenAI-shape usage", () => {
    const u = new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "k" }).extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(u).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npx vitest run src/model-proxy/adapters/lm-studio-adapter.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Define the ProviderAdapter interface**

```ts
// src/model-proxy/adapters/adapter.ts
import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";

export interface UpstreamCallContext {
  // Reserved for future use (per-call context); empty in M2.
}

export interface ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode;
  upstreamUrl(): string;
  injectAuth(headers: OutgoingHttpHeaders): void;
  extractUsage(responseBody: unknown): {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

- [ ] **Step 4: Implement LmStudioAdapter**

```ts
// src/model-proxy/adapters/lm-studio-adapter.ts
import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

interface Opts { upstreamUrl: string; realKey: string }

export class LmStudioAdapter implements ProviderAdapter {
  readonly id: Provider = "lm-studio";
  readonly authMode: AuthMode = "api-key";
  private readonly opts: Opts;
  constructor(opts: Opts) { this.opts = opts; }

  upstreamUrl(): string { return this.opts.upstreamUrl; }

  injectAuth(headers: OutgoingHttpHeaders): void {
    headers.authorization = `Bearer ${this.opts.realKey}`;
    delete headers["x-api-key"];
  }

  extractUsage(responseBody: unknown): { inputTokens?: number; outputTokens?: number } {
    if (typeof responseBody !== "object" || responseBody === null) return {};
    const usage = (responseBody as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") return {};
    const inT = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const outT = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
    return { inputTokens: inT, outputTokens: outT };
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/model-proxy/adapters/lm-studio-adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/model-proxy/adapters/adapter.ts src/model-proxy/adapters/lm-studio-adapter.ts src/model-proxy/adapters/lm-studio-adapter.test.ts
git commit -m "feat(model-proxy): ProviderAdapter interface + LmStudioAdapter

Adapter knows upstream URL, how to inject the real auth header,
and how to extract usage from the response body. No request/
response body translation.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1
"
```

---

### Task 11: AnthropicAdapter (API-key mode)

**Files:**
- Create: `src/model-proxy/adapters/anthropic-adapter.ts`
- Create: `src/model-proxy/adapters/anthropic-adapter.test.ts`

The OAuth-mode logic comes in Task 13 after the cache (Task 12). For now this adapter only handles the API-key path.

- [ ] **Step 1: Write the failing test**

```ts
// src/model-proxy/adapters/anthropic-adapter.test.ts
import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter.js";

const apiKeyMode = { mode: "api-key" as const, apiKey: "sk-ant-real" };

describe("AnthropicAdapter — API-key mode", () => {
  it("upstreamUrl defaults to api.anthropic.com", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode });
    expect(a.upstreamUrl()).toBe("https://api.anthropic.com");
  });

  it("upstreamUrl honors override", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode, upstreamUrl: "http://test-server:9999" });
    expect(a.upstreamUrl()).toBe("http://test-server:9999");
  });

  it("authMode reflects the configured mode", () => {
    expect(new AnthropicAdapter({ auth: apiKeyMode }).authMode).toBe("api-key");
  });

  it("injectAuth replaces x-api-key with the real key", () => {
    const a = new AnthropicAdapter({ auth: apiKeyMode });
    const headers: Record<string, string | string[] | undefined> = {
      "x-api-key": "routing-token",
      authorization: "Bearer should-be-removed",
    };
    a.injectAuth(headers);
    expect(headers["x-api-key"]).toBe("sk-ant-real");
    expect(headers.authorization).toBeUndefined();
  });

  it("extractUsage reads Anthropic-shape usage", () => {
    const u = new AnthropicAdapter({ auth: apiKeyMode }).extractUsage({
      usage: { input_tokens: 7, output_tokens: 11 },
    });
    expect(u).toEqual({ inputTokens: 7, outputTokens: 11 });
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npx vitest run src/model-proxy/adapters/anthropic-adapter.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement AnthropicAdapter (API-key only for now)**

```ts
// src/model-proxy/adapters/anthropic-adapter.ts
import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

export type AnthropicAuth =
  | { mode: "api-key"; apiKey: string }
  | { mode: "oauth";   oauthToken: string };  // wired in Task 13

interface Opts {
  auth: AnthropicAuth;
  upstreamUrl?: string;     // default: https://api.anthropic.com
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: Provider = "anthropic";
  readonly authMode: AuthMode;
  private readonly opts: Opts;

  constructor(opts: Opts) {
    this.opts = opts;
    this.authMode = opts.auth.mode;
  }

  upstreamUrl(): string {
    return this.opts.upstreamUrl ?? "https://api.anthropic.com";
  }

  injectAuth(headers: OutgoingHttpHeaders): void {
    delete headers.authorization;
    if (this.opts.auth.mode === "api-key") {
      headers["x-api-key"] = this.opts.auth.apiKey;
      return;
    }
    // OAuth mode wired in Task 13; throw for now to make the gap visible.
    throw new Error("AnthropicAdapter OAuth mode not yet implemented (Task 13)");
  }

  extractUsage(responseBody: unknown): { inputTokens?: number; outputTokens?: number } {
    if (typeof responseBody !== "object" || responseBody === null) return {};
    const usage = (responseBody as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== "object") return {};
    const inT = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const outT = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    return { inputTokens: inT, outputTokens: outT };
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/model-proxy/adapters/anthropic-adapter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model-proxy/adapters/anthropic-adapter.ts src/model-proxy/adapters/anthropic-adapter.test.ts
git commit -m "feat(model-proxy): AnthropicAdapter (API-key mode)

OAuth mode stubbed — implemented in Task 13 once the temp-key
cache (Task 12) lands.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §6.1
"
```

---

### Task 12: AnthropicOAuthCache with single-flight semantics

**Files:**
- Create: `src/model-proxy/adapters/anthropic-oauth-cache.ts`
- Create: `src/model-proxy/adapters/anthropic-oauth-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/model-proxy/adapters/anthropic-oauth-cache.test.ts
import { describe, it, expect } from "vitest";
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

describe("AnthropicOAuthCache", () => {
  it("cache miss → fetch, then hit returns the same value", async () => {
    let fetchCount = 0;
    const fetcher = async () => { fetchCount += 1; return { tempKey: "tk-1", expiresAt: Date.now() + 60_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    expect(await c.get("oauth-tok", fetcher)).toBe("tk-1");
    expect(await c.get("oauth-tok", fetcher)).toBe("tk-1");
    expect(fetchCount).toBe(1);
  });

  it("expired entry triggers refetch", async () => {
    let t = 1_000_000;
    const fetcher = async () => { t += 0; return { tempKey: "tk-fresh", expiresAt: t + 1_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => t });
    await c.get("o", fetcher);
    t += 2_000;  // past expiry
    let count = 0;
    const f2 = async () => { count += 1; return { tempKey: "tk-new", expiresAt: t + 60_000 }; };
    const v = await c.get("o", f2);
    expect(v).toBe("tk-new");
    expect(count).toBe(1);
  });

  it("evict() forces refetch on next get", async () => {
    let count = 0;
    const fetcher = async () => { count += 1; return { tempKey: "tk-" + count, expiresAt: Date.now() + 60_000 }; };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    expect(await c.get("o", fetcher)).toBe("tk-1");
    c.evict("o");
    expect(await c.get("o", fetcher)).toBe("tk-2");
  });

  it("concurrent gets on a cold cache issue exactly one fetch (single-flight)", async () => {
    let fetchCount = 0;
    let resolve!: (v: { tempKey: string; expiresAt: number }) => void;
    const fetcher = () => {
      fetchCount += 1;
      return new Promise<{ tempKey: string; expiresAt: number }>(r => { resolve = r; });
    };
    const c = new AnthropicOAuthCache({ safetyMarginMs: 0, now: () => Date.now() });
    const p1 = c.get("o", fetcher);
    const p2 = c.get("o", fetcher);
    const p3 = c.get("o", fetcher);
    resolve({ tempKey: "tk-shared", expiresAt: Date.now() + 60_000 });
    expect(await p1).toBe("tk-shared");
    expect(await p2).toBe("tk-shared");
    expect(await p3).toBe("tk-shared");
    expect(fetchCount).toBe(1);
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npx vitest run src/model-proxy/adapters/anthropic-oauth-cache.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement AnthropicOAuthCache**

```ts
// src/model-proxy/adapters/anthropic-oauth-cache.ts
interface CacheEntry { tempKey: string; expiresAt: number }
type Fetcher = () => Promise<CacheEntry>;

interface Opts {
  safetyMarginMs?: number;     // expire treats `expiresAt - safetyMarginMs` as the boundary
  now?: () => number;          // injectable clock
}

export class AnthropicOAuthCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CacheEntry>>();
  private readonly safetyMarginMs: number;
  private readonly now: () => number;

  constructor(opts: Opts = {}) {
    this.safetyMarginMs = opts.safetyMarginMs ?? 5_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async get(oauthToken: string, fetcher: Fetcher): Promise<string> {
    const cached = this.entries.get(oauthToken);
    if (cached && cached.expiresAt - this.safetyMarginMs > this.now()) {
      return cached.tempKey;
    }
    const inflight = this.inflight.get(oauthToken);
    if (inflight) return (await inflight).tempKey;

    const p = (async () => {
      try {
        const entry = await fetcher();
        this.entries.set(oauthToken, entry);
        return entry;
      } finally {
        this.inflight.delete(oauthToken);
      }
    })();
    this.inflight.set(oauthToken, p);
    return (await p).tempKey;
  }

  evict(oauthToken: string): void {
    this.entries.delete(oauthToken);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/model-proxy/adapters/anthropic-oauth-cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model-proxy/adapters/anthropic-oauth-cache.ts src/model-proxy/adapters/anthropic-oauth-cache.test.ts
git commit -m "feat(model-proxy): AnthropicOAuthCache with single-flight

In-memory temp-key cache keyed by OAuth token. Concurrent get()
calls on a cold cache share one fetch. evict() forces refetch.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §6.2, §11 item 8
"
```

---

### Task 13: AnthropicAdapter OAuth-mode wiring

This task replaces the Task 11 OAuth-mode stub with a working impl that uses the cache and performs the server-to-server exchange.

**Files:**
- Modify: `src/model-proxy/adapters/anthropic-adapter.ts`
- Modify: `src/model-proxy/adapters/anthropic-adapter.test.ts`

- [ ] **Step 1: Update adapter API to accept cache + http fetcher dep**

The adapter no longer just slaps a header — for OAuth it needs to (a) read the cached temp key (or trigger an exchange) and (b) substitute `x-api-key` with that temp key. Easiest shape: introduce an async `resolveAuth(headers)` method that supersedes the synchronous `injectAuth` for the OAuth case, and have `LocalModelProxy` call `resolveAuth` instead.

Refactor `ProviderAdapter`:

```ts
// src/model-proxy/adapters/adapter.ts
import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";

export interface ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode;
  upstreamUrl(): string;
  /** Mutates `headers` to swap the routing-token placeholder for the real upstream credential. */
  resolveAuth(headers: OutgoingHttpHeaders): Promise<void>;
  extractUsage(responseBody: unknown): { inputTokens?: number; outputTokens?: number };
  /** OAuth only: invalidate the cached temp key after a 401 from upstream. */
  onUpstreamUnauthorized?(): void;
}
```

Update `LmStudioAdapter` and Task 11's existing `AnthropicAdapter` API-key path: rename `injectAuth` → `resolveAuth` returning `Promise<void>` (the existing logic still runs synchronously inside the async wrapper).

Update LM Studio test and AnthropicAdapter API-key tests to use `await a.resolveAuth(headers)`.

- [ ] **Step 2: Add OAuth-mode dependencies to AnthropicAdapter**

```ts
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

export type AnthropicAuth =
  | { mode: "api-key"; apiKey: string }
  | {
      mode: "oauth";
      oauthToken: string;
      cache: AnthropicOAuthCache;
      exchange: (oauthToken: string) => Promise<{ tempKey: string; expiresAt: number }>;
    };
```

The `exchange` callback is what does the actual server-to-server `POST /api/oauth/claude_cli/create_api_key` call. Injected so tests can use a fake exchange function.

In `resolveAuth`:

```ts
async resolveAuth(headers: OutgoingHttpHeaders): Promise<void> {
  delete headers.authorization;
  if (this.opts.auth.mode === "api-key") {
    headers["x-api-key"] = this.opts.auth.apiKey;
    return;
  }
  // OAuth mode
  const tempKey = await this.opts.auth.cache.get(
    this.opts.auth.oauthToken,
    () => this.opts.auth.mode === "oauth"
      ? this.opts.auth.exchange(this.opts.auth.oauthToken)
      : Promise.reject(new Error("unreachable")),
  );
  headers["x-api-key"] = tempKey;
}

onUpstreamUnauthorized(): void {
  if (this.opts.auth.mode === "oauth") this.opts.auth.cache.evict(this.opts.auth.oauthToken);
}
```

- [ ] **Step 3: Add OAuth-mode tests**

Append to `src/model-proxy/adapters/anthropic-adapter.test.ts`:

```ts
import { AnthropicOAuthCache } from "./anthropic-oauth-cache.js";

describe("AnthropicAdapter — OAuth mode", () => {
  it("first call fetches via exchange and stores the temp key in headers", async () => {
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async (tok: string) => ({ tempKey: "tk-" + tok, expiresAt: Date.now() + 60_000 });
    const a = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: "oauth-1", cache, exchange },
    });
    const headers: Record<string, string | string[] | undefined> = { "x-api-key": "routing" };
    await a.resolveAuth(headers);
    expect(headers["x-api-key"]).toBe("tk-oauth-1");
  });

  it("second call within TTL reuses cached temp key (no second exchange)", async () => {
    let exchangeCount = 0;
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => { exchangeCount += 1; return { tempKey: "tk", expiresAt: Date.now() + 60_000 }; };
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    await a.resolveAuth({ "x-api-key": "x" });
    await a.resolveAuth({ "x-api-key": "x" });
    expect(exchangeCount).toBe(1);
  });

  it("onUpstreamUnauthorized() forces refetch on next resolveAuth", async () => {
    let exchangeCount = 0;
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => { exchangeCount += 1; return { tempKey: "tk-" + exchangeCount, expiresAt: Date.now() + 60_000 }; };
    const a = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "o", cache, exchange } });
    await a.resolveAuth({ "x-api-key": "x" });
    a.onUpstreamUnauthorized?.();
    await a.resolveAuth({ "x-api-key": "x" });
    expect(exchangeCount).toBe(2);
  });
});
```

- [ ] **Step 4: Run all adapter tests**

Run: `npx vitest run src/model-proxy/adapters/`
Expected: all PASS (LM Studio + Anthropic API-key + Anthropic OAuth + cache).

- [ ] **Step 5: Commit**

```bash
git add src/model-proxy/adapters/
git commit -m "feat(model-proxy): AnthropicAdapter OAuth mode with cache integration

Refactors ProviderAdapter to async resolveAuth and adds onUpstreamUnauthorized
hook for credential-refresh retry. AnthropicAdapter OAuth mode resolves the
temp key through the cache (single-flight); cache eviction on 401 supports
the credential-refresh retry path implemented by LocalModelProxy in Task 15.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §6.2, §5
"
```

---

### Task 14: ModelProxy interface

**Files:**
- Create: `src/model-proxy/model-proxy.ts`

- [ ] **Step 1: Define the interface**

```ts
// src/model-proxy/model-proxy.ts
import type { TokenEntry } from "./token-registry.js";

export interface MintTokenInput extends TokenEntry {}

export interface ModelProxy {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  mint(input: MintTokenInput): string;
  evict(token: string): void;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/model-proxy/model-proxy.ts
git commit -m "feat(model-proxy): ModelProxy interface

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1
"
```

---

### Task 15: LocalModelProxy http server + routing

**Files:**
- Create: `src/model-proxy/local-model-proxy.ts`
- Create: `src/model-proxy/local-model-proxy.test.ts`

This is the substantive proxy implementation. Routing happens by reading `x-api-key`, looking it up in the `TokenRegistry`, and handing off to the adapter for that entry's provider. Includes the credential-refresh retry on 401.

- [ ] **Step 1: Write the failing test**

```ts
// src/model-proxy/local-model-proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, request as httpRequest } from "node:http";
import { AddressInfo } from "node:net";
import { LocalModelProxy } from "./local-model-proxy.js";
import { TokenRegistry } from "./token-registry.js";
import { AnthropicAdapter } from "./adapters/anthropic-adapter.js";
import { LmStudioAdapter } from "./adapters/lm-studio-adapter.js";
import { CapturingLogger } from "../logger/logger.js";  // confirm path

interface Recorded { method: string; path: string; headers: Record<string, string|string[]|undefined>; body: string; }

function startFakeUpstream(handler: (req: Recorded) => { status: number; body: string }): Promise<{ url: string; close: () => Promise<void>; recorded: Recorded[] }> {
  return new Promise((resolve) => {
    const recorded: Recorded[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const r: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
        recorded.push(r);
        const out = handler(r);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    }).listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
        recorded,
      });
    });
  });
}

async function postToProxy(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; headers: Record<string, string|string[]|undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("LocalModelProxy", () => {
  let logger: CapturingLogger;

  beforeEach(() => {
    logger = new CapturingLogger();  // M1 test util
  });

  it("API-key mode: substitutes x-api-key with real key and forwards", async () => {
    const upstream = await startFakeUpstream(() => ({ status: 200, body: JSON.stringify({ id: "x", usage: { input_tokens: 1, output_tokens: 2 } }) }));
    const registry = new TokenRegistry();
    const adapter = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "sk-real" }, upstreamUrl: upstream.url });
    const proxy = new LocalModelProxy({ registry, adapters: { anthropic: adapter, "lm-studio": new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "_" }) }, logger });
    const { port } = await proxy.start();
    const tok = registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "claude-x" });

    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    expect(upstream.recorded[0].headers["x-api-key"]).toBe("sk-real");

    const span = logger.records.find(r => (r as { event?: string }).event === "model.call.completed");
    expect(span).toMatchObject({ provider: "anthropic", inputTokens: 1, outputTokens: 2, status: "ok" });

    await proxy.stop();
    await upstream.close();
  });

  it("unknown routing token → 401 with model.call.rejected span", async () => {
    const registry = new TokenRegistry();
    const adapter = new LmStudioAdapter({ upstreamUrl: "http://unused", realKey: "_" });
    const proxy = new LocalModelProxy({ registry, adapters: { anthropic: adapter as any, "lm-studio": adapter }, logger });
    const { port } = await proxy.start();
    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": "ghost-token" }, "{}");
    expect(resp.status).toBe(401);
    const span = logger.records.find(r => (r as { event?: string }).event === "model.call.rejected");
    expect(span).toMatchObject({ errorClass: "unknown_token" });
    await proxy.stop();
  });

  it("OAuth mode: 401 from upstream triggers credential-refresh retry exactly once", async () => {
    let upstreamCalls = 0;
    const upstream = await startFakeUpstream(() => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) return { status: 401, body: '{"error":"expired"}' };
      return { status: 200, body: '{"usage":{"input_tokens":3,"output_tokens":4}}' };
    });
    let exchangeCalls = 0;
    const cache = new (await import("./adapters/anthropic-oauth-cache.js")).AnthropicOAuthCache({ safetyMarginMs: 0 });
    // pre-seed cache with a "known" temp key so first call uses cache, gets 401, evicts, refetches via exchange
    await cache.get("oauth-tok", async () => ({ tempKey: "tk-stale", expiresAt: Date.now() + 60_000 }));
    const adapter = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: "oauth-tok", cache, exchange: async () => { exchangeCalls += 1; return { tempKey: "tk-fresh", expiresAt: Date.now() + 60_000 }; } },
      upstreamUrl: upstream.url,
    });
    const registry = new TokenRegistry();
    const proxy = new LocalModelProxy({ registry, adapters: { anthropic: adapter, "lm-studio": new LmStudioAdapter({ upstreamUrl: "http://x", realKey: "_" }) }, logger });
    const { port } = await proxy.start();
    const tok = registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "claude-x" });
    const resp = await postToProxy(port, "/v1/messages", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    expect(exchangeCalls).toBe(1);
    await proxy.stop();
    await upstream.close();
  });

  it("upstream timeout → 504 + upstream_timeout span", async () => {
    const upstream = await startFakeUpstream(async () => { await new Promise(r => setTimeout(r, 200)); return { status: 200, body: "{}" }; });
    const registry = new TokenRegistry();
    const adapter = new LmStudioAdapter({ upstreamUrl: upstream.url, realKey: "k" });
    const proxy = new LocalModelProxy({ registry, adapters: { anthropic: adapter as any, "lm-studio": adapter }, logger, upstreamTimeoutMs: 50 });
    const { port } = await proxy.start();
    const tok = registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "lm-studio", model: "x" });
    const resp = await postToProxy(port, "/v1/chat/completions", { "x-api-key": tok }, "{}");
    expect(resp.status).toBe(504);
    expect(logger.records.find(r => (r as { status?: string }).status === "upstream_timeout")).toBeTruthy();
    await proxy.stop();
    await upstream.close();
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `npx vitest run src/model-proxy/local-model-proxy.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement LocalModelProxy**

```ts
// src/model-proxy/local-model-proxy.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { AddressInfo } from "node:net";
import type { Logger } from "../logger/logger.js";
import type { Provider } from "../types.js";
import type { ProviderAdapter } from "./adapters/adapter.js";
import { TokenRegistry } from "./token-registry.js";
import { newSpanId, buildSpan } from "./span.js";
import type { MintTokenInput, ModelProxy } from "./model-proxy.js";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

interface Opts {
  registry: TokenRegistry;
  adapters: Record<Provider, ProviderAdapter>;
  logger: Logger;
  upstreamTimeoutMs?: number;     // default 60_000
  host?: string;                  // default "127.0.0.1"
}

export class LocalModelProxy implements ModelProxy {
  private server: Server | undefined;
  private readonly opts: Opts;

  constructor(opts: Opts) {
    this.opts = opts;
  }

  mint(input: MintTokenInput): string { return this.opts.registry.mint(input); }
  evict(token: string): void { this.opts.registry.evict(token); }

  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const s = createServer((req, res) => { void this.handle(req, res); });
      s.on("error", reject);
      s.listen(0, this.opts.host ?? "127.0.0.1", () => {
        this.server = s;
        const port = (s.address() as AddressInfo).port;
        resolve({ port });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      void this.dispatch(req, res, body);
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    const apiKeyHdr = req.headers["x-api-key"];
    const routingToken = Array.isArray(apiKeyHdr) ? apiKeyHdr[0] : apiKeyHdr;
    if (!routingToken) {
      this.opts.logger.info(buildSpan({
        event: "model.call.rejected", traceId: "unknown", spanId: newSpanId(),
        extra: { errorClass: "missing_token" },
      }));
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"missing_token"}');
      return;
    }
    const entry = this.opts.registry.lookup(routingToken);
    if (!entry) {
      this.opts.logger.info(buildSpan({
        event: "model.call.rejected", traceId: "unknown", spanId: newSpanId(),
        extra: { errorClass: "unknown_token", tokenPrefix: routingToken.slice(0, 8) },
      }));
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unknown_token"}');
      return;
    }
    const adapter = this.opts.adapters[entry.provider];
    if (!adapter) {
      this.opts.logger.error(buildSpan({
        event: "model.call.rejected", traceId: entry.traceId, spanId: newSpanId(),
        agentId: entry.agentId, turnId: entry.turnId,
        extra: { errorClass: "no_adapter", provider: entry.provider },
      }));
      res.writeHead(500); res.end(); return;
    }

    await this.forwardWithRetry(req, res, body, entry, adapter, /*retried*/ false);
  }

  private async forwardWithRetry(req: IncomingMessage, res: ServerResponse, body: Buffer, entry: import("./token-registry.js").TokenEntry, adapter: ProviderAdapter, retried: boolean): Promise<void> {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    headers["content-length"] = String(body.length);

    try {
      await adapter.resolveAuth(headers as import("node:http").OutgoingHttpHeaders);
    } catch (err) {
      this.opts.logger.error(buildSpan({
        event: "model.call.rejected", traceId: entry.traceId, spanId: newSpanId(),
        agentId: entry.agentId, turnId: entry.turnId,
        extra: { errorClass: "resolve_auth_failed", error: String(err) },
      }));
      res.writeHead(502); res.end('{"error":"resolve_auth_failed"}'); return;
    }

    const upstreamUrl = new URL(adapter.upstreamUrl());
    const isHttps = upstreamUrl.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    const timeoutMs = this.opts.upstreamTimeoutMs ?? 60_000;

    headers.host = upstreamUrl.host;

    const upstreamReq = reqFn({
      host: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: req.url ?? "/",
      method: req.method ?? "POST",
      headers: headers as import("node:http").OutgoingHttpHeaders,
    }, async (upstreamRes) => {
      const upstreamChunks: Buffer[] = [];
      upstreamRes.on("data", c => upstreamChunks.push(c));
      upstreamRes.on("end", async () => {
        const upBody = Buffer.concat(upstreamChunks);
        const status = upstreamRes.statusCode ?? 0;

        // Credential-refresh retry: only one, only on OAuth + 401
        if (status === 401 && adapter.authMode === "oauth" && !retried) {
          adapter.onUpstreamUnauthorized?.();
          await this.forwardWithRetry(req, res, body, entry, adapter, true);
          return;
        }

        // Try to parse usage; ignore if not JSON
        let parsed: unknown;
        try { parsed = JSON.parse(upBody.toString("utf8")); } catch { parsed = undefined; }
        const usage = parsed === undefined ? {} : adapter.extractUsage(parsed);

        const finishedAt = new Date(Date.now()).toISOString();
        this.opts.logger.info(buildSpan({
          event: "model.call.completed",
          traceId: entry.traceId,
          spanId: newSpanId(),
          agentId: entry.agentId, turnId: entry.turnId,
          extra: {
            provider: entry.provider, model: entry.model,
            startedAt, finishedAt, latencyMs: Date.now() - start,
            httpStatus: status,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            status: status >= 200 && status < 300 ? "ok" : "upstream_error",
            errorClass: status >= 200 && status < 300 ? undefined : `${status}_${entry.provider}`,
          },
        }));

        res.writeHead(status, upstreamRes.headers);
        res.end(upBody);
      });
    });

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error("upstream_timeout"));
    });

    upstreamReq.on("error", (err) => {
      const finishedAt = new Date(Date.now()).toISOString();
      const isTimeout = err.message === "upstream_timeout";
      this.opts.logger.warn(buildSpan({
        event: "model.call.completed",
        traceId: entry.traceId, spanId: newSpanId(),
        agentId: entry.agentId, turnId: entry.turnId,
        extra: {
          provider: entry.provider, model: entry.model,
          startedAt, finishedAt, latencyMs: Date.now() - start,
          status: isTimeout ? "upstream_timeout" : "upstream_error",
          errorClass: isTimeout ? "timeout" : "network_error",
          error: String(err.message),
        },
      }));
      if (!res.headersSent) {
        res.writeHead(isTimeout ? 504 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: isTimeout ? "upstream_timeout" : "upstream_error" }));
      } else {
        res.end();
      }
    });

    upstreamReq.write(body);
    upstreamReq.end();
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/model-proxy/local-model-proxy.test.ts`
Expected: PASS (4 tests). If a test fails, read the error carefully — the most common issues are: header-name casing (Node lowercases incoming headers but `OutgoingHttpHeaders` uses what you give it), or the timeout test racing the test runner.

- [ ] **Step 5: Run the whole proxy module's tests**

Run: `npx vitest run src/model-proxy/`
Expected: all PASS (token-registry + span + adapters + cache + local-model-proxy).

- [ ] **Step 6: Commit**

```bash
git add src/model-proxy/local-model-proxy.ts src/model-proxy/local-model-proxy.test.ts
git commit -m "feat(model-proxy): LocalModelProxy http server + routing

In-process http server bound to 127.0.0.1. Reads x-api-key for routing,
hands off to the right ProviderAdapter for auth substitution, forwards
to upstream, emits span-shaped log on completion. OAuth mode performs
exactly one credential-refresh retry on a 401.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1, §4 t6/t7, §5
"
```

---

### Task 16: Module README for `src/model-proxy/`

**Files:**
- Create: `src/model-proxy/README.md`

- [ ] **Step 1: Write the README following the project convention**

```markdown
# `model-proxy/` — credential-isolated provider proxy

`ModelProxy` is the in-daemon HTTP listener that containers point at instead of upstream model providers directly. Containers hold only an ephemeral routing token; the proxy substitutes it for the real upstream credential (real API key in API-key mode, cached OAuth-exchange temp key in OAuth mode) before forwarding. The `ProviderAdapter` interface generalises across providers: each adapter knows its upstream URL, its auth-injection scheme, and how to read token usage from the response. Routing is purely by registry lookup of the `x-api-key` header value; request and response bodies are forwarded as bytes without translation.

**Runs on the host in the daemon process.** Bound to `127.0.0.1` on an OS-assigned port; the daemon injects the URL into each container's env at spawn time. The container talks to the proxy over plain HTTP/1.1; the proxy itself uses HTTPS to reach the real Anthropic API. The container never sees real credentials and never knows which auth mode the proxy is configured for.

M2 scope: Anthropic + LM Studio backends; per-agent provider declared in `agent.yaml`; one bounded credential-refresh retry on 401 (OAuth only). Multi-model-per-agent, request-body validation, rate-limit handling, and bus-event emission are deferred — see [`docs/tabled.md`](../../docs/tabled.md).

## Files

- `model-proxy.ts` — `ModelProxy` interface (`start`/`stop`/`mint`/`evict`).
- `local-model-proxy.ts` — `LocalModelProxy`, the production http-server impl.
- `token-registry.ts` — in-memory routing-token → entry map.
- `span.ts` — `newSpanId()` + `buildSpan()` for span-shaped log records.
- `adapters/adapter.ts` — `ProviderAdapter` interface.
- `adapters/anthropic-adapter.ts` — Anthropic adapter, both auth modes.
- `adapters/anthropic-oauth-cache.ts` — temp-key cache with single-flight semantics.
- `adapters/lm-studio-adapter.ts` — LM Studio (OpenAI-compatible) adapter.
- `*.test.ts` — co-located unit tests using real http on ephemeral ports.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [logger/](../logger/), [types.ts](../types.ts), Node `http`/`https`/`crypto`.
- **Used by:** [daemon/](../daemon/README.md) (composition root + turn-processor).
- **Container counterpart:** [agent-runtime/](../agent-runtime/README.md) — `AnthropicLlmClient` is mode-agnostic; all OAuth machinery lives here, not there.
- **Spec:** [M2 design](../../docs/specs/2026-04-18-m2-model-abstraction-design.md) — §3.1 (interfaces), §4 (data flow), §6 (auth modes).
- **Memory:** [project_teamroom_langgraph_direction](../../docs/memory/project_teamroom_langgraph_direction.md) — the language-agnostic container contract is preserved by this module.
```

- [ ] **Step 2: Update `src/README.md` module index**

Add a bullet for `model-proxy/`:

```markdown
- [`model-proxy/`](model-proxy/README.md) — `ModelProxy` seam; in-daemon HTTP proxy that swaps routing tokens for real upstream credentials. Two-mode Anthropic auth.
```

(Place it alphabetically near the other modules.)

- [ ] **Step 3: Commit**

```bash
git add src/model-proxy/README.md src/README.md
git commit -m "docs(model-proxy): module README + index entry

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.1
"
```

---

## Phase 4 — Wire model-proxy into the daemon

---

### Task 17: Composition root + credential discovery

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/daemon.ts`

This task wires `LocalModelProxy` into the daemon, replaces the static `modelBaseUrl`/`modelApiToken` daemon options with a `ModelProxy` instance, and implements the credential discovery (OAuth preferred → API key fallback).

- [ ] **Step 1: Implement credential discovery in main.ts**

Replace the body of `src/daemon/main.ts`:

```ts
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { startDaemon } from "./daemon.js";
import { readEnvFile } from "../env/env-file.js";

interface AnthropicCreds {
  mode: "api-key";
  apiKey: string;
} | {
  mode: "oauth";
  oauthToken: string;
};

function discoverAnthropic(envFromDotenv: Record<string, string>): AnthropicCreds | null {
  const oauthFromEnv = envFromDotenv.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthFromEnv) return { mode: "oauth", oauthToken: oauthFromEnv };
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, unknown>;
      // Be permissive about field names; Claude Code's exact shape is best-effort.
      const tok = (typeof parsed.oauth_token === "string" && parsed.oauth_token)
        || (typeof parsed.access_token === "string" && parsed.access_token)
        || (typeof parsed.token === "string" && parsed.token);
      if (tok) return { mode: "oauth", oauthToken: tok };
    } catch { /* unrecognized format — fall through */ }
  }
  if (envFromDotenv.ANTHROPIC_API_KEY) return { mode: "api-key", apiKey: envFromDotenv.ANTHROPIC_API_KEY };
  return null;
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const env = readEnvFile(root, ["LM_STUDIO_API_TOKEN", "LM_STUDIO_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const lmStudioToken = env.LM_STUDIO_API_TOKEN;
  if (!lmStudioToken) {
    process.stderr.write("LM_STUDIO_API_TOKEN missing from .env\n");
    process.exit(1);
  }
  const anthropic = discoverAnthropic(env);
  // anthropic may be null — daemon will refuse turns for any provider:anthropic agent if so.

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    lmStudio: {
      upstreamUrl: env.LM_STUDIO_BASE_URL ?? "http://host.docker.internal:1234",
      realKey: lmStudioToken,
    },
    anthropic,
  });

  const shutdown = async () => { await daemon.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

void main();
```

- [ ] **Step 2: Update `startDaemon` options + composition**

In `src/daemon/daemon.ts`, change the `DaemonOptions` shape and wire the proxy:

```ts
import { LocalModelProxy } from "../model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../model-proxy/token-registry.js";
import { AnthropicAdapter } from "../model-proxy/adapters/anthropic-adapter.js";
import { LmStudioAdapter } from "../model-proxy/adapters/lm-studio-adapter.js";
import { AnthropicOAuthCache } from "../model-proxy/adapters/anthropic-oauth-cache.js";
import { request as httpsRequest } from "node:https";
import type { Provider } from "../types.js";
import type { ProviderAdapter } from "../model-proxy/adapters/adapter.js";

export interface DaemonOptions {
  dataDir: string;
  agentsDir: string;
  lmStudio: { upstreamUrl: string; realKey: string };
  anthropic: { mode: "api-key"; apiKey: string } | { mode: "oauth"; oauthToken: string } | null;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
}

// ... inside startDaemon, replace the runner/orchestrator construction with:

const adapters: Record<Provider, ProviderAdapter | null> = {
  "lm-studio": new LmStudioAdapter(opts.lmStudio),
  "anthropic": null,
};

if (opts.anthropic) {
  if (opts.anthropic.mode === "api-key") {
    adapters.anthropic = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: opts.anthropic.apiKey } });
  } else {
    const cache = new AnthropicOAuthCache({});
    const exchange = async (oauthToken: string): Promise<{ tempKey: string; expiresAt: number }> => {
      // POST https://api.anthropic.com/api/oauth/claude_cli/create_api_key
      // with Authorization: Bearer <oauthToken>. Response shape:
      //   { api_key: string, expires_at?: number (ms epoch) | string }.
      // Verify the exact response shape on the first real call (M2 risk #2).
      return await new Promise((resolveP, rejectP) => {
        const body = "";
        const req = httpsRequest({
          host: "api.anthropic.com",
          path: "/api/oauth/claude_cli/create_api_key",
          method: "POST",
          headers: { authorization: `Bearer ${oauthToken}`, "content-length": "0" },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            try {
              if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
                rejectP(new Error(`oauth_exchange_${res.statusCode}`));
                return;
              }
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
              const tempKey = String(parsed.api_key ?? "");
              if (!tempKey) { rejectP(new Error("oauth_exchange_no_key")); return; }
              const expRaw = parsed.expires_at;
              const expiresAt = typeof expRaw === "number" ? expRaw : (typeof expRaw === "string" ? Date.parse(expRaw) : Date.now() + 60 * 60 * 1000); // 1h fallback
              resolveP({ tempKey, expiresAt });
            } catch (err) { rejectP(err as Error); }
          });
        });
        req.on("error", rejectP);
        req.write(body);
        req.end();
      });
    };
    adapters.anthropic = new AnthropicAdapter({
      auth: { mode: "oauth", oauthToken: opts.anthropic.oauthToken, cache, exchange },
    });
  }
}

const proxy = new LocalModelProxy({
  registry: new TokenRegistry(genId),
  // Cast non-null adapters in; null Anthropic remains, and turn-processor will refuse provider:anthropic
  // turns when adapter is missing.
  adapters: adapters as Record<Provider, ProviderAdapter>,
  logger: rootLogger.child({ component: "model-proxy" }),
});
const proxyInfo = await proxy.start();
const proxyBaseUrl = `http://host.docker.internal:${proxyInfo.port}`;

// ... pass proxy + proxyBaseUrl to Orchestrator in place of the old modelBaseUrl/modelApiToken:
const orchestrator = new Orchestrator({
  messageRepo, turnRepo, bus, logger: rootLogger, clock, runner,
  agentConfigs,
  modelProxy: proxy,
  modelBaseUrl: proxyBaseUrl,
  anthropicAdapterPresent: adapters.anthropic !== null,
  turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
  pollIntervalMs: opts.pollIntervalMs ?? 200,
  genId,
});

// extend stop() to also stop the proxy:
const stop = async () => {
  if (stopped) return;
  stopped = true;
  orchestrator.stop();
  await loopPromise;
  await proxy.stop();
  await bus.close();
  db.close();
  try { unlinkSync(pidFile); } catch { /* gone */ }
};
```

- [ ] **Step 3: Update Orchestrator and dependent types**

Update `src/daemon/orchestrator.ts` so it passes `modelProxy` + `modelBaseUrl` + `anthropicAdapterPresent` through to `processTurn` (Task 18 will use them). Adjust `OrchestratorOptions` accordingly. Type-check after editing.

- [ ] **Step 4: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: most tests pass; orchestrator/turn-processor tests will need `modelProxy` / new option-shape stubs (we wire those in Task 18). For now, fix the typecheck errors by passing in a small fake `ModelProxy` (real in-memory; not a mock library) where needed in tests:

```ts
class StubModelProxy implements ModelProxy {
  start = async () => ({ port: 0 });
  stop = async () => {};
  private next = 0;
  mint = () => `tok-${this.next++}`;
  evict = () => {};
}
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/main.ts src/daemon/daemon.ts src/daemon/orchestrator.ts src/daemon/orchestrator.test.ts src/daemon/turn-processor.test.ts
git commit -m "feat(daemon): wire LocalModelProxy + credential discovery

OAuth preferred (env or ~/.claude/.credentials.json), API key fallback.
Daemon options now take separate lmStudio + anthropic credential blocks
instead of one modelBaseUrl/modelApiToken pair. Orchestrator forwards
the proxy down to processTurn.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.5, §6.3
"
```

---

### Task 18: turn-processor — mint/evict tokens + markRunning ordering (M1 debt #1, part 1)

**Files:**
- Modify: `src/daemon/turn-processor.ts`
- Modify: `src/daemon/turn-processor.test.ts`

- [ ] **Step 1: Update ProcessTurnDeps and the processing flow**

In `src/daemon/turn-processor.ts`:

```ts
import type { ModelProxy } from "../model-proxy/model-proxy.js";

export interface ProcessTurnDeps {
  inbound: Message;
  agentConfig: AgentConfig;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  runner: ContainerRunner;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  modelProxy: ModelProxy;
  modelBaseUrl: string;
  anthropicAdapterPresent: boolean;
  timeoutMs: number;
  genId: () => string;
}

export async function processTurn(deps: ProcessTurnDeps): Promise<void> {
  const {
    inbound, agentConfig, messageRepo, turnRepo, runner, bus, logger, clock,
    modelProxy, modelBaseUrl, anthropicAdapterPresent, timeoutMs, genId,
  } = deps;

  const turnId = genId();
  const now = clock.nowIso();
  const turnLogger = logger.child({
    component: "turn-processor",
    turnId, traceId: inbound.traceId, agentName: agentConfig.name,
  });

  // 1. Create + immediately mark running with placeholder containerId (debt #1)
  turnRepo.create({
    id: turnId, agentId: inbound.agentId, inboundMessageId: inbound.id,
    status: "pending", containerId: null, error: null, traceId: inbound.traceId,
    startedAt: null, finishedAt: null, createdAt: now,
  });
  messageRepo.attachTurn(inbound.id, turnId);
  turnRepo.markRunning(turnId, "pending-spawn", clock.nowIso());

  // 2. Refuse provider:anthropic if no adapter is configured.
  if (agentConfig.provider === "anthropic" && !anthropicAdapterPresent) {
    turnRepo.markError(turnId, "missing_credential", clock.nowIso());
    await bus.publish({
      id: genId(), type: "turn.errored", ts: clock.nowIso(),
      agentId: inbound.agentId, turnId, traceId: inbound.traceId,
      error: "missing_credential",
    });
    turnLogger.warn("turn errored: missing anthropic credential");
    return;
  }

  // 3. Mint routing token + emit turn.started (bus + log)
  const token = modelProxy.mint({
    agentId: inbound.agentId, turnId, traceId: inbound.traceId,
    provider: agentConfig.provider, model: agentConfig.model,
  });
  await bus.publish({
    id: genId(), type: "turn.started", ts: clock.nowIso(),
    agentId: inbound.agentId, turnId, traceId: inbound.traceId,
  });
  turnLogger.info({ event: "turn.started" } as any);

  try {
    const mounts: Mount[] = [
      { hostPath: agentConfig.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },  // M2 contract change
      { hostPath: agentConfig.storePath, containerPath: "/store", readOnly: false },
    ];
    const spec: DockerRunSpec = {
      imageTag: agentConfig.imageTag,
      mounts,
      env: {
        TEAMROOM_TRACE_ID: inbound.traceId,
        TEAMROOM_TURN_ID: turnId,
        TEAMROOM_AGENT_NAME: agentConfig.name,
        TEAMROOM_PROVIDER: agentConfig.provider,
        TEAMROOM_MODEL: agentConfig.model,
        TEAMROOM_MODEL_BASE_URL: modelBaseUrl,
        TEAMROOM_MODEL_API_TOKEN: token,
      },
    };
    const stdinEnvelope = JSON.stringify({
      prompt: inbound.body, messageId: inbound.id, turnId, traceId: inbound.traceId,
    });

    let replyCount = 0;
    const result = await runner.run({
      spec, stdinJson: stdinEnvelope, timeoutMs,
      onEvent: (evt) => {
        // (existing event-handling block; copy from current turn-processor.ts unchanged)
        try {
          if (evt.type === "reply") {
            const outId = genId();
            messageRepo.create({
              id: outId, agentId: inbound.agentId, channel: inbound.channel,
              direction: "out", body: evt.body, turnId, traceId: inbound.traceId,
              createdAt: clock.nowIso(),
            });
            replyCount += 1;
            void bus.publish({
              id: genId(), type: "message.outbound", ts: clock.nowIso(),
              agentId: inbound.agentId, messageId: outId, turnId, traceId: inbound.traceId,
            });
          } else if (evt.type === "status") {
            turnLogger.info("status", { phase: evt.phase });
          } else if (evt.type === "log") {
            turnLogger.info("agent-log", { level: evt.level, msg: evt.msg });
          } else {
            turnLogger.warn("unknown stdout event", { raw: (evt as { raw?: string }).raw });
          }
        } catch (err) {
          turnLogger.error("error handling stdout event", { error: String(err) });
        }
      },
    });

    // Update with the real container id (was "pending-spawn")
    turnRepo.markRunning(turnId, result.containerId, clock.nowIso());

    if (result.timedOut) {
      turnRepo.markError(turnId, "timeout", clock.nowIso());
      await bus.publish({
        id: genId(), type: "turn.errored", ts: clock.nowIso(),
        agentId: inbound.agentId, turnId, traceId: inbound.traceId, error: "timeout",
      });
      turnLogger.warn("turn timed out");
      return;
    }

    if (result.exitCode !== 0) {
      const snippet = result.stderr.slice(-2048);
      const errorText = `exit=${result.exitCode}; stderr=${snippet}`;
      turnRepo.markError(turnId, errorText, clock.nowIso());
      await bus.publish({
        id: genId(), type: "turn.errored", ts: clock.nowIso(),
        agentId: inbound.agentId, turnId, traceId: inbound.traceId, error: errorText,
      });
      turnLogger.warn("turn errored", { exitCode: result.exitCode });
      return;
    }

    turnRepo.markDone(turnId, clock.nowIso());
    await bus.publish({
      id: genId(), type: "turn.completed", ts: clock.nowIso(),
      agentId: inbound.agentId, turnId, traceId: inbound.traceId,
    });
    turnLogger.info("turn done", { replyCount });
  } finally {
    modelProxy.evict(token);
  }
}
```

Note: requires `turnRepo.markRunning` to accept being called twice (first with placeholder then with real id). Confirm by reading `src/db/turn-repo.ts`'s `markRunning` — if it's an UPDATE keyed by id, calling twice is fine.

- [ ] **Step 2: Add tests for the new behavior**

In `src/daemon/turn-processor.test.ts`, add or modify:

```ts
it("calls markRunning with placeholder before runner.run, then updates with real container id", async () => {
  // Use the existing FakeRunner pattern; capture ordering by recording markRunning calls.
  // Assert the first markRunning call has containerId === "pending-spawn" and happens
  // before runner.run is invoked.
});

it("mints a routing token and evicts it on success", async () => {
  // StubModelProxy records mint/evict; assert mint() called once before runner.run,
  // evict() called once with the same token after runner.run resolves.
});

it("evicts the routing token even when the container errors", async () => {
  // Configure FakeRunner to return exitCode=1; assert evict still called.
});

it("refuses provider:anthropic agents when anthropicAdapterPresent is false", async () => {
  // Configure agentConfig.provider = "anthropic", anthropicAdapterPresent=false.
  // Assert turnRepo gets markError("missing_credential") and runner.run is never called.
});
```

(Use the existing test-fixture style — read other tests in this file for shape.)

- [ ] **Step 3: Run the tests, verify pass**

Run: `npx vitest run src/daemon/turn-processor.test.ts`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all green. The integration test `tests/integration/end-to-end.test.ts` will need updating in Task 27 — it might be temporarily failing here; if so, mark and continue (we'll fix it in Task 27).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/turn-processor.ts src/daemon/turn-processor.test.ts
git commit -m "feat(daemon): turn-processor mints/evicts routing tokens; markRunning before runner.run

Closes M1 debt #1 (part 1): turn rows transition pending → running
before container spawn, with a placeholder container_id later
replaced by the real one. Routing token is minted before spawn and
evicted in a finally block. provider:anthropic agents without an
adapter fail fast with missing_credential.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §4 t2/t3, §5
"
```

---

### Task 19: Reconciler aged-`pending` sweep (M1 debt #1, part 2)

**Files:**
- Modify: `src/daemon/reconcile.ts`
- Modify: `src/daemon/reconcile.test.ts`

- [ ] **Step 1: Read current reconcile**

Read `src/daemon/reconcile.ts` to confirm current behavior (sweeps `running` → mark errored). The new behavior also sweeps `pending` rows with no `container_id` older than a threshold (default 60s).

- [ ] **Step 2: Write the failing test**

In `src/daemon/reconcile.test.ts`, add:

```ts
it("marks aged pending rows (no containerId, older than threshold) as errored", async () => {
  // Insert a turns row with status='pending', container_id=null, created_at older than 60s.
  // Run reconcile; assert status='error' with error='daemon_restart_during_pending'.
});

it("leaves fresh pending rows alone", async () => {
  // Insert a pending row created just now; assert reconcile leaves it as pending.
});
```

- [ ] **Step 3: Verify it fails**

Run: `npx vitest run src/daemon/reconcile.test.ts`
Expected: FAIL — current reconcile only sweeps `running`.

- [ ] **Step 4: Extend reconcile.ts**

Add a sweep step BEFORE the existing running-sweep:

```ts
const PENDING_AGE_MS = 60_000;

// inside reconcile():
const cutoff = new Date(Date.parse(clock.nowIso()) - PENDING_AGE_MS).toISOString();
const agedPending = turnRepo.findAgedPending(cutoff);  // requires new repo method
for (const turn of agedPending) {
  turnRepo.markError(turn.id, "daemon_restart_during_pending", clock.nowIso());
  await bus.publish({
    id: genId(), type: "turn.errored", ts: clock.nowIso(),
    agentId: turn.agentId, turnId: turn.id, traceId: turn.traceId,
    error: "daemon_restart_during_pending",
  });
  logger.warn("reconciled aged pending turn", { turnId: turn.id });
}
```

Add `findAgedPending` to `TurnRepo`:

```ts
// src/db/turn-repo.ts
findAgedPending(cutoffIso: string): Turn[] {
  return this.db.prepare(
    `SELECT * FROM turns WHERE status='pending' AND container_id IS NULL AND created_at < ?`
  ).all(cutoffIso) as Turn[];
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/daemon/reconcile.test.ts src/db/turn-repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/reconcile.ts src/daemon/reconcile.test.ts src/db/turn-repo.ts src/db/turn-repo.test.ts
git commit -m "fix(reconcile): sweep aged pending turns (M1 debt #1, part 2)

Pending turns with no container_id older than 60s are marked
errored with 'daemon_restart_during_pending'. Closes the blind
spot where a daemon crash mid-spawn left an unrecoverable pending
row.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.2, §9 item 1
"
```

---

### Task 20: AGENTS.md mount becomes writable

(Already covered in Task 18 — but verify here in isolation that nothing else assumed read-only.)

- [ ] **Step 1: Search for residual readOnly: true on AGENTS.md**

Run: `grep -rn "AGENTS.md" src/ --include="*.ts" | grep -i "readOnly"`
Expected: only Task 18's change at `readOnly: false`.

- [ ] **Step 2: Add a smoke-style test if not already covered**

In `src/container/docker-command.test.ts`, ensure a test asserts AGENTS.md mount has `readOnly: false`. If absent, add one:

```ts
it("mounts AGENTS.md as writable", () => {
  const args = buildDockerRunArgs({
    /* fixture inputs */
    mounts: [
      { hostPath: "/some/AGENTS.md", containerPath: "/AGENTS.md", readOnly: false },
      { hostPath: "/some/store", containerPath: "/store", readOnly: false },
    ],
    env: {}, imageTag: "x:y",
  });
  // The volume mount for AGENTS.md should NOT contain ":ro"
  expect(args.find(a => a.includes("/AGENTS.md"))).not.toMatch(/:ro$/);
});
```

- [ ] **Step 3: Run test**

Run: `npx vitest run src/container/docker-command.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit (if anything changed)**

```bash
git add src/container/docker-command.test.ts
git commit -m "test(container): assert AGENTS.md mount is writable

Verifies the M2 container-contract change so a future regression
to read-only is caught immediately.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §2 'One contract change'
"
```

(If no changes needed, skip the commit.)

---

## Phase 5 — Container-side Anthropic LLM client

---

### Task 21: Add `@anthropic-ai/sdk` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk@^0.65.0`
(Pin the version that's current at implementation time; check on `npmjs.com/package/@anthropic-ai/sdk`.)

- [ ] **Step 2: Verify install**

Run: `npm ls @anthropic-ai/sdk`
Expected: shows the package and version.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @anthropic-ai/sdk for AnthropicLlmClient

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.3
"
```

---

### Task 22: AnthropicLlmClient (vanilla, mode-agnostic)

**Files:**
- Create: `src/agent-runtime/anthropic-llm-client.ts`
- Create: `src/agent-runtime/anthropic-llm-client.test.ts`

- [ ] **Step 1: Write the failing test**

Look at the existing `src/agent-runtime/openai-llm-client.test.ts` (or equivalent) for the in-memory http-server fixture pattern, and write a parallel test:

```ts
// src/agent-runtime/anthropic-llm-client.test.ts
import { describe, it, expect } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";

function startFake(handler: (req: { headers: Record<string, string|string[]|undefined>; body: string }) => { status: number; body: string }) {
  return new Promise<{ url: string; close: () => Promise<void>; recorded: { headers: Record<string, string|string[]|undefined>; body: string }[] }>((resolve) => {
    const recorded: { headers: Record<string, string|string[]|undefined>; body: string }[] = [];
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const r = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        recorded.push(r);
        const out = handler(r);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    }).listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => s.close(() => r())), recorded });
    });
  });
}

describe("AnthropicLlmClient", () => {
  it("sends a chat request and returns the parsed reply", async () => {
    const fake = await startFake(() => ({
      status: 200,
      body: JSON.stringify({ content: [{ type: "text", text: "hello back" }], usage: { input_tokens: 1, output_tokens: 2 } }),
    }));
    const client = new AnthropicLlmClient({ baseURL: fake.url, apiKey: "routing-token", model: "claude-test", maxTokens: 256 });
    const reply = await client.chat({ system: "be brief", messages: [{ role: "user", content: "hi" }] });
    expect(reply).toBe("hello back");
    expect(fake.recorded[0].headers["x-api-key"]).toBe("routing-token");
    expect(fake.recorded[0].headers["anthropic-version"]).toBeTruthy();
    await fake.close();
  });

  it("surfaces upstream errors as exceptions", async () => {
    const fake = await startFake(() => ({ status: 401, body: '{"error":{"type":"authentication_error","message":"bad"}}' }));
    const client = new AnthropicLlmClient({ baseURL: fake.url, apiKey: "tok", model: "claude-test", maxTokens: 256 });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
    await fake.close();
  });
});
```

- [ ] **Step 2: Verify test fails**

Run: `npx vitest run src/agent-runtime/anthropic-llm-client.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the client**

```ts
// src/agent-runtime/anthropic-llm-client.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmChatInput } from "./runtime.js";   // confirm export name in M1's runtime.ts

interface Opts {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: Opts) {
    this.client = new Anthropic({ baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async chat(input: LlmChatInput): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: input.system,
      messages: input.messages.map(m => ({ role: m.role, content: m.content })),
    });
    // Extract text from the first text block.
    const block = resp.content.find((b: any) => b.type === "text") as { type: "text"; text: string } | undefined;
    return block?.text ?? "";
  }
}
```

(If M1's `LlmClient`/`LlmChatInput` interface looks different, adapt the import + signatures to match. Read `src/agent-runtime/runtime.ts` for the existing shape before writing.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/agent-runtime/anthropic-llm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-runtime/anthropic-llm-client.ts src/agent-runtime/anthropic-llm-client.test.ts
git commit -m "feat(agent-runtime): AnthropicLlmClient (mode-agnostic)

Vanilla @anthropic-ai/sdk; apiKey ctor option carries the routing
token. Container has no OAuth-aware code — the proxy substitutes
the real credential before forwarding upstream.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.3, §6
"
```

---

### Task 23: agent-runtime main.ts provider factory

**Files:**
- Modify: `src/agent-runtime/main.ts`

- [ ] **Step 1: Add the factory**

Read current `src/agent-runtime/main.ts`. Adapt the `LlmClient` instantiation to switch on `TEAMROOM_PROVIDER`:

```ts
import { AnthropicLlmClient } from "./anthropic-llm-client.js";
import { OpenAILlmClient } from "./openai-llm-client.js";  // confirm name from M1

const provider = process.env.TEAMROOM_PROVIDER;
if (provider !== "anthropic" && provider !== "lm-studio") {
  process.stderr.write(`unknown TEAMROOM_PROVIDER: ${provider}\n`);
  process.exit(1);
}

const llm = provider === "anthropic"
  ? new AnthropicLlmClient({
      baseURL: process.env.TEAMROOM_MODEL_BASE_URL!,
      apiKey: process.env.TEAMROOM_MODEL_API_TOKEN!,
      model: process.env.TEAMROOM_MODEL!,
    })
  : new OpenAILlmClient({
      baseURL: process.env.TEAMROOM_MODEL_BASE_URL!,
      apiKey: process.env.TEAMROOM_MODEL_API_TOKEN!,
      model: process.env.TEAMROOM_MODEL!,
    });
```

- [ ] **Step 2: Build the dist**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent-runtime/main.ts
git commit -m "feat(agent-runtime): provider factory in main.ts

Selects AnthropicLlmClient or OpenAILlmClient based on
TEAMROOM_PROVIDER env var injected by the daemon.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.3
"
```

---

## Phase 6 — claude-assistant agent

---

### Task 24: Create `agents/claude-assistant/` folder

**Files:**
- Create: `agents/claude-assistant/agent.yaml`
- Create: `agents/claude-assistant/AGENTS.md`
- Create: `agents/claude-assistant/Dockerfile`
- Create: `agents/claude-assistant/store/.gitkeep`

- [ ] **Step 1: agent.yaml**

```yaml
name: claude-assistant
provider: anthropic
model: claude-sonnet-4-5
image_tag: teamroom-agent-claude-assistant:latest
```

(Use whatever current Anthropic model id you intend; verify against `docs/runbooks/anthropic-auth.md` once written. `claude-sonnet-4-5` is a placeholder — pick a current model alias.)

- [ ] **Step 2: AGENTS.md**

```markdown
# AGENTS.md — claude-assistant

You are a helpful AI assistant running inside Team Room. You're powered by an Anthropic model and respond to messages from the user via the Team Room CLI.

Be concise. Answer questions directly. If you don't know something, say so.

When asked to do programming tasks, write working code, but keep responses short — show only the changed portion unless context is necessary.
```

- [ ] **Step 3: Dockerfile**

Read `agents/studio-assistant/Dockerfile` for the M1 pattern, then write a parallel one:

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Bake the agent-runtime
COPY dist/agent-runtime ./agent-runtime

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
```

(If the M1 Dockerfile uses `node:20-alpine`, match it for now and bump alongside `package.json`'s `engines.node` change in Task 5.)

- [ ] **Step 4: store/.gitkeep**

```bash
mkdir -p agents/claude-assistant/store
touch agents/claude-assistant/store/.gitkeep
```

- [ ] **Step 5: Verify .gitignore lets store/ stay**

Confirm `.gitignore` has the M1 pattern `agents/*/store/*` + `!agents/*/store/.gitkeep`. If yes, the new folder is handled correctly.

- [ ] **Step 6: Build the image**

```bash
npm run build
docker build -t teamroom-agent-claude-assistant:latest -f agents/claude-assistant/Dockerfile .
```

Expected: clean image build.

- [ ] **Step 7: Commit**

```bash
git add agents/claude-assistant/
git commit -m "feat(agents): hire claude-assistant (anthropic)

New agent folder + image. provider: anthropic; model declared in
agent.yaml. AGENTS.md mounted writable per the M2 container contract.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.4
"
```

---

## Phase 7 — Integration tests + smoke test

---

### Task 25: Update existing end-to-end integration test

**Files:**
- Modify: `tests/integration/end-to-end.test.ts`

- [ ] **Step 1: Read the current test**

Understand its composition root. It probably constructs an in-memory daemon directly. Update it to:
- Pass a `StubModelProxy` (real in-memory) into `processTurn` (or include a real `LocalModelProxy` if the test already exercises real http).
- Pass new daemon options (`lmStudio`, `anthropic`) instead of `modelBaseUrl`/`modelApiToken`.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/end-to-end.test.ts`
Expected: PASS — the existing M1 turn flow still works with the proxy in the composition.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "test(integration): update end-to-end test for ModelProxy composition

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §7.2
"
```

---

### Task 26: New integration test — proxy end-to-end (three scenarios)

**Files:**
- Create: `tests/integration/proxy-end-to-end.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/proxy-end-to-end.test.ts
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrator.js";
import { LocalModelProxy } from "../../src/model-proxy/local-model-proxy.js";
import { TokenRegistry } from "../../src/model-proxy/token-registry.js";
import { AnthropicAdapter } from "../../src/model-proxy/adapters/anthropic-adapter.js";
import { LmStudioAdapter } from "../../src/model-proxy/adapters/lm-studio-adapter.js";
import { AnthropicOAuthCache } from "../../src/model-proxy/adapters/anthropic-oauth-cache.js";
import { CapturingLogger } from "../../src/logger/logger.js";

// Helper to start a fake upstream that records requests
async function startFake(routes: { [path: string]: (req: { headers: Record<string, string|string[]|undefined>; body: string; calls: number }) => { status: number; body: string } }) {
  let calls = 0;
  const recorded: { path: string; headers: Record<string, string|string[]|undefined>; body: string }[] = [];
  return new Promise<{ url: string; close: () => Promise<void>; recorded: typeof recorded }>(resolve => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        calls += 1;
        const body = Buffer.concat(chunks).toString("utf8");
        recorded.push({ path: req.url ?? "", headers: req.headers, body });
        const handler = routes[req.url ?? ""] ?? (() => ({ status: 404, body: "{}" }));
        const out = handler({ headers: req.headers, body, calls });
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    }).listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => s.close(() => r())), recorded });
    });
  });
}

describe("proxy end-to-end", () => {
  it("API-key mode: routing token is substituted with real key before reaching upstream", async () => {
    const upstream = await startFake({
      "/v1/messages": () => ({ status: 200, body: JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }) }),
    });
    const logger = new CapturingLogger();
    const adapter = new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "sk-real" }, upstreamUrl: upstream.url });
    const lmStudio = new LmStudioAdapter({ upstreamUrl: "http://unused", realKey: "_" });
    const proxy = new LocalModelProxy({ registry: new TokenRegistry(), adapters: { anthropic: adapter, "lm-studio": lmStudio }, logger });
    const { port } = await proxy.start();
    const tok = (proxy as any).opts.registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "x" });
    // Simulate a container call:
    const fakeContainer = await import("node:http");
    await new Promise<void>((resolveP, rejectP) => {
      const r = fakeContainer.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-api-key": tok, "content-length": "2" } }, res => { res.resume(); res.on("end", resolveP); });
      r.on("error", rejectP);
      r.end("{}");
    });
    expect(upstream.recorded[0].headers["x-api-key"]).toBe("sk-real");
    await proxy.stop(); await upstream.close();
  });

  it("OAuth mode: cached temp key is reused across two calls; only one exchange happens", async () => {
    let messagesCalls = 0;
    let exchangeCalls = 0;
    const upstream = await startFake({
      "/api/oauth/claude_cli/create_api_key": () => { exchangeCalls += 1; return { status: 200, body: JSON.stringify({ api_key: "tk-issued", expires_at: Date.now() + 60_000 }) }; },
      "/v1/messages": () => { messagesCalls += 1; return { status: 200, body: JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }) }; },
    });
    const cache = new AnthropicOAuthCache({ safetyMarginMs: 0 });
    const exchange = async () => {
      // Force the exchange to actually hit the fake upstream by issuing the http call:
      // (in tests we call directly to drive the cache miss; production path uses the daemon.ts exchange impl)
      return await new Promise<{ tempKey: string; expiresAt: number }>((res) => {
        const u = upstream.url + "/api/oauth/claude_cli/create_api_key";
        const url = new URL(u);
        const r = (require("node:http") as typeof import("node:http")).request({ host: url.hostname, port: Number(url.port), path: url.pathname, method: "POST", headers: { "content-length": "0" } }, (resp) => {
          const chunks: Buffer[] = []; resp.on("data", c => chunks.push(c)); resp.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { api_key: string; expires_at: number };
            res({ tempKey: parsed.api_key, expiresAt: parsed.expires_at });
          });
        });
        r.end();
      });
    };
    const adapter = new AnthropicAdapter({ auth: { mode: "oauth", oauthToken: "oauth-1", cache, exchange }, upstreamUrl: upstream.url });
    const lmStudio = new LmStudioAdapter({ upstreamUrl: "http://unused", realKey: "_" });
    const proxy = new LocalModelProxy({ registry: new TokenRegistry(), adapters: { anthropic: adapter, "lm-studio": lmStudio }, logger: new CapturingLogger() });
    const { port } = await proxy.start();
    const tok = (proxy as any).opts.registry.mint({ agentId: "a", turnId: "t", traceId: "tr", provider: "anthropic", model: "x" });
    // Fire two consecutive container calls
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((res, rej) => {
        const r = (require("node:http") as typeof import("node:http")).request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-api-key": tok, "content-length": "2" } }, resp => { resp.resume(); resp.on("end", res); });
        r.on("error", rej); r.end("{}");
      });
    }
    expect(messagesCalls).toBe(2);
    expect(exchangeCalls).toBe(1);
    await proxy.stop(); await upstream.close();
  });

  it("Provider isolation: studio-assistant and claude-assistant requests reach distinct upstreams", async () => {
    const anthropicUpstream = await startFake({ "/v1/messages": () => ({ status: 200, body: '{"content":[{"type":"text","text":"a"}],"usage":{"input_tokens":1,"output_tokens":1}}' }) });
    const lmStudioUpstream  = await startFake({ "/v1/chat/completions": () => ({ status: 200, body: '{"choices":[{"message":{"content":"l"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}' }) });
    const adapters = {
      anthropic: new AnthropicAdapter({ auth: { mode: "api-key", apiKey: "sk-a" }, upstreamUrl: anthropicUpstream.url }),
      "lm-studio": new LmStudioAdapter({ upstreamUrl: lmStudioUpstream.url, realKey: "lm-real" }),
    };
    const reg = new TokenRegistry();
    const proxy = new LocalModelProxy({ registry: reg, adapters, logger: new CapturingLogger() });
    const { port } = await proxy.start();
    const aTok = reg.mint({ agentId: "claude-assistant", turnId: "t1", traceId: "tr1", provider: "anthropic", model: "claude" });
    const lTok = reg.mint({ agentId: "studio-assistant", turnId: "t2", traceId: "tr2", provider: "lm-studio", model: "qwen" });
    // hit each
    const http = await import("node:http");
    await new Promise<void>(r => http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "x-api-key": aTok, "content-length": "2" } }, res => { res.resume(); res.on("end", r); }).end("{}"));
    await new Promise<void>(r => http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "x-api-key": lTok, "content-length": "2" } }, res => { res.resume(); res.on("end", r); }).end("{}"));
    expect(anthropicUpstream.recorded[0].headers["x-api-key"]).toBe("sk-a");
    expect(lmStudioUpstream.recorded[0].headers.authorization).toBe("Bearer lm-real");
    await proxy.stop(); await anthropicUpstream.close(); await lmStudioUpstream.close();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration/proxy-end-to-end.test.ts`
Expected: PASS (3 scenarios). The test uses `(proxy as any).opts.registry.mint` as a hatch — adjust if you'd prefer a clean accessor on `LocalModelProxy`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/proxy-end-to-end.test.ts
git commit -m "test(integration): proxy end-to-end (API-key, OAuth, provider isolation)

Three scenarios using real LocalModelProxy + real fake-upstream
http servers. Verifies routing-token substitution, OAuth cache
reuse, and per-provider upstream isolation.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §7.2
"
```

---

### Task 27: Smoke test extension

**Files:**
- Modify: `scripts/smoke-test.sh`
- Modify: `docs/runbooks/smoke-test.md`

- [ ] **Step 1: Read current smoke test**

Understand the M1 sequence (build, daemon up, send to studio-assistant, tail, expect "hello back").

- [ ] **Step 2: Extend to two agents**

Append a second agent run after the first:

```bash
# studio-assistant (existing)
teamroom send --agent studio-assistant "hello"
# wait for reply via tail or by polling 'teamroom status'

# claude-assistant (new)
teamroom send --agent claude-assistant "hello"
# wait for reply
```

Add a precondition check at the top:

```bash
if ! grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" .env 2>/dev/null && [ ! -f "$HOME/.claude/.credentials.json" ]; then
  echo "Anthropic credentials not found. See docs/runbooks/anthropic-auth.md."
  exit 1
fi
```

Pass criterion: both agents produced replies; the daemon log contains both `model.call.completed` spans (one per upstream).

- [ ] **Step 3: Update the runbook**

In `docs/runbooks/smoke-test.md`:
- Update agent name `assistant` → `studio-assistant`.
- Add the claude-assistant section.
- Note the new precondition (Anthropic creds).
- Add an "interpret the log" step pointing at `data/logs/teamroom-YYYY-MM-DD.jsonl` and the spans to grep for.

- [ ] **Step 4: Run the smoke test locally**

```bash
./scripts/smoke-test.sh
```

Expected: both agents respond. Capture and fix any drift.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-test.sh docs/runbooks/smoke-test.md
git commit -m "feat(smoke-test): exercise both studio-assistant and claude-assistant

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §7.3
"
```

---

## Phase 8 — Docs

---

### Task 28: New runbook — `docs/runbooks/anthropic-auth.md`

**Files:**
- Create: `docs/runbooks/anthropic-auth.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Anthropic auth — credential setup for Team Room

The `claude-assistant` agent talks to the real Anthropic API through the model proxy. Two credential modes are supported; the proxy picks one at startup.

## OAuth (preferred — uses Claude Code subscription)

If you've logged into Claude Code on this machine, the OAuth token is at `~/.claude/.credentials.json` and the proxy will pick it up automatically. No `.env` change needed.

To verify: start the daemon (`teamroom serve`) and look for a startup log line like `oauth credential discovered from ~/.claude/.credentials.json`. If you see `provider:anthropic agent has no credential`, the discovery failed.

To override the discovered location, set in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=<the token value>
```

## API key (fallback, non-subscription)

Get an API key from console.anthropic.com. Add to `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

If both an API key and an OAuth credential are present, OAuth wins.

## What the proxy does with these

- **API-key mode:** every request from the container has its `x-api-key` header replaced by the real `ANTHROPIC_API_KEY` before forwarding.
- **OAuth mode:** the proxy performs a server-to-server OAuth exchange the first time an Anthropic agent runs, caches the resulting temp API key (keyed by OAuth token), and substitutes that on subsequent calls. The temp key is refreshed when it nears expiry or when Anthropic returns 401. Containers never see real credentials in either mode.

## Troubleshooting

- **`turn errored: missing_credential`** — the proxy didn't find an Anthropic credential; check `.env` and `~/.claude/.credentials.json`.
- **Repeated 401 from Anthropic in OAuth mode** — your Claude Code OAuth token may have expired. Re-login to Claude Code (`claude /login` or equivalent) and restart the daemon.
- **`oauth_exchange_403` or signed-request errors** — Anthropic may have gated programmatic exchange. See `docs/tabled.md` for the fallback (Claude Agent SDK).
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/anthropic-auth.md
git commit -m "docs(runbook): anthropic-auth — credential discovery + troubleshooting

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.5, §6
"
```

---

### Task 29: New runbook — `docs/runbooks/agent-onboarding.md` (skeleton)

**Files:**
- Create: `docs/runbooks/agent-onboarding.md`

- [ ] **Step 1: Write the skeleton**

```markdown
# Agent onboarding (skeleton)

> **This is a starting point.** Real specialized-agent onboarding will involve flowcharts, skill assignments, tool inventories, and metadata that M2 does not yet model. The expectation is that an agent role is observed-in-use before it is formally onboarded; the skeleton supports the manual path that exists today.

## What you need before starting

- A short name for the agent (e.g., `claude-assistant`). Convention: name agents after their backing model/provider unless the role is more important than the model.
- A model + provider decision: either `provider: anthropic` with a Claude model, or `provider: lm-studio` with a local model (LM Studio must be running with the chosen model loaded).
- Credentials wired in `.env` (see `docs/runbooks/anthropic-auth.md` for the Anthropic case).

## Steps

1. **Create the agent folder.** `mkdir -p agents/<name>/store && touch agents/<name>/store/.gitkeep`.
2. **Write `agents/<name>/agent.yaml`:**

   ```yaml
   name: <name>
   provider: anthropic | lm-studio
   model: <model-id>
   image_tag: teamroom-agent-<name>:latest
   ```

3. **Write `agents/<name>/AGENTS.md`** — the model-facing instructions for this agent. Be specific about tone, scope, and any per-agent constraints. This file is mounted writable into the container at `/AGENTS.md`.
4. **Write `agents/<name>/Dockerfile`** — copy from `agents/studio-assistant/Dockerfile` or `agents/claude-assistant/Dockerfile`; change the image tag if needed.
5. **Build the agent's image:**

   ```bash
   npm run build
   docker build -t teamroom-agent-<name>:latest -f agents/<name>/Dockerfile .
   ```

6. **Restart the daemon** so it discovers and registers the new agent on startup.
7. **Send a first message:**

   ```bash
   teamroom send --agent <name> "hello"
   teamroom tail
   ```

8. **Verify in the log** at `data/logs/teamroom-YYYY-MM-DD.jsonl`:

   ```bash
   grep '"agentName":"<name>"' data/logs/teamroom-*.jsonl | head
   ```

   Expect to see `turn.started`, `model.call.completed`, `turn.completed` events for your message.

## What this skeleton does NOT cover yet

- Skill assignments and tool inventories (M3+).
- Per-agent memory (M4).
- Per-agent evaluations (M6).
- Self-improvement loops (M7).

When those land, this runbook will get richer; for now it's the manual cookbook.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/agent-onboarding.md
git commit -m "docs(runbook): agent-onboarding skeleton (M1 debt #5)

Deliberately short. Real specialized-agent onboarding will be
fleshed out as roles emerge; this captures the manual path.

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.6, §9 item 5
"
```

---

### Task 30: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Anthropic vars with comments**

```
# Required for studio-assistant (LM Studio backend).
LM_STUDIO_API_TOKEN=your-lm-studio-token
# Optional: override the LM Studio base URL (default: http://host.docker.internal:1234).
# LM_STUDIO_BASE_URL=http://host.docker.internal:1234

# For claude-assistant (Anthropic backend). Pick ONE:
#   - OAuth (preferred): leave the value empty and Team Room will read
#     ~/.claude/.credentials.json. Or set CLAUDE_CODE_OAUTH_TOKEN explicitly.
#   - API key (fallback for non-subscription): set ANTHROPIC_API_KEY.
# If both are set, OAuth wins.
# CLAUDE_CODE_OAUTH_TOKEN=
# ANTHROPIC_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document Anthropic credentials (OAuth preferred)

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §3.5
"
```

---

### Task 31: Update root `README.md` and remaining runbooks

**Files:**
- Modify: `README.md`
- Modify: `docs/runbooks/manual-cli-testing.md`

- [ ] **Step 1: Update root README**

Update the "Current state" paragraph to note both backends are live:

> Milestone 2 — "Model abstraction layer." Two agents now run concurrently against two backends: `studio-assistant` (LM Studio, local) and `claude-assistant` (Anthropic, real API via subscription OAuth or API key). Containers never see real credentials — the in-daemon `ModelProxy` substitutes them per request. See [`docs/as-built/2026-04-18-m2-model-abstraction.md`] when M2 closes.

Update agent name references in commands (`--agent assistant` → `--agent studio-assistant`).

Add a note pointing readers to `docs/runbooks/anthropic-auth.md` for credential setup.

- [ ] **Step 2: Update `docs/runbooks/manual-cli-testing.md`**

Replace `assistant` → `studio-assistant` in the manual-cli-testing examples.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/runbooks/manual-cli-testing.md
git commit -m "docs: update README + manual-cli-testing for M2 reality

Refs: docs/specs/2026-04-18-m2-model-abstraction-design.md §1
"
```

---

### Task 32: Module README updates for touched modules

**Files:**
- Modify: `src/daemon/README.md` (note ModelProxy in composition)
- Modify: `src/agent-runtime/README.md` (mention AnthropicLlmClient + provider factory)
- Modify: `src/agent-config/README.md` (provider field)
- Modify: any other module README the M2 changes invalidated

- [ ] **Step 1: Read each touched module's README**

For each module modified in this plan (`daemon`, `agent-runtime`, `agent-config`, `container`, `bus`), open its README and check for stale claims (e.g., "single agent", "hardcoded model", references to old env vars).

- [ ] **Step 2: Update inline**

Update the contract paragraph and any out-of-date `## Files` or `## Related` entries. Add cross-references to `src/model-proxy/README.md` where appropriate.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/README.md src/agent-runtime/README.md src/agent-config/README.md src/container/README.md
git commit -m "docs(modules): update READMEs touched by M2 to reflect new reality

Refs: docs/ways-of-working.md (doc updates land in the same change)
"
```

---

## Phase 9 — Final verification

---

### Task 33: Full-system smoke + test pass

- [ ] **Step 1: Clean rebuild and full test suite**

```bash
rm -rf dist
npm run build
npm run typecheck
npm test
```

Expected: clean.

- [ ] **Step 2: Run the smoke test against both backends**

```bash
./scripts/smoke-test.sh
```

Expected: both `studio-assistant` and `claude-assistant` reply. Capture exact log spans:

```bash
grep -E '"event":"(turn\.|model\.call\.|oauth\.exchange\.)"' data/logs/teamroom-*.jsonl | tail -30
```

Expect to see `turn.started`, `model.call.completed` (×2 — one per agent), `turn.completed`, and (in OAuth mode) `oauth.exchange.completed` (×1 across the run).

- [ ] **Step 3: Verify credentials are not in container env**

While the daemon is running and a turn is in flight (use a slow-responding test message), inspect the container:

```bash
CID=$(docker ps --filter "ancestor=teamroom-agent-claude-assistant:latest" -q | head -1)
docker inspect "$CID" | grep -E "ANTHROPIC|OAUTH|api_key"
```

Expected: only the routing token (`TEAMROOM_MODEL_API_TOKEN=<uuid>`) — never `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

- [ ] **Step 4: Capture findings in tabled.md if anything surprised you**

Any drifts from the spec, exact OAuth-response field names, observed temp-key TTLs, or quirks worth carrying into the M2 as-built — append to `docs/tabled.md` for retro processing.

- [ ] **Step 5: Final commit (if anything in tabled.md changed)**

```bash
git add docs/tabled.md
git commit -m "chore(m2): capture implementation-time observations for retro/as-built"
```

---

## Done criteria for M2

- [ ] `studio-assistant` and `claude-assistant` both respond to `teamroom send` end-to-end via the proxy.
- [ ] Real Anthropic credentials are not present in container env / `docker inspect` output.
- [ ] Smoke test passes against real Anthropic + real LM Studio.
- [ ] Full test suite passes (M1 tests + new M2 tests).
- [ ] Span-shaped log records reconstruct each turn from JSONL alone.
- [ ] M1 debts 1, 2, 3, 5 absorbed; debt 4 (Node 22 bump) decided one way or the other.
- [ ] `docs/specs/` and `docs/plans/` ready to be purged into the M2 as-built at milestone close.

---

## Self-review checklist (run after writing the plan)

Per the writing-plans skill: scan for spec coverage, placeholders, type consistency.

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| §1 exit criteria | Tasks 17, 23, 24, 26, 27, 33 |
| §2 architecture | Tasks 7–17 (build) + 18 (wire) |
| §3.1 model-proxy module | Tasks 7–16 |
| §3.2 daemon updates | Tasks 2, 17, 18, 19 |
| §3.3 agent-runtime updates | Tasks 21, 22, 23 |
| §3.4 agent population | Tasks 1 (rename), 24 (claude-assistant), 6 (provider field) |
| §3.5 credential discovery | Task 17 |
| §3.6 onboarding runbook | Task 29 |
| §3.7 tooling (Node bump) | Task 5 |
| §4 data flow | Verified by Tasks 18 + 26 |
| §5 error handling | Tasks 13, 15, 18 |
| §6 auth modes | Tasks 11, 12, 13, 17 |
| §7 testing | Tasks 8–15 (unit), 25 + 26 (integration), 27 (smoke) |
| §8 observability | Tasks 9, 15 (span emission) |
| §9 M1 debts | Tasks 1 (rename), 2, 3, 4, 5, 18, 19, 29 |
| §10 non-goals | N/A — explicitly out of scope |
| §11 open risks | Surfaced for pre-execution review; tested where possible (cache concurrency, timeout) |
| §12 files touched | Mirrored in the file-structure list above |

**Placeholder scan:** searched for "TBD", "TODO", "implement later" — none in this plan.

**Type consistency:** `Provider`, `AuthMode`, `MintTokenInput`, `TokenEntry`, `SpanFields` are defined in Task 7 and referenced consistently in Tasks 8–17. `ProviderAdapter` defined in Task 10 and refactored in Task 13 (sync `injectAuth` → async `resolveAuth` + optional `onUpstreamUnauthorized`); LMStudioAdapter in Task 10 must be updated when Task 13 lands the refactor — Task 13 Step 1 calls this out explicitly.

---

*End of M2 plan. Pre-execution review (Claude + user) is the next step before Task 1.*
