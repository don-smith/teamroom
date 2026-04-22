# M5 — LangGraph Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project-local addenda apply** — see `docs/ways-of-working.md` §"Working with subagents for Team Room delivery". In particular: inline follow-up commits per review (don't accumulate a review backlog), combined spec+code review once a pattern holds across several groups.

**Goal:** Ship one LangGraph-backed agent (`studio-assistant`) running Gemma 4 via LM Studio, participating in the mail substrate via MCP tools — and establish a reusable runtime branch for any OpenAI-compatible backend (Ollama wired alongside).

**Architecture:** Extract `AgentWorker` interface from the current shared `processWake` / `LlmClient` shape. Two worker implementations: `AnthropicAgentWorker` (wraps existing SDK) and `LangGraphAgentWorker` (new, prebuilt `createReactAgent` + `@langchain/mcp-adapters` + bounded in-process `messages` array). Consolidate the two OpenAI-compat adapters into one `OpenAICompatAdapter` parameterized by auth mode.

**Tech Stack:** Node.js 22, TypeScript strict, vitest, `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`, `@langchain/mcp-adapters`, existing daemon + mail-MCP + model-proxy stack.

**Spec reference:** [`docs/specs/2026-04-22-m5-langgraph-agent.md`](../specs/2026-04-22-m5-langgraph-agent.md)

---

## File map (full list of changes)

**New files:**
- `src/agent-runtime/worker.ts` — `AgentWorker` interface + `buildWorker()` factory + `WakeEnvelope` type.
- `src/agent-runtime/worker.test.ts` — factory tests.
- `src/agent-runtime/anthropic-worker.ts` — `AnthropicAgentWorker`.
- `src/agent-runtime/anthropic-worker.test.ts` — ported from `runtime.test.ts`.
- `src/agent-runtime/langgraph-worker.ts` — `LangGraphAgentWorker`.
- `src/agent-runtime/langgraph-worker.test.ts` — TDD coverage.
- `src/model-proxy/adapters/openai-compat-adapter.ts` — renamed + generalized from `lm-studio-adapter.ts`.
- `src/model-proxy/adapters/openai-compat-adapter.test.ts` — renamed + extended.

**Modified files:**
- `src/types.ts` — `Provider` union adds `"ollama"`.
- `src/agent-config/agent-config.ts` — validator accepts `"ollama"`.
- `src/agent-config/agent-config.test.ts` — add ollama-accepted test.
- `src/agent-runtime/main.ts` — uses `buildWorker()`; removes inline OpenAI-compat client.
- `src/agent-runtime/anthropic-llm-client.ts` — absorbs `LlmClient`/`LlmCreateArgs`/`LlmCreateResult`/`ConversationMessage` type exports.
- `src/agent-runtime/anthropic-llm-client.test.ts` — import path adjustment.
- `src/agent-runtime/README.md` — describe AgentWorker shape.
- `src/modules/model-proxy/model-proxy.ts` — `composeModelProxy` builds two `OpenAICompatAdapter` instances.
- `package.json` — four new LangChain deps.
- `.env.example` — `OLLAMA_BASE_URL` entry.
- `agents/studio-assistant/agent.yaml` — model swap + comment removal.
- `agents/studio-assistant/AGENTS.md` — full rewrite.

**Deleted files:**
- `src/agent-runtime/runtime.ts`.
- `src/agent-runtime/runtime.test.ts` (content ported to `anthropic-worker.test.ts`).
- `src/agent-runtime/session-store.ts`.
- `src/agent-runtime/session-store.test.ts`.
- `src/model-proxy/adapters/lm-studio-adapter.ts` (renamed).
- `src/model-proxy/adapters/lm-studio-adapter.test.ts` (renamed).
- `agents/assistant/` (orphan folder with only `store/`).

---

## Task 1: Add `"ollama"` to `Provider` + extend agent-config validator

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent-config/agent-config.ts`
- Modify: `src/agent-config/agent-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agent-config/agent-config.test.ts` (locate the existing `provider` tests and add alongside):

```typescript
it("accepts provider: ollama", () => {
  writeFileSync(
    join(dir, "agent.yaml"),
    `name: x\nmodel: m\nimage_tag: t\nprovider: ollama\nsubscriptions: []\n`,
  );
  const cfg = loadAgentConfig(dir);
  expect(cfg.provider).toBe("ollama");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/agent-config/agent-config.test.ts -t "accepts provider: ollama"
```

Expected: FAIL — validator rejects `ollama` with message `provider must be 'anthropic' or 'lm-studio'`.

- [ ] **Step 3: Extend the Provider union**

In `src/types.ts`:

```typescript
export type Provider = "anthropic" | "lm-studio" | "ollama";
```

- [ ] **Step 4: Update the validator**

In `src/agent-config/agent-config.ts`, replace the two guards:

```typescript
if (provider === undefined || provider === null) {
  throw new Error(`agent.yaml missing 'provider' (expected 'anthropic', 'lm-studio', or 'ollama')`);
}
if (provider !== "anthropic" && provider !== "lm-studio" && provider !== "ollama") {
  throw new Error(
    `agent.yaml 'provider' must be 'anthropic', 'lm-studio', or 'ollama' (got '${String(provider)}')`,
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/agent-config/agent-config.test.ts
```

Expected: all tests pass (new test green; existing anthropic/lm-studio tests still green; invalid-provider test may need its expected error message updated — if so, update the test).

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agent-config/agent-config.ts src/agent-config/agent-config.test.ts
git commit -m "feat(types): add ollama provider to Provider union + validator"
```

---

## Task 2: Add `OLLAMA_BASE_URL` to `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the new stanza below the LM Studio entries**

Insert in `.env.example` after the LM Studio block (keep the LM Studio block unchanged):

```bash

# Optional: override the Ollama base URL (default: http://localhost:11434).
# Similar to LM_STUDIO_BASE_URL — the host-side proxy reaches Ollama at
# localhost; the container reaches the proxy via host.docker.internal.
# OLLAMA_BASE_URL=http://localhost:11434
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): add OLLAMA_BASE_URL tunable"
```

---

## Task 3: Rename LM Studio adapter → `OpenAICompatAdapter` with two auth modes

**Files:**
- Create (by rename): `src/model-proxy/adapters/openai-compat-adapter.ts` (from `lm-studio-adapter.ts`)
- Create (by rename): `src/model-proxy/adapters/openai-compat-adapter.test.ts` (from `lm-studio-adapter.test.ts`)
- Modify: `src/modules/model-proxy/model-proxy.ts` (import + construction; full wiring lands in Task 4)

- [ ] **Step 1: `git mv` the two files**

```bash
git mv src/model-proxy/adapters/lm-studio-adapter.ts src/model-proxy/adapters/openai-compat-adapter.ts
git mv src/model-proxy/adapters/lm-studio-adapter.test.ts src/model-proxy/adapters/openai-compat-adapter.test.ts
```

- [ ] **Step 2: Write failing tests for both auth modes + ollama id**

Replace the contents of `src/model-proxy/adapters/openai-compat-adapter.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { OpenAICompatAdapter } from "./openai-compat-adapter.js";

describe("OpenAICompatAdapter (bearer auth)", () => {
  const base = {
    id: "lm-studio" as const,
    upstreamUrl: "http://localhost:1234",
    auth: { mode: "bearer" as const, key: "real-tok" },
  };

  it("upstreamUrl returns the configured base URL", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.upstreamUrl()).toBe("http://localhost:1234");
  });

  it("authMode is 'api-key' for bearer auth", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.authMode).toBe("api-key");
  });

  it("resolveAuth replaces Authorization with the real key and strips x-api-key", async () => {
    const a = new OpenAICompatAdapter(base);
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    await a.resolveAuth(headers);
    expect(headers.authorization).toBe("Bearer real-tok");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});

describe("OpenAICompatAdapter (none auth)", () => {
  const base = {
    id: "ollama" as const,
    upstreamUrl: "http://localhost:11434",
    auth: { mode: "none" as const },
  };

  it("upstreamUrl returns the configured base URL", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.upstreamUrl()).toBe("http://localhost:11434");
  });

  it("authMode is 'api-key' (no OAuth flows involved)", () => {
    const a = new OpenAICompatAdapter(base);
    expect(a.authMode).toBe("api-key");
  });

  it("resolveAuth strips both Authorization and x-api-key", async () => {
    const a = new OpenAICompatAdapter(base);
    const headers: Record<string, string | string[] | undefined> = {
      authorization: "Bearer routing-token",
      "x-api-key": "routing-token",
    };
    await a.resolveAuth(headers);
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });
});

describe("OpenAICompatAdapter.extractUsage", () => {
  const a = new OpenAICompatAdapter({
    id: "lm-studio",
    upstreamUrl: "http://x",
    auth: { mode: "bearer", key: "k" },
  });

  it("reads OpenAI-shape usage fields", () => {
    expect(a.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } }))
      .toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("returns empty on non-object or missing usage", () => {
    expect(a.extractUsage(null)).toEqual({});
    expect(a.extractUsage({})).toEqual({});
    expect(a.extractUsage({ usage: null })).toEqual({});
  });
});
```

- [ ] **Step 3: Run the tests — they should fail against the old class shape**

```bash
npx vitest run src/model-proxy/adapters/openai-compat-adapter.test.ts
```

Expected: FAIL — `OpenAICompatAdapter` is not exported; `LmStudioAdapter` is still the class name.

- [ ] **Step 4: Rewrite the adapter class**

Replace the contents of `src/model-proxy/adapters/openai-compat-adapter.ts` with:

```typescript
import type { OutgoingHttpHeaders } from "node:http";
import type { Provider, AuthMode } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";

export type OpenAICompatAuth =
  | { mode: "bearer"; key: string }
  | { mode: "none" };

export interface OpenAICompatAdapterOpts {
  /** Proxy-level provider id (`"lm-studio"` or `"ollama"`). */
  id: Provider;
  /** Upstream base URL (e.g. `http://localhost:1234` or `http://localhost:11434`). */
  upstreamUrl: string;
  /** Auth mode — `bearer` for LM Studio-style token, `none` for Ollama-style unauthenticated. */
  auth: OpenAICompatAuth;
}

/**
 * Single adapter shared by any OpenAI-compatible upstream (LM Studio,
 * Ollama, future hosted OpenAI / Codex). Differs from `AnthropicAdapter`
 * in auth shape and usage-field names; within the OpenAI-compat family
 * everything else is identical.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode = "api-key";
  private readonly opts: OpenAICompatAdapterOpts;

  constructor(opts: OpenAICompatAdapterOpts) {
    this.opts = opts;
    this.id = opts.id;
  }

  upstreamUrl(): string {
    return this.opts.upstreamUrl;
  }

  async resolveAuth(headers: OutgoingHttpHeaders): Promise<void> {
    delete headers["x-api-key"];
    if (this.opts.auth.mode === "bearer") {
      headers.authorization = `Bearer ${this.opts.auth.key}`;
    } else {
      delete headers.authorization;
    }
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

- [ ] **Step 5: Update the only production consumer**

In `src/modules/model-proxy/model-proxy.ts`, replace:

```typescript
import { LmStudioAdapter } from "../../model-proxy/adapters/lm-studio-adapter.js";
```

with:

```typescript
import { OpenAICompatAdapter } from "../../model-proxy/adapters/openai-compat-adapter.js";
```

And change the `lm-studio` construction inside `composeModelProxy`:

```typescript
  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    "lm-studio": new OpenAICompatAdapter({
      id: "lm-studio",
      upstreamUrl: deps.lmStudio.upstreamUrl,
      auth: { mode: "bearer", key: deps.lmStudio.realKey },
    }),
  };
```

(Ollama wiring lands in Task 4.)

- [ ] **Step 6: Run the tests**

```bash
npx vitest run src/model-proxy/adapters/openai-compat-adapter.test.ts
npx vitest run src/modules/model-proxy/
```

Expected: all pass.

- [ ] **Step 7: Full suite + typecheck**

```bash
npm test
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(model-proxy): consolidate lm-studio adapter into OpenAICompatAdapter (bearer | none)"
```

---

## Task 4: Wire the `ollama` adapter in `composeModelProxy`

**Files:**
- Modify: `src/modules/model-proxy/model-proxy.ts`
- Modify: `src/modules/model-proxy/model-proxy.test.ts` (or the daemon-composition test that covers proxy composition — locate via `grep -l composeModelProxy src/modules/model-proxy`)
- Modify: `src/daemon/daemon.ts` (pass an `ollama` deps entry through — see Step 3)

- [ ] **Step 1: Write the failing test**

Locate the existing `composeModelProxy` test file (likely `src/modules/model-proxy/model-proxy.test.ts` or a daemon-composition test under `src/daemon/`). Add a test asserting both `lm-studio` and `ollama` adapters are registered after composition:

```typescript
it("registers both lm-studio and ollama OpenAI-compat adapters", async () => {
  const logger = /* existing logger fixture */;
  const mod = await composeModelProxy({
    logger,
    lmStudio: { upstreamUrl: "http://host.docker.internal:1234", realKey: "k" },
    ollama: { upstreamUrl: "http://host.docker.internal:11434" },
    anthropic: null,
  });
  // Mint a token under each provider; if the adapter is missing, mint → proxy call path would 500.
  // Here we just assert the registry was called — inspect via the public surface.
  const t1 = mod.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "lm-studio", model: "m" });
  const t2 = mod.tokenRegistry.mint({ agentId: "a", turnId: "t", traceId: "r", provider: "ollama", model: "m" });
  expect(mod.tokenRegistry.lookup(t1)?.provider).toBe("lm-studio");
  expect(mod.tokenRegistry.lookup(t2)?.provider).toBe("ollama");
  await mod.stop();
});
```

If no `composeModelProxy` test exists today, create `src/modules/model-proxy/model-proxy.test.ts` with imports + a minimal logger fixture (use `createJsonLinesLogger` writing to a temp file or a null logger helper if one exists).

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/modules/model-proxy/model-proxy.test.ts -t "registers both"
```

Expected: FAIL — `ollama` field not accepted in `ModelProxyDeps`.

- [ ] **Step 3: Extend `ModelProxyDeps` and construction**

In `src/modules/model-proxy/model-proxy.ts`:

```typescript
export interface ModelProxyDeps {
  logger: Logger;
  lmStudio: { upstreamUrl: string; realKey: string };
  ollama: { upstreamUrl: string };
  anthropic: AnthropicCreds | null;
}
```

And in `composeModelProxy`, extend the adapter registry:

```typescript
  const adapters: Partial<Record<Provider, ProviderAdapter>> = {
    "lm-studio": new OpenAICompatAdapter({
      id: "lm-studio",
      upstreamUrl: deps.lmStudio.upstreamUrl,
      auth: { mode: "bearer", key: deps.lmStudio.realKey },
    }),
    "ollama": new OpenAICompatAdapter({
      id: "ollama",
      upstreamUrl: deps.ollama.upstreamUrl,
      auth: { mode: "none" },
    }),
  };
```

- [ ] **Step 4: Wire through the daemon composition**

In `src/daemon/daemon.ts`, find the existing `composeModelProxy({ lmStudio: ..., anthropic: ... })` call (it's in section 6 per the M4.5 as-built). Add the `ollama` block alongside `lmStudio`:

```typescript
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const modelProxyModule = await composeModelProxy({
  logger: observability.logger,
  lmStudio: {
    upstreamUrl: process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234",
    realKey: process.env.LM_STUDIO_API_TOKEN ?? "",
  },
  ollama: {
    upstreamUrl: ollamaBaseUrl,
  },
  anthropic: resolvedAnthropicCreds,  // existing variable name — preserve
});
```

(Adjust to match the exact existing variable names in `daemon.ts`.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/modules/model-proxy/
```

Expected: PASS.

- [ ] **Step 6: Full suite + typecheck**

```bash
npm test
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(model-proxy): wire ollama adapter in composeModelProxy"
```

---

## Task 5: Add LangGraph.js + MCP adapter dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (via `npm install`)

- [ ] **Step 1: Install the four LangChain deps as production dependencies**

```bash
npm install @langchain/langgraph @langchain/core @langchain/openai @langchain/mcp-adapters
```

This updates `package.json` and `package-lock.json`.

- [ ] **Step 2: Verify the packages resolve and the tree is healthy**

```bash
npm ls @langchain/langgraph @langchain/core @langchain/openai @langchain/mcp-adapters
```

Expected: all four resolve; no `UNMET PEER DEPENDENCY` or `invalid` warnings.

- [ ] **Step 3: Verify TypeScript still typechecks**

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: clean.

- [ ] **Step 4: Run existing tests to verify no regressions from the install**

```bash
npm test
```

Expected: same green as before.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @langchain/langgraph + core + openai + mcp-adapters (production)"
```

---

## Task 6: Introduce the `AgentWorker` interface

**Files:**
- Create: `src/agent-runtime/worker.ts`
- Create: `src/agent-runtime/worker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent-runtime/worker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildWorker } from "./worker.js";

describe("buildWorker", () => {
  it("throws for an unknown TEAMROOM_PROVIDER", async () => {
    const prev = process.env.TEAMROOM_PROVIDER;
    process.env.TEAMROOM_PROVIDER = "bogus";
    try {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    } finally {
      if (prev === undefined) delete process.env.TEAMROOM_PROVIDER;
      else process.env.TEAMROOM_PROVIDER = prev;
    }
  });

  it("throws if TEAMROOM_PROVIDER is unset", async () => {
    const prev = process.env.TEAMROOM_PROVIDER;
    delete process.env.TEAMROOM_PROVIDER;
    try {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    } finally {
      if (prev !== undefined) process.env.TEAMROOM_PROVIDER = prev;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/agent-runtime/worker.test.ts
```

Expected: FAIL — `worker.ts` doesn't exist.

- [ ] **Step 3: Create `worker.ts` with the interface + stub factory**

Create `src/agent-runtime/worker.ts`:

```typescript
/**
 * Agent runtime worker abstraction. One worker per container.
 * The container's stdin loop drives `handleWake(wake)` once per inbound
 * envelope. Workers are constructed once at container boot (async, to
 * allow MCP handshake / graph compilation); they may hold cross-wake
 * state (e.g. LangGraph messages array) bounded by the container lifetime.
 */

export interface WakeEnvelope {
  type: "wake";
  /** Informational tags — the agent's system prompt tells it what to check. */
  events: string[];
}

export interface AgentWorker {
  handleWake(wake: WakeEnvelope): Promise<void>;
}

/**
 * Factory that selects a worker implementation from `TEAMROOM_PROVIDER`.
 * Anthropic uses the existing claude-agent-sdk path; lm-studio and ollama
 * share a single LangGraph worker pointed at whatever OpenAI-compat URL
 * the daemon's proxy forwards to.
 */
export async function buildWorker(): Promise<AgentWorker> {
  const provider = process.env.TEAMROOM_PROVIDER;
  if (!provider) {
    throw new Error("TEAMROOM_PROVIDER is required");
  }
  switch (provider) {
    case "anthropic": {
      const { AnthropicAgentWorker } = await import("./anthropic-worker.js");
      return AnthropicAgentWorker.create();
    }
    case "lm-studio":
    case "ollama": {
      const { LangGraphAgentWorker } = await import("./langgraph-worker.js");
      return LangGraphAgentWorker.create();
    }
    default:
      throw new Error(`unknown TEAMROOM_PROVIDER: '${provider}'`);
  }
}
```

(The `AnthropicAgentWorker` and `LangGraphAgentWorker` imports will fail TS until Tasks 7 and 9 land them, but the test in Step 2 only covers the validation branches — which don't dynamic-import.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/agent-runtime/worker.test.ts
```

Expected: PASS (both tests hit the validation branches; neither path triggers dynamic import).

- [ ] **Step 5: Typecheck — will FAIL on the dynamic imports until Tasks 7 + 9 land**

```bash
npx tsc --noEmit
```

Expected: **FAIL** on `./anthropic-worker.js` and `./langgraph-worker.js` unresolved imports. This is expected and will be resolved in subsequent tasks. Do NOT commit yet if strict CI requires a clean `tsc` at every commit — otherwise commit and fix forward.

- [ ] **Step 6: Commit (deferred-green strategy)**

This plan commits per-task even when intermediate typechecks fail, because Tasks 6 → 7 → 9 are a three-step refactor that only type-clean at the end. The M4.5 retro (§2 "bisect hazard") flagged this pattern. To avoid it: **bundle Tasks 6, 7, 8, 9 into a single execution group so no intermediate commit exposes broken TypeScript.** See the "Bundling pass" section at the end of this plan — Group E bundles 6–9.

If executing task-by-task regardless, defer this commit until Task 9. If executing per the Group E bundle, complete Tasks 7, 8, 9 next and commit once at the end of the group.

---

## Task 7: Create `AnthropicAgentWorker` by absorbing `processWake`

**Files:**
- Create: `src/agent-runtime/anthropic-worker.ts`
- Create: `src/agent-runtime/anthropic-worker.test.ts`
- Modify: `src/agent-runtime/anthropic-llm-client.ts` (absorb type exports from the soon-retired `runtime.ts`)
- Modify: `src/agent-runtime/anthropic-llm-client.test.ts` (update `import type { LlmClient }` path)

- [ ] **Step 1: Absorb type exports into `anthropic-llm-client.ts`**

In `src/agent-runtime/anthropic-llm-client.ts`, replace the `import type { LlmClient, LlmCreateArgs, LlmCreateResult } from "./runtime.js";` line with these inline exports (near the top of the file, after the existing imports):

```typescript
export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export interface LlmCreateArgs {
  model: string;
  system: string;
  messages: ConversationMessage[];
}

export interface LlmCreateResult {
  text: string;
}

export interface LlmClient {
  createMessage(args: LlmCreateArgs): Promise<LlmCreateResult>;
}
```

(These are verbatim copies from `runtime.ts` and `session-store.ts`; the types retire with those files.)

- [ ] **Step 2: Update the test file's import**

In `src/agent-runtime/anthropic-llm-client.test.ts` line 3, change:

```typescript
import type { LlmClient } from "./runtime.js";
```

to:

```typescript
import type { LlmClient } from "./anthropic-llm-client.js";
```

- [ ] **Step 3: Port test cases from `runtime.test.ts` to `anthropic-worker.test.ts`**

Create `src/agent-runtime/anthropic-worker.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicAgentWorker } from "./anthropic-worker.js";
import type { LlmClient } from "./anthropic-llm-client.js";

describe("AnthropicAgentWorker", () => {
  let dir: string;
  let agentsMd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-anthropic-worker-"));
    agentsMd = join(dir, "AGENTS.md");
    writeFileSync(agentsMd, "You are claude-assistant. Triage your inbox.");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("invokes the LLM once with the system prompt from AGENTS.md and a wake user message", async () => {
    const calls: { system: string; messages: unknown[]; model: string }[] = [];
    const client: LlmClient = {
      async createMessage(args) {
        calls.push({ system: args.system, messages: args.messages, model: args.model });
        return { text: "" };
      },
    };

    const worker = new AnthropicAgentWorker({
      client,
      model: "claude-opus-4-7",
      agentsMdPath: agentsMd,
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("claude-assistant");
    expect(calls[0]!.model).toBe("claude-opus-4-7");
    expect(calls[0]!.messages).toEqual([
      { role: "user", content: expect.stringContaining("wake") },
    ]);
  });

  it('does not emit {type:"reply"} (or any stdout envelope) for LLM text', async () => {
    const client: LlmClient = {
      async createMessage() {
        return { text: "I looked at my inbox, nothing actionable." };
      },
    };
    const originalWrite = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const worker = new AnthropicAgentWorker({
      client,
      model: "m",
      agentsMdPath: agentsMd,
    });
    try {
      await worker.handleWake({ type: "wake", events: ["mail"] });
    } finally {
      process.stdout.write = originalWrite;
    }

    const stdoutSeen = captured.join("");
    expect(stdoutSeen).not.toMatch(/"type":\s*"reply"/);
    expect(stdoutSeen).not.toMatch(/"type":\s*"dm"/);
  });

  it("routes LLM natural-language text to onText when provided", async () => {
    const client: LlmClient = {
      async createMessage() {
        return { text: "ok, replied to sender" };
      },
    };
    const texts: string[] = [];
    const worker = new AnthropicAgentWorker({
      client,
      model: "m",
      agentsMdPath: agentsMd,
      onText: (t) => texts.push(t),
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(texts).toEqual(["ok, replied to sender"]);
  });

  it("uses a default system prompt if AGENTS.md is missing", async () => {
    rmSync(agentsMd);
    let captured = "";
    const client: LlmClient = {
      async createMessage(args) {
        captured = args.system;
        return { text: "" };
      },
    };
    const worker = new AnthropicAgentWorker({ client, model: "m", agentsMdPath: agentsMd });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured).toMatch(/mail/i);
  });

  it("can be invoked repeatedly — each wake is independent", async () => {
    let seen = 0;
    const client: LlmClient = {
      async createMessage() {
        seen += 1;
        return { text: "" };
      },
    };
    const worker = new AnthropicAgentWorker({ client, model: "m", agentsMdPath: agentsMd });
    for (let i = 0; i < 3; i++) {
      await worker.handleWake({ type: "wake", events: ["mail"] });
    }
    expect(seen).toBe(3);
  });
});
```

- [ ] **Step 4: Run the new worker tests — they should fail (file doesn't exist yet)**

```bash
npx vitest run src/agent-runtime/anthropic-worker.test.ts
```

Expected: FAIL — `AnthropicAgentWorker` not found.

- [ ] **Step 5: Implement `AnthropicAgentWorker`**

Create `src/agent-runtime/anthropic-worker.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { AnthropicLlmClient, type LlmClient } from "./anthropic-llm-client.js";
import type { AgentWorker, WakeEnvelope } from "./worker.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. On wake, check your inbox via the mail.* MCP tools and respond to any unread mail. Reply in-thread with mail.reply; start fresh threads with mail.send.";

const WAKE_PROMPT =
  "You received a wake notification — new activity in your environment. Check your inbox with mail.list (unread_only=true), read anything relevant with mail.get, and reply or send new mail as appropriate. If there is nothing actionable, end your turn without replying.";

export interface AnthropicAgentWorkerOpts {
  client: LlmClient;
  model: string;
  agentsMdPath: string;
  onText?: (text: string) => void;
}

export class AnthropicAgentWorker implements AgentWorker {
  private readonly opts: AnthropicAgentWorkerOpts;

  constructor(opts: AnthropicAgentWorkerOpts) {
    this.opts = opts;
  }

  /** Construct from process env — used by the `buildWorker()` factory. */
  static create(): AnthropicAgentWorker {
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL is required");
    if (!process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is required");

    const toolsRaw = process.env.TEAMROOM_ALLOWED_TOOLS ?? "";
    const allowedTools = toolsRaw.trim() === ""
      ? []
      : toolsRaw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

    const mcpUrl = process.env.TEAMROOM_MCP_URL;
    const mcpToken = process.env.TEAMROOM_MCP_TOKEN;
    const mcpServers: Record<string, McpServerConfig> | undefined =
      mcpUrl && mcpToken
        ? {
            mail: {
              type: "http",
              url: mcpUrl,
              headers: { "x-teamroom-mcp-token": mcpToken },
            },
          }
        : undefined;

    const client = new AnthropicLlmClient({ allowedTools, mcpServers });
    return new AnthropicAgentWorker({
      client,
      model,
      agentsMdPath: "/AGENTS.md",
      onText: (text) => process.stderr.write(`[llm] ${text}\n`),
    });
  }

  async handleWake(_wake: WakeEnvelope): Promise<void> {
    const system = existsSync(this.opts.agentsMdPath)
      ? readFileSync(this.opts.agentsMdPath, "utf8")
      : DEFAULT_SYSTEM_PROMPT;

    const result = await this.opts.client.createMessage({
      model: this.opts.model,
      system,
      messages: [{ role: "user", content: WAKE_PROMPT }],
    });

    if (result.text && this.opts.onText) {
      this.opts.onText(result.text);
    }
  }
}
```

- [ ] **Step 6: Run the worker tests**

```bash
npx vitest run src/agent-runtime/anthropic-worker.test.ts
```

Expected: all five tests pass.

- [ ] **Step 7: Keep `runtime.ts` / `session-store.ts` intact for now** — Task 9 removes them, but for intermediate commits they can coexist. Just verify no regressions on existing `runtime.test.ts`:

```bash
npx vitest run src/agent-runtime/
```

Expected: both `runtime.test.ts` (old, still passing) and `anthropic-worker.test.ts` (new) green.

- [ ] **Step 8: Typecheck** — still FAIL if Task 6's `worker.ts` has the unresolved `langgraph-worker.js` import.

Document status: "bundled commit at end of Group E."

---

## Task 8: Update `main.ts` to use `buildWorker()`

**Files:**
- Modify: `src/agent-runtime/main.ts`

- [ ] **Step 1: Replace `main.ts` contents**

```typescript
import { createInterface } from "node:readline";
import { buildWorker } from "./worker.js";
import type { WakeEnvelope } from "./worker.js";

async function main(): Promise<void> {
  const worker = await buildWorker();

  // Wake loop. Each stdin line is a `{type:"wake", events: [...]}` envelope.
  // EOF (daemon closed stdin) ends the session.
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let envelope: WakeEnvelope;
    try {
      envelope = JSON.parse(trimmed) as WakeEnvelope;
    } catch (err) {
      process.stderr.write(`agent-runtime: invalid wake envelope: ${String(err)}\n`);
      continue;
    }
    try {
      await worker.handleWake(envelope);
    } catch (err) {
      process.stderr.write(
        `agent-runtime: handleWake failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    }
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-runtime fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
```

The old `buildLlmClient` / `makeOpenAiCompatibleClient` / provider-switch / `processWake` call all go away.

- [ ] **Step 2: Confirm no other file imports from `runtime.ts` or `session-store.ts`**

```bash
grep -rn "from.*agent-runtime/runtime\|from.*agent-runtime/session-store\|from \"./runtime" src/ tests/
```

Expected (after Tasks 7 + 8): only `runtime.ts` itself (pre-delete), `runtime.test.ts` (pre-delete), `session-store.ts` (pre-delete), and `session-store.test.ts` (pre-delete) show up. No production callers.

- [ ] **Step 3: Full suite**

```bash
npm test
```

Expected: all green. `runtime.test.ts` still exercises the old path (still present); `anthropic-worker.test.ts` exercises the new path.

- [ ] **Step 4: Typecheck** — still FAIL (langgraph-worker.ts not yet written). Bundle commit pending.

Document status: "bundled commit at end of Group E."

---

## Task 9: Delete legacy `runtime.ts`, `session-store.ts`, and their tests

**Files:**
- Delete: `src/agent-runtime/runtime.ts`
- Delete: `src/agent-runtime/runtime.test.ts`
- Delete: `src/agent-runtime/session-store.ts`
- Delete: `src/agent-runtime/session-store.test.ts`

- [ ] **Step 1: Delete the four files**

```bash
git rm src/agent-runtime/runtime.ts \
       src/agent-runtime/runtime.test.ts \
       src/agent-runtime/session-store.ts \
       src/agent-runtime/session-store.test.ts
```

- [ ] **Step 2: Full suite + typecheck**

```bash
npm test
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: `anthropic-worker.test.ts` covers the previous `runtime.test.ts` surface; `anthropic-llm-client.test.ts` now imports `LlmClient` from `anthropic-llm-client.ts`. **Typecheck still FAILS** because `worker.ts` dynamic-imports `langgraph-worker.js`, which doesn't exist yet. Group E's combined commit lands after Task 11 resolves that.

- [ ] **Step 3: Provisional commit — if executing the bundled Group E**

At this point (end of Group E), Tasks 6 + 7 + 8 + 9 have landed but typecheck is red on the missing `langgraph-worker.js`. Two strategies:

**A (preferred — bundle E+F together):** Hold the commit until Task 11 (langgraph-worker implementation) lands; commit Tasks 6–11 together. Clean typecheck, no bisect hazard.

**B (split E and F into separate commits):** Commit Tasks 6–9 with a temporary stub `langgraph-worker.ts` that exports `export class LangGraphAgentWorker { static create(): never { throw new Error("not implemented yet"); } }`. Typecheck clean; the dynamic import resolves but throws at runtime for `lm-studio`/`ollama` paths. Tasks 10–11 replace the stub.

Strategy A is cleaner and matches the ways-of-working rule on retroactive helper extraction (no intermediate commit compiles in isolation). Recommend A.

If you're taking Strategy A: do nothing here — proceed to Task 10.

If you're taking Strategy B: create the stub now, then:

```bash
git add -A
git commit -m "refactor(agent-runtime): introduce AgentWorker; AnthropicAgentWorker extracted; retire runtime.ts + session-store.ts"
```

---

## Task 10: LangGraph worker — test-first

**Files:**
- Create: `src/agent-runtime/langgraph-worker.test.ts`

- [ ] **Step 1: Understand the test setup**

The LangGraph worker depends on three live-ish collaborators:

1. **Fake `ChatModel`** — we need a chat-model implementation that returns canned responses, including tool-call decisions, to drive the ReAct loop deterministically. `@langchain/core` exposes `FakeChatModel` but its tool-call support is limited; for M5 we'll use a small custom fake that extends `BaseChatModel` and scripts `_generate` responses.

2. **Real in-process MCP server** — we start a `MailMcpServer` on an ephemeral port with a real `MailDispatcher` and real `MessageRepo` backed by an in-memory SQLite via `composeStorage(":memory:")`. This is the same pattern used by `composeIntegrationHarness`.

3. **Real `@langchain/mcp-adapters` client** — points at the local MCP URL; the worker picks up whatever tools the server advertises.

- [ ] **Step 2: Write the test file**

Create `src/agent-runtime/langgraph-worker.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { composeStorage } from "../modules/storage/storage.js";
import { composeMessaging } from "../modules/messaging/messaging.js";
import { composeMcpMail } from "../modules/mcp-mail/mcp-mail.js";
import { ControllableClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { MailMcpServer } from "../mail-mcp/server.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { MessageRepo } from "../db/message-repo.js";
import { LangGraphAgentWorker } from "./langgraph-worker.js";

/**
 * Minimal fake chat model that scripts responses. LangGraph's prebuilt
 * agent only uses invoke() + bindTools() on the model. Each invoke()
 * consumes one scripted AIMessage; tool-call responses would use the
 * tool_calls field, but for these tests the scripted models just return
 * final answers (no tool calls), which terminates the graph immediately.
 */
class ScriptedChatModel {
  public calls: BaseMessage[][] = [];
  constructor(private readonly script: AIMessage[]) {}
  bindTools(_tools: unknown[]): ScriptedChatModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.calls.push(messages);
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedChatModel: script exhausted");
    return next;
  }
}

/**
 * Stand up a real in-process MCP mail stack for the LangGraph worker to
 * connect to. Uses the same composers the daemon uses (composeStorage /
 * composeMessaging / composeMcpMail) + a real MailMcpServer on an
 * ephemeral port. Returns the mcpUrl + a valid token the worker should use.
 */
async function startMailHarness(): Promise<{
  mcpUrl: string;
  mcpToken: string;
  messageRepo: MessageRepo;
  stop: () => Promise<void>;
}> {
  const clock = new ControllableClock("2026-04-22T00:00:00.000Z");
  const logger = new JsonLinesLogger(clock, () => {}, { component: "test" });
  const storage = composeStorage({ dataDir: ":memory:" });
  storage.agentRepo.create({
    id: "studio-assistant",
    configPath: "/a",
    createdAt: "2026-04-22T00:00:00.000Z",
  });
  storage.agentRepo.create({
    id: "sender",
    configPath: "/b",
    createdAt: "2026-04-22T00:00:00.000Z",
  });
  const messaging = composeMessaging({ logger });

  const baseCfg: Omit<AgentConfig, "name" | "provider" | "configPath" | "agentsMdPath" | "storePath"> = {
    model: "m",
    imageTag: "t",
    subscriptions: [],
    allowedTools: [],
  };
  const agentConfigs = new Map<string, AgentConfig>([
    ["studio-assistant", {
      ...baseCfg, name: "studio-assistant", provider: "lm-studio",
      configPath: "/a", agentsMdPath: "/a/AGENTS.md", storePath: "/a/store",
    }],
    ["sender", {
      ...baseCfg, name: "sender", provider: "anthropic",
      configPath: "/b", agentsMdPath: "/b/AGENTS.md", storePath: "/b/store",
    }],
  ]);

  let seq = 0;
  const mcpMail = composeMcpMail({
    storage,
    messaging,
    logger,
    clock,
    genId: () => `id-${++seq}`,
    agentConfigs,
    lists: [],
    maxMailsPerThread: 40,
  });

  const MCP_TOKEN = "test-mcp-token";
  const server = new MailMcpServer({
    tools: mcpMail.mcpTools,
    tokenResolver: (token) => (token === MCP_TOKEN ? "studio-assistant" : null),
    port: 0,
    host: "127.0.0.1",
    logger,
  });
  await server.start();
  const { port } = server.address();

  return {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    mcpToken: MCP_TOKEN,
    messageRepo: storage.messageRepo,
    stop: async () => {
      await server.stop();
      storage.close();
    },
  };
}

describe("LangGraphAgentWorker", () => {
  let harness: Awaited<ReturnType<typeof startMailHarness>> | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it("discovers MCP tools from the mail server at construction time", async () => {
    harness = await startMailHarness();
    const model = new ScriptedChatModel([new AIMessage("no-op")]);
    const worker = await LangGraphAgentWorker.createForTest({
      model: model as unknown as BaseChatModel,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "You are a test agent.",
      agentsMdPath: "/does-not-exist",
    });
    const toolNames = worker.toolNamesForTest();
    expect(toolNames).toEqual(
      expect.arrayContaining(["mail.list", "mail.get", "mail.send", "mail.reply"]),
    );
  });

  it("on wake: appends a HumanMessage, invokes graph, logs final AI text to stderr", async () => {
    harness = await startMailHarness();
    const model = new ScriptedChatModel([
      new AIMessage("I have nothing to do this wake."),
    ]);
    const texts: string[] = [];
    const worker = await LangGraphAgentWorker.createForTest({
      model: model as unknown as BaseChatModel,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "You are a test agent.",
      agentsMdPath: "/does-not-exist",
      onText: (t) => texts.push(t),
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    // Final AI message text flowed to onText
    expect(texts).toEqual(["I have nothing to do this wake."]);
    // Model saw the wake prompt
    expect(model.calls).toHaveLength(1);
    const firstCall = model.calls[0]!;
    const last = firstCall[firstCall.length - 1];
    expect(last).toBeInstanceOf(HumanMessage);
  });

  it("trims the messages array to the last 40 after a wake that pushes it past 40", async () => {
    harness = await startMailHarness();
    // Script 41 iterations — each returns a final answer (no tool calls).
    const script = Array.from({ length: 41 }, (_, i) => new AIMessage(`answer-${i}`));
    const model = new ScriptedChatModel(script);
    const worker = await LangGraphAgentWorker.createForTest({
      model: model as unknown as BaseChatModel,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
    });
    for (let i = 0; i < 41; i++) {
      await worker.handleWake({ type: "wake", events: ["mail"] });
    }
    expect(worker.messageCountForTest()).toBe(40);
  });

  it("graph exceptions are logged but do not crash the worker", async () => {
    harness = await startMailHarness();
    const model: BaseChatModel = {
      bindTools: () => model,
      invoke: async () => {
        throw new Error("synthetic graph failure");
      },
    } as unknown as BaseChatModel;
    const errs: string[] = [];
    const worker = await LangGraphAgentWorker.createForTest({
      model,
      mcpUrl: harness.mcpUrl,
      mcpToken: harness.mcpToken,
      systemPrompt: "test",
      agentsMdPath: "/does-not-exist",
      onError: (e) => errs.push(e instanceof Error ? e.message : String(e)),
    });
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toEqual([expect.stringContaining("synthetic graph failure")]);
    // Worker still alive: a second wake also runs (and logs again).
    await worker.handleWake({ type: "wake", events: ["mail"] });
    expect(errs).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the test file — it fails because the worker doesn't exist**

```bash
npx vitest run src/agent-runtime/langgraph-worker.test.ts
```

Expected: FAIL — `LangGraphAgentWorker` not exported from `./langgraph-worker.js`.

Implementer completes the harness wiring in this task so that Step 3 fails only on the missing worker class (that's what Task 11 fills in).

- [ ] **Step 4: Do NOT commit yet** — tests are red because the implementation doesn't exist. The Group E+F bundle commits Tasks 6–11 as one coherent change.

---

## Task 11: LangGraph worker — implementation

**Files:**
- Create: `src/agent-runtime/langgraph-worker.ts`

- [ ] **Step 1: Install verifies (sanity check)**

```bash
node -e "import('@langchain/langgraph/prebuilt').then(m => console.log(Object.keys(m)))"
```

Expected output includes `createReactAgent`.

```bash
node -e "import('@langchain/mcp-adapters').then(m => console.log(Object.keys(m)))"
```

Expected output includes `MultiServerMCPClient` (or the package's documented client export — confirm against the installed version's `dist/index.d.ts`).

- [ ] **Step 2: Write the worker**

Create `src/agent-runtime/langgraph-worker.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { HumanMessage, BaseMessage, AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { AgentWorker, WakeEnvelope } from "./worker.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. On wake, check your inbox via the mail.* MCP tools and respond to any unread mail.";

const WAKE_PROMPT =
  "You received a wake notification — new activity in your environment. Check your inbox with mail.list (unreadOnly=true), read anything relevant with mail.get, and reply or send new mail as appropriate. If there is nothing actionable, end your turn without replying.";

const MAX_MESSAGES = 40;
const RECURSION_LIMIT = 10;
const MAX_RETRIES = 2;

export interface LangGraphAgentWorkerOpts {
  model: BaseChatModel;
  mcpUrl: string;
  mcpToken: string;
  systemPrompt: string;
  agentsMdPath: string;
  onText?: (text: string) => void;
  onError?: (err: unknown) => void;
}

export class LangGraphAgentWorker implements AgentWorker {
  private readonly opts: LangGraphAgentWorkerOpts;
  private readonly agent: ReturnType<typeof createReactAgent>;
  private readonly mcpClient: MultiServerMCPClient;
  private readonly toolNames: string[];
  private messages: BaseMessage[] = [];

  private constructor(
    opts: LangGraphAgentWorkerOpts,
    agent: ReturnType<typeof createReactAgent>,
    mcpClient: MultiServerMCPClient,
    toolNames: string[],
  ) {
    this.opts = opts;
    this.agent = agent;
    this.mcpClient = mcpClient;
    this.toolNames = toolNames;
  }

  /** Production factory — reads env vars. Wires the real `ChatOpenAI` pointed at the daemon proxy. */
  static async create(): Promise<LangGraphAgentWorker> {
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    const baseURL = process.env.TEAMROOM_MODEL_BASE_URL;
    if (!baseURL) throw new Error("TEAMROOM_MODEL_BASE_URL is required");
    const apiKey = process.env.TEAMROOM_MODEL_API_TOKEN ?? "not-required";
    const mcpUrl = process.env.TEAMROOM_MCP_URL;
    const mcpToken = process.env.TEAMROOM_MCP_TOKEN;
    if (!mcpUrl) throw new Error("TEAMROOM_MCP_URL is required");
    if (!mcpToken) throw new Error("TEAMROOM_MCP_TOKEN is required");

    // OpenAI SDK appends /v1/chat/completions; LM Studio and Ollama both
    // expose /v1. Match the prior runtime's behavior.
    const configuration = {
      baseURL: baseURL.replace(/\/$/, "") + "/v1",
      apiKey,
    };
    const chat = new ChatOpenAI({
      model,
      maxRetries: MAX_RETRIES,
      configuration,
    });

    return LangGraphAgentWorker.build({
      model: chat,
      mcpUrl,
      mcpToken,
      systemPrompt: "",  // loaded from AGENTS.md in handleWake
      agentsMdPath: "/AGENTS.md",
      onText: (t) => process.stderr.write(`[llm] ${t}\n`),
      onError: (e) => process.stderr.write(`[graph-error] ${e instanceof Error ? e.message : String(e)}\n`),
    });
  }

  /** Test factory — caller supplies a fake/real model and MCP endpoint directly. */
  static async createForTest(opts: LangGraphAgentWorkerOpts): Promise<LangGraphAgentWorker> {
    return LangGraphAgentWorker.build(opts);
  }

  private static async build(opts: LangGraphAgentWorkerOpts): Promise<LangGraphAgentWorker> {
    const mcpClient = new MultiServerMCPClient({
      mcpServers: {
        mail: {
          transport: "http",
          url: opts.mcpUrl,
          headers: { "x-teamroom-mcp-token": opts.mcpToken },
        },
      },
    });
    const tools = await mcpClient.getTools();
    const toolNames = tools.map((t) => t.name);

    const systemPrompt = existsSync(opts.agentsMdPath)
      ? readFileSync(opts.agentsMdPath, "utf8")
      : opts.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    const agent = createReactAgent({
      llm: opts.model,
      tools,
      messageModifier: systemPrompt,
    });

    return new LangGraphAgentWorker(opts, agent, mcpClient, toolNames);
  }

  async handleWake(_wake: WakeEnvelope): Promise<void> {
    this.messages.push(new HumanMessage(WAKE_PROMPT));
    try {
      const result = await this.agent.invoke(
        { messages: this.messages },
        { recursionLimit: RECURSION_LIMIT },
      );
      this.messages = result.messages as BaseMessage[];
      if (this.messages.length > MAX_MESSAGES) {
        this.messages = this.messages.slice(-MAX_MESSAGES);
      }
      const last = this.messages[this.messages.length - 1];
      if (last instanceof AIMessage && typeof last.content === "string" && this.opts.onText) {
        this.opts.onText(last.content);
      }
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err);
    }
  }

  // Test-only inspectors.
  toolNamesForTest(): string[] {
    return this.toolNames;
  }
  messageCountForTest(): number {
    return this.messages.length;
  }
}
```

- [ ] **Step 3: Run the LangGraph worker tests**

```bash
npx vitest run src/agent-runtime/langgraph-worker.test.ts
```

Expected: all four tests pass.

If `createReactAgent`'s API in the installed version differs (e.g., `prompt` instead of `messageModifier`, or the tool-result flow expects different message types), adjust per `node_modules/@langchain/langgraph/dist/prebuilt/react_agent_executor.d.ts`. Verify the tool-calling loop terminates correctly when the model returns an `AIMessage` with no `tool_calls`.

- [ ] **Step 4: Full suite + typecheck**

```bash
npm test
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json
```

Expected: green.

- [ ] **Step 5: Commit — Group E+F combined**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(agent-runtime): add LangGraphAgentWorker; refactor to AgentWorker shape

- Introduce AgentWorker interface + buildWorker() factory.
- Extract AnthropicAgentWorker from runtime.ts/processWake (behavior preserved).
- Add LangGraphAgentWorker (createReactAgent + @langchain/mcp-adapters;
  bounded in-process messages array, cap 40; recursionLimit 10; maxRetries 2).
- main.ts drives via buildWorker().handleWake(); provider-aware factory.
- Retire runtime.ts, session-store.ts, and their tests (coverage ported to
  anthropic-worker.test.ts + langgraph-worker.test.ts).

New runtime supports provider in {anthropic, lm-studio, ollama}. LangGraph
worker is shared by lm-studio + ollama (same OpenAI-compat HTTP shape,
different proxy upstream routing).
EOF
)"
```

---

## Task 12: Migrate `studio-assistant/agent.yaml`

**Files:**
- Modify: `agents/studio-assistant/agent.yaml`

- [ ] **Step 1: Replace yaml contents**

```yaml
name: studio-assistant
model: google/gemma-4-e4b
image_tag: teamroom-agent-studio-assistant:latest
provider: lm-studio
subscriptions: []
```

The model swap + comment removal is the whole change.

- [ ] **Step 2: Verify agent-config still loads it**

```bash
npx vitest run src/agent-config/
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add agents/studio-assistant/agent.yaml
git commit -m "config(studio-assistant): switch model to google/gemma-4-e4b; remove deferred-to-M5 comment"
```

---

## Task 13: Rewrite `studio-assistant/AGENTS.md`

**Files:**
- Modify: `agents/studio-assistant/AGENTS.md`

- [ ] **Step 1: Replace the file contents entirely**

```markdown
# AGENTS.md — studio-assistant

You are `studio-assistant`, a local LangGraph-backed AI assistant running inside the Team Room harness on a local model (LM Studio or Ollama). You communicate with humans (via CLI) and with teammate agents via a shared mail substrate.

Be concise. Answer questions directly. If you don't know something, say so.

## How you communicate

All communication flows through MCP mail tools registered via `@langchain/mcp-adapters`. Tool names are unprefixed — call `mail.list`, `mail.get`, `mail.send`, `mail.reply`, `mail.mark_read`, `mail.archive`, `mail.delete`.

### On wake

The daemon wakes you when there is new mail. Start every wake by calling `mail.list` with `{unreadOnly: true}` to see what's fresh. Then:

- Read a specific mail with `mail.get` (arguments: `{id}`).
- Reply in-thread with `mail.reply` (arguments: `{id, body, ccAll?}`). Inherits `thread_id`; `ccAll=true` keeps the whole group on the reply (Slack-style).
- Start a new thread with `mail.send` (arguments: `{to: [...], body, subject?}`).
- Housekeep with `mail.mark_read`, `mail.archive`, `mail.delete` (each takes `{id}`).

### Addresses

- `agent:<name>` — a teammate's inbox. Self-mail is allowed.
- `channel:cli:<user>` — a CLI user's terminal (surfaced via `teamroom chat`).
- `list:<name>` — a mailing list. Membership is resolved at send time.

### Team roster

- `agent:studio-assistant` — you, local model (LangGraph).
- `agent:claude-assistant` — Anthropic-backed teammate, coding-focused.
- `agent:claude-researcher` — Anthropic-backed, deep-reader teammate.
- `channel:cli:*` — humans using `teamroom chat` / `teamroom send`.

### Thread cap

Threads are capped at 40 non-deleted mails by default. If you hit it, archive old mails or start a fresh thread.

## Shared codebase

`/codebase` is a shared read-write mount visible to every agent in the team. Your `/store` directory remains your per-agent scratch space — between-turn state you keep in `/store` survives until the container is torn down.
```

- [ ] **Step 2: Commit**

```bash
git add agents/studio-assistant/AGENTS.md
git commit -m "docs(studio-assistant): rewrite AGENTS.md for MCP mail pattern (was M3 stdout envelope)"
```

---

## Task 14: Rebuild `studio-assistant` container image

**Files:** (none modified)

- [ ] **Step 1: Build the repo**

```bash
npm run build
```

Expected: clean TypeScript compile; `dist/agent-runtime/` contains compiled `main.js`, `worker.js`, `anthropic-worker.js`, `langgraph-worker.js`, `anthropic-llm-client.js`.

- [ ] **Step 2: Build the container image**

```bash
docker build -t teamroom-agent-studio-assistant:latest agents/studio-assistant/
```

Expected: build succeeds. `npm ci --omit=dev` pulls in the four new `@langchain/*` packages.

- [ ] **Step 3: Spot-check the image contents**

```bash
docker run --rm teamroom-agent-studio-assistant:latest ls /app/agent-runtime
```

Expected: `main.js`, `worker.js`, `anthropic-worker.js`, `langgraph-worker.js`, `anthropic-llm-client.js` visible.

- [ ] **Step 4: Verify LangChain deps present in the image**

```bash
docker run --rm teamroom-agent-studio-assistant:latest node -e "console.log(Object.keys(require('@langchain/langgraph/prebuilt')))"
```

Expected: output includes `createReactAgent`.

- [ ] **Step 5: Commit** (no file changes in this task; optionally skip the commit and note the image rebuild in the as-built)

If you want a checkpoint marker:

```bash
git commit --allow-empty -m "build(studio-assistant): image rebuilt with LangGraph + MCP adapter deps"
```

---

## Task 15: Delete the orphan `agents/assistant/` folder

**Files:**
- Delete: `agents/assistant/` (and contents — just `store/`)

- [ ] **Step 1: Remove the folder**

```bash
git rm -r agents/assistant
```

- [ ] **Step 2: Verify nothing references it**

```bash
grep -rn "agents/assistant" src/ tests/ docs/ 2>/dev/null
```

Expected: no references. (If any turn up, they're in documentation and should be updated inline to reference `studio-assistant`/`claude-assistant`.)

- [ ] **Step 3: Full suite**

```bash
npm test
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git commit -m "remove(agents): orphan assistant/ folder (store-only; superseded by named agents)"
```

---

## Task 16: Update `src/agent-runtime/README.md` for the new shape

**Files:**
- Modify: `src/agent-runtime/README.md`

- [ ] **Step 1: Replace the "Files" section to reflect the AgentWorker shape**

Open `src/agent-runtime/README.md` and replace lines that describe `main.ts`, `runtime.ts`, and the "inline OpenAI-compatible client" with:

```markdown
## Files

- `main.ts` — container entry. Reads stdin wake envelopes one per line, delegates to `worker.handleWake(envelope)`. Errors per-envelope are logged to stderr; the loop continues.
- `worker.ts` — `AgentWorker` interface + `WakeEnvelope` type + `buildWorker()` factory keyed on `TEAMROOM_PROVIDER`. Anthropic → `AnthropicAgentWorker`; lm-studio / ollama → `LangGraphAgentWorker`.
- `anthropic-worker.ts` — wraps `AnthropicLlmClient`; each wake reads AGENTS.md as system prompt, sends a canned `WAKE_PROMPT`, pipes LLM text to stderr. Claude-agent-sdk handles the tool-call loop internally.
- `anthropic-llm-client.ts` — SDK shim around `@anthropic-ai/claude-agent-sdk`. Proxied via `ANTHROPIC_BASE_URL`; session resume via the sidecar under `/store`.
- `langgraph-worker.ts` — wraps LangGraph's prebuilt `createReactAgent` + `@langchain/mcp-adapters` MCP client pointed at the daemon's mail MCP. Holds a bounded `messages: BaseMessage[]` (cap 40) across wakes for within-container context persistence. Uses `ChatOpenAI` pointed at the daemon proxy URL (OpenAI-compat, routes to LM Studio or Ollama per the proxy adapter). `recursionLimit: 10`, `maxRetries: 2`.
```

Also update any stale "Related" links and remove references to `runtime.ts` / `session-store.ts`.

- [ ] **Step 2: Commit**

```bash
git add src/agent-runtime/README.md
git commit -m "docs(agent-runtime): update README for AgentWorker shape (Anthropic + LangGraph)"
```

---

## Task 17: Full suite + typecheck — acceptance gate

**Files:** (none modified)

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all tests pass across all files. No skips, no failures.

- [ ] **Step 2: Typecheck both configs**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
```

Expected: clean.

- [ ] **Step 3: Final verify — grep for dangling references**

```bash
grep -rn "runtime.js\|session-store.js\|LmStudioAdapter\|lm-studio-adapter" src/ tests/ 2>/dev/null
```

Expected: no matches.

- [ ] **Step 4: No commit** — this is a verification gate; if anything fails, it's a regression to fix before handing off to manual acceptance.

---

## Manual acceptance scenarios (post-plan; run at milestone close)

These scenarios are documented in the spec (§7) and executed by a human; they are not part of the automated plan. They land in the as-built at milestone close.

1. **Claude ↔ Studio mail round-trip** — real Gemma-4 via LM Studio.
2. **CLI ↔ Studio** via `teamroom chat agent:studio-assistant`.
3. **Context cap observed** after 20+ wakes.
4. **Ollama smoke** — swap LM Studio for Ollama, re-run scenario 1.

---

## Bundling pass (per `docs/ways-of-working.md` addendum)

**Group A — Foundation (Tasks 1, 2):** Provider type + env tunable. Tiny diffs, config-only, share a reviewer. One subagent dispatch.

**Group B — Adapter consolidation (Tasks 3, 4):** OpenAI-compat refactor + ollama wiring in composeModelProxy. Tightly coupled — the adapter rename and its only consumer change together. One subagent dispatch.

**Group C — Dependencies (Task 5):** Standalone `npm install`. Separate because it's an environmental change that should have its own verification gate before worker implementation. One subagent dispatch.

**Group D+E — Runtime refactor + LangGraph worker (Tasks 6, 7, 8, 9, 10, 11):** The typecheck is only clean at the end of Task 11, so this bundle MUST commit once (not per-task) to avoid the bisect hazard flagged in M4.5 retro §2. Six tasks, one big coherent commit. Consider splitting reviewer dispatches by layer: spec-review after Task 8 (worker shape), code-review after Task 11 (LangGraph impl). Or combined spec+code review at the end.

**Group F — Agent migration + image build (Tasks 12, 13, 14):** studio-assistant yaml + AGENTS.md + Dockerfile rebuild. Pure-config + docs + build verification. One subagent dispatch.

**Group G — Cleanup + docs + final verify (Tasks 15, 16, 17):** Delete orphan folder, update README, run the acceptance gate. One subagent dispatch; Task 17's verification gate is the green-light for manual acceptance.

**Seven groups total.** Comparable density to M4.5's 24 groups over 38 tasks (ratio ~0.63 tasks/group); this plan ships at ~2.4 tasks/group, reflecting a smaller, more surgical milestone. If the Group D+E bundle proves unwieldy during execution, split after Task 9 with the stub-strategy (Strategy B in Task 9 Step 3).

---

## Self-review notes

- **Spec coverage:** §1 overall shape → Tasks 6–11. §2 scope — in / out both fully addressed. §3 runtime layout → Tasks 6, 7, 8, 9, 16. §4 daemon changes → Tasks 1, 2, 3, 4. §5 agent config → Tasks 12, 13, 14, 15. §6 testing → Tasks 3, 7, 10, 11. §7 acceptance automated → Task 17. §8 new backlog → deferred to as-built.
- **Placeholder scan:** clean — no TBD / TODO / FIXME markers. Earlier draft had a "harness wiring TBD" placeholder in Task 10; replaced with concrete `startMailHarness()` code using `composeStorage` + `composeMessaging` + `composeMcpMail` + a real `MailMcpServer` on an ephemeral port.
- **Type consistency:** `AgentWorker`, `WakeEnvelope`, `LlmClient`, `OpenAICompatAdapter`, `LangGraphAgentWorker` names match across all tasks. `buildWorker()` signature (`Promise<AgentWorker>`) matches its consumers in `main.ts`.
- **Known hazards:** the Group D+E typecheck-red-until-Task-11 bundle is the one place to watch during execution (flagged twice in the plan).
