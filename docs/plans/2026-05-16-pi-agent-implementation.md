# Pi Agent Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class Pi SDK based general coding teammate (`pi-coder`) that uses Team Room's mail substrate, codebase mount, and centralized model proxy.

**Architecture:** Split agent `runtime` from model `provider`; existing configs infer runtime from provider, while `pi-coder` declares `runtime: pi` and `provider: openai` with `model: openai/gpt-5.5`. Add a `PiAgentWorker` that creates a long-lived Pi SDK session in the container, points Pi's model configuration at the Team Room proxy using the routing token, and registers Team Room mail tools as Pi extension tools.

**Tech Stack:** TypeScript strict mode, Vitest, Docker, Team Room daemon/model-proxy/mail-MCP, `@earendil-works/pi-coding-agent` SDK, `typebox` for Pi tool schemas.

---

## Task 1: Add `runtime` to agent config with backward-compatible inference

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent-config/agent-config.ts`
- Modify: `src/agent-config/agent-config.test.ts`

**Step 1: Write failing config-loader tests**

Append tests under `describe("loadAgentConfig — provider field", ...)` or a new `describe("loadAgentConfig — runtime field", ...)`:

```ts
it("infers runtime from provider when runtime is omitted", () => {
  writeFileSync(
    join(agentDir, "agent.yaml"),
    "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
  );
  expect(loadAgentConfig(agentDir).runtime).toBe("anthropic");

  writeFileSync(
    join(agentDir, "agent.yaml"),
    "name: x\nmodel: y\nimage_tag: z\nprovider: lm-studio\n",
  );
  expect(loadAgentConfig(agentDir).runtime).toBe("langgraph");

  writeFileSync(
    join(agentDir, "agent.yaml"),
    "name: x\nmodel: y\nimage_tag: z\nprovider: ollama\n",
  );
  expect(loadAgentConfig(agentDir).runtime).toBe("langgraph");
});

it("accepts explicit runtime: pi with an existing model provider", () => {
  writeFileSync(
    join(agentDir, "agent.yaml"),
    "name: pi-coder\nmodel: claude-opus-4-7\nimage_tag: teamroom-agent-pi-coder:latest\nruntime: pi\nprovider: anthropic\n",
  );
  const cfg = loadAgentConfig(agentDir);
  expect(cfg.runtime).toBe("pi");
  expect(cfg.provider).toBe("anthropic");
  expect(cfg.model).toBe("claude-opus-4-7");
});

it("rejects unknown runtime values", () => {
  writeFileSync(
    join(agentDir, "agent.yaml"),
    "name: x\nmodel: y\nimage_tag: z\nruntime: bespoke\nprovider: anthropic\n",
  );
  expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*anthropic.*langgraph.*pi/);
});
```

**Step 2: Run the failing tests**

Run:

```bash
npm test -- src/agent-config/agent-config.test.ts
```

Expected: compile/test failure because `runtime` does not exist.

**Step 3: Implement runtime types and parsing**

In `src/types.ts`, add:

```ts
export type Provider = "anthropic" | "lm-studio" | "ollama";
export type AgentRuntime = "anthropic" | "langgraph" | "pi";
```

In `src/agent-config/agent-config.ts`:

- import `AgentRuntime`
- add `runtime: AgentRuntime` to `AgentConfig`
- parse optional `runtime`
- infer with helper:

```ts
function inferRuntime(provider: Provider): AgentRuntime {
  switch (provider) {
    case "anthropic": return "anthropic";
    case "lm-studio":
    case "ollama": return "langgraph";
  }
}

function parseRuntime(value: unknown, provider: Provider): AgentRuntime {
  if (value === undefined || value === null) return inferRuntime(provider);
  if (value !== "anthropic" && value !== "langgraph" && value !== "pi") {
    throw new Error(
      `agent.yaml 'runtime' must be 'anthropic', 'langgraph', or 'pi' (got '${String(value)}')`,
    );
  }
  return value;
}
```

Return `runtime` in `loadAgentConfig()`.

Do not remove provider validation: `provider` still means upstream model provider.

**Step 4: Run tests**

Run:

```bash
npm test -- src/agent-config/agent-config.test.ts
npm run typecheck
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/types.ts src/agent-config/agent-config.ts src/agent-config/agent-config.test.ts
git commit -m "feat(agent-config): split runtime from model provider"
```

---

## Task 2: Inject `TEAMROOM_RUNTIME` into container specs

**Files:**
- Modify: `src/agent-spec/build-spec.ts`
- Modify: `src/agent-spec/build-spec.test.ts`

**Step 1: Write failing build-spec tests**

Update the `cfg` fixture in `src/agent-spec/build-spec.test.ts` to include `runtime: "anthropic"`.

In the first test, add:

```ts
expect(spec.env.TEAMROOM_RUNTIME).toBe("anthropic");
expect(spec.env.TEAMROOM_PROVIDER).toBe("anthropic");
```

Add a new test:

```ts
it("uses runtime for worker selection while preserving provider for token routing", () => {
  const tokenRegistry = new TokenRegistry(() => "proxy-token");
  const piCfg: AgentConfig = {
    ...cfg,
    name: "pi-coder",
    runtime: "pi",
    provider: "anthropic",
    imageTag: "teamroom-agent-pi-coder:latest",
  };
  const spec = buildSpec({
    agentId: "pi-coder",
    mcpToken: "mcp-token",
    agentConfigs: new Map([["pi-coder", piCfg]]),
    tokenRegistry,
    modelBaseUrl: "http://host.docker.internal:9000",
    mailPort: 7777,
    codebasePath: "/codebase",
    genId: () => "trace-1",
  });

  expect(spec.env.TEAMROOM_RUNTIME).toBe("pi");
  expect(spec.env.TEAMROOM_PROVIDER).toBe("anthropic");
  expect(spec.env.TEAMROOM_MODEL).toBe("claude-opus-4-7");
  expect(tokenRegistry.lookup("proxy-token")).toMatchObject({
    agentId: "pi-coder",
    provider: "anthropic",
    model: "claude-opus-4-7",
  });
});
```

**Step 2: Run failing tests**

```bash
npm test -- src/agent-spec/build-spec.test.ts
```

Expected: type failure until `runtime` is included and env var is emitted.

**Step 3: Implement env injection**

In `buildSpec()`, add:

```ts
TEAMROOM_RUNTIME: cfg.runtime,
```

Keep `TEAMROOM_PROVIDER: cfg.provider` unchanged.

**Step 4: Run tests**

```bash
npm test -- src/agent-spec/build-spec.test.ts
npm run typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/agent-spec/build-spec.ts src/agent-spec/build-spec.test.ts
git commit -m "feat(agent-spec): pass runtime to agent containers"
```

---

## Task 3: Dispatch workers by runtime with backward compatibility

**Files:**
- Modify: `src/agent-runtime/worker.ts`
- Modify: `src/agent-runtime/worker.test.ts`
- Create: `src/agent-runtime/pi-worker.ts` (temporary minimal stub for dispatch; fuller implementation lands later)

**Step 1: Write failing worker tests**

Replace existing provider-only tests with runtime-aware tests:

```ts
function withEnv(env: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    prev.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

it("uses TEAMROOM_RUNTIME when present", async () => {
  await withEnv({ TEAMROOM_RUNTIME: "bogus", TEAMROOM_PROVIDER: "anthropic" }, async () => {
    await expect(buildWorker()).rejects.toThrow(/TEAMROOM_RUNTIME/);
  });
});

it("falls back to TEAMROOM_PROVIDER for old containers", async () => {
  await withEnv({ TEAMROOM_RUNTIME: undefined, TEAMROOM_PROVIDER: "bogus" }, async () => {
    await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
  });
});
```

Do not instantiate real workers in this test; existing worker factories require env/model/MCP setup. The dispatch success path for Pi will be covered by `PiAgentWorker` unit tests.

**Step 2: Run failing tests**

```bash
npm test -- src/agent-runtime/worker.test.ts
```

Expected: failure because `TEAMROOM_RUNTIME` is ignored.

**Step 3: Implement runtime dispatch**

In `worker.ts`:

```ts
function runtimeFromEnv(): { runtime: string; source: "TEAMROOM_RUNTIME" | "TEAMROOM_PROVIDER" } {
  const runtime = process.env.TEAMROOM_RUNTIME;
  if (runtime) return { runtime, source: "TEAMROOM_RUNTIME" };
  const provider = process.env.TEAMROOM_PROVIDER;
  if (!provider) throw new Error("TEAMROOM_PROVIDER is required");
  switch (provider) {
    case "anthropic": return { runtime: "anthropic", source: "TEAMROOM_PROVIDER" };
    case "lm-studio":
    case "ollama": return { runtime: "langgraph", source: "TEAMROOM_PROVIDER" };
    default: throw new Error(`unknown TEAMROOM_PROVIDER: '${provider}'`);
  }
}
```

Then switch on `runtime`:

```ts
case "anthropic": ...
case "langgraph": ...
case "pi": {
  const { PiAgentWorker } = await import("./pi-worker.js");
  return PiAgentWorker.create();
}
default:
  throw new Error(`unknown ${source}: '${runtime}'`);
```

Create a temporary `pi-worker.ts`:

```ts
import type { AgentWorker, WakeEnvelope } from "./worker.js";

export class PiAgentWorker implements AgentWorker {
  static async create(): Promise<PiAgentWorker> {
    throw new Error("PiAgentWorker not implemented yet");
  }
  async handleWake(_wake: WakeEnvelope): Promise<void> {}
}
```

This is acceptable only inside this task because later tasks replace it before acceptance.

**Step 4: Run tests**

```bash
npm test -- src/agent-runtime/worker.test.ts
npm run typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/agent-runtime/worker.ts src/agent-runtime/worker.test.ts src/agent-runtime/pi-worker.ts
git commit -m "feat(agent-runtime): dispatch workers by runtime"
```

---

## Task 4: Add Pi SDK dependency and model configuration helper

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/agent-runtime/pi-model.ts`
- Create: `src/agent-runtime/pi-model.test.ts`

**Step 1: Add dependency**

Run:

```bash
npm install @earendil-works/pi-coding-agent
```

If npm updates unrelated transitive deps, inspect `git diff package-lock.json` and keep only lockfile changes required by the new dependency.

**Step 2: Write failing tests for Pi model provider config**

Create `src/agent-runtime/pi-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPiModelConfig } from "./pi-model.js";

describe("buildPiModelConfig", () => {
  it("maps anthropic provider to an Anthropic-compatible Pi provider through Team Room proxy", () => {
    const cfg = buildPiModelConfig({
      provider: "anthropic",
      model: "claude-opus-4-7",
      baseUrl: "http://host.docker.internal:9000",
      apiToken: "route-token",
    });

    expect(cfg.providerId).toBe("teamroom-anthropic");
    expect(cfg.modelId).toBe("claude-opus-4-7");
    expect(cfg.modelsJson.providers["teamroom-anthropic"]).toMatchObject({
      baseUrl: "http://host.docker.internal:9000",
      api: "anthropic-messages",
      apiKey: "route-token",
      models: [{ id: "claude-opus-4-7" }],
    });
  });

  it("maps lm-studio and ollama to OpenAI-compatible Pi providers through Team Room proxy", () => {
    for (const provider of ["lm-studio", "ollama"] as const) {
      const cfg = buildPiModelConfig({
        provider,
        model: "openai/gpt-oss-20b",
        baseUrl: "http://host.docker.internal:9000",
        apiToken: "route-token",
      });
      expect(cfg.modelsJson.providers[`teamroom-${provider}`]).toMatchObject({
        baseUrl: "http://host.docker.internal:9000/v1",
        api: "openai-completions",
        apiKey: "route-token",
        authHeader: true,
        models: [{ id: "openai/gpt-oss-20b" }],
      });
    }
  });
});
```

**Step 3: Run failing tests**

```bash
npm test -- src/agent-runtime/pi-model.test.ts
```

Expected: module missing.

**Step 4: Implement helper**

Create `src/agent-runtime/pi-model.ts`:

```ts
import type { Provider } from "../types.js";

export interface BuildPiModelConfigArgs {
  provider: Provider;
  model: string;
  baseUrl: string;
  apiToken: string;
}

export interface PiModelsJson {
  providers: Record<string, unknown>;
}

export interface PiModelConfig {
  providerId: string;
  modelId: string;
  modelsJson: PiModelsJson;
}

export function buildPiModelConfig(args: BuildPiModelConfigArgs): PiModelConfig {
  const providerId = `teamroom-${args.provider}`;
  const cleanBase = args.baseUrl.replace(/\/$/, "");
  if (args.provider === "anthropic") {
    return {
      providerId,
      modelId: args.model,
      modelsJson: {
        providers: {
          [providerId]: {
            baseUrl: cleanBase,
            api: "anthropic-messages",
            apiKey: args.apiToken,
            models: [{ id: args.model }],
          },
        },
      },
    };
  }

  return {
    providerId,
    modelId: args.model,
    modelsJson: {
      providers: {
        [providerId]: {
          baseUrl: `${cleanBase}/v1`,
          api: "openai-completions",
          apiKey: args.apiToken,
          authHeader: true,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: args.model }],
        },
      },
    },
  };
}
```

Note: During implementation, verify Pi's `models.json` schema from `docs/models.md`. If `authHeader` is not required for `openai-completions`, remove it and update the test.

**Step 5: Run tests**

```bash
npm test -- src/agent-runtime/pi-model.test.ts
npm run typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/agent-runtime/pi-model.ts src/agent-runtime/pi-model.test.ts
git commit -m "feat(agent-runtime): configure pi models through proxy"
```

---

## Task 5: Implement Team Room mail tools for Pi

**Files:**
- Create: `src/agent-runtime/pi-mail-tools.ts`
- Create: `src/agent-runtime/pi-mail-tools.test.ts`

**Step 1: Write tests against a local fake MCP HTTP endpoint**

Create `src/agent-runtime/pi-mail-tools.test.ts` using `node:http` to capture requests. Tests should verify:

- each tool posts to `/mcp`
- header `x-teamroom-mcp-token` is present
- JSON-RPC method is `tools/call`
- tool names map from Pi-safe names to MCP names (`mail_list` -> `mail.list`)
- text JSON content is parsed into returned Pi tool text

Skeleton:

```ts
import { createServer, type IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { buildPiMailTools } from "./pi-mail-tools.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("buildPiMailTools", () => {
  it("calls the Team Room MCP endpoint with token and mapped tool name", async () => {
    const seen: Array<{ token: string | undefined; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      seen.push({ token: req.headers["x-teamroom-mcp-token"] as string | undefined, body: await readJson(req) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const tools = buildPiMailTools({ mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: "mcp-token" });
      const list = tools.find((t) => t.name === "mail_list");
      expect(list).toBeDefined();
      const result = await list!.execute("call-1", { unreadOnly: true }, new AbortController().signal, () => {}, {} as never);
      expect(result.content[0]).toMatchObject({ type: "text", text: JSON.stringify({ ok: true }) });
      expect(seen[0].token).toBe("mcp-token");
      expect(seen[0].body).toMatchObject({ method: "tools/call", params: { name: "mail.list", arguments: { unreadOnly: true } } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

Adjust the imported Pi tool type based on the actual SDK export names discovered during implementation. Keep tests focused on behavior, not exact Pi internals.

**Step 2: Run failing tests**

```bash
npm test -- src/agent-runtime/pi-mail-tools.test.ts
```

Expected: module missing.

**Step 3: Implement mail tools**

Create `src/agent-runtime/pi-mail-tools.ts`.

Use Pi extension tool shape from `docs/extensions.md` and `Type` from `typebox`:

- `mail_list` -> `mail.list`
- `mail_get` -> `mail.get`
- `mail_send` -> `mail.send`
- `mail_reply` -> `mail.reply`
- `mail_mark_read` -> `mail.mark_read`
- `mail_archive` -> `mail.archive`
- `mail_delete` -> `mail.delete`

Implement a shared function:

```ts
async function callMcp(args: { mcpUrl: string; mcpToken: string; name: string; input: unknown; signal: AbortSignal }) {
  const res = await fetch(args.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-teamroom-mcp-token": args.mcpToken,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: args.name, arguments: args.input },
    }),
    signal: args.signal,
  });
  if (!res.ok) throw new Error(`mail MCP ${args.name} failed: HTTP ${res.status}`);
  const payload = await res.json() as { result?: { content?: Array<{ type: string; text?: string }> }; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message ?? `mail MCP ${args.name} failed`);
  const text = payload.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { content: [{ type: "text", text }], details: payload };
}
```

Use exact schemas matching `src/mail-mcp/server.ts` descriptors, but Pi-safe tool names.

**Step 4: Run tests**

```bash
npm test -- src/agent-runtime/pi-mail-tools.test.ts
npm run typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add src/agent-runtime/pi-mail-tools.ts src/agent-runtime/pi-mail-tools.test.ts
git commit -m "feat(agent-runtime): add pi mail tools"
```

---

## Task 6: Implement `PiAgentWorker`

**Files:**
- Modify: `src/agent-runtime/pi-worker.ts`
- Create: `src/agent-runtime/pi-worker.test.ts`
- Modify as needed: `src/agent-runtime/README.md`

**Step 1: Write unit tests around injectable session factory**

Design `PiAgentWorker` to be testable without real Pi/model calls:

```ts
interface PiSessionLike {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}
```

Expose `createForTest()` that accepts a session factory and output sinks.

Tests:

```ts
it("prompts Pi to check mail on wake", async () => {
  const prompts: string[] = [];
  const worker = await PiAgentWorker.createForTest({
    createSession: async () => ({
      prompt: async (text) => { prompts.push(text); },
      subscribe: () => () => {},
      dispose: () => {},
    }),
    onText: () => {},
    onError: () => {},
  });
  await worker.handleWake({ type: "wake", events: ["mail.delivered"] });
  expect(prompts[0]).toMatch(/check.*mail/i);
});

it("forwards text_delta events to onText", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const text: string[] = [];
  await PiAgentWorker.createForTest({
    createSession: async () => ({
      prompt: async () => {},
      subscribe: (l) => { listener = l; return () => {}; },
      dispose: () => {},
    }),
    onText: (t) => text.push(t),
    onError: () => {},
  });
  listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  expect(text).toEqual(["hi"]);
});
```

**Step 2: Run failing tests**

```bash
npm test -- src/agent-runtime/pi-worker.test.ts
```

Expected: fail because worker is stubbed.

**Step 3: Implement worker production factory**

In `PiAgentWorker.create()`:

- require env vars:
  - `TEAMROOM_PROVIDER`
  - `TEAMROOM_MODEL`
  - `TEAMROOM_MODEL_BASE_URL`
  - `TEAMROOM_MODEL_API_TOKEN`
  - `TEAMROOM_MCP_URL`
  - `TEAMROOM_MCP_TOKEN`
- build Pi model config with `buildPiModelConfig()`
- create temporary/in-memory Pi auth/model config under `/store/pi` or use Pi's in-memory APIs if available:
  - prefer `AuthStorage.create("/store/pi/auth.json")`
  - prefer `ModelRegistry.create(authStorage, "/store/pi/models.json")` after writing models JSON
  - if Pi exposes `ModelRegistry.inMemory()` plus custom-model injection, use that instead and avoid disk
- find model via `modelRegistry.find(providerId, modelId)`
- create a `DefaultResourceLoader` or custom `ResourceLoader` that includes `/AGENTS.md` and appends Team Room instructions:

```text
You run inside Team Room as ${TEAMROOM_AGENT_NAME}.
On every wake, use mail_list({ unreadOnly: true }) first, then mail_get relevant messages.
Reply with mail_reply when responding in-thread. Use mail_send only for new threads.
Your working directory is /codebase when present. Use read/write/edit/bash for coding tasks.
```

- register mail tools via an inline Pi extension factory:

```ts
extensionFactories: [
  (pi) => {
    for (const tool of buildPiMailTools({ mcpUrl, mcpToken })) pi.registerTool(tool);
  },
]
```

- create session:

```ts
const cwd = existsSync("/codebase") ? "/codebase" : "/store";
const { session } = await createAgentSession({
  cwd,
  agentDir: "/store/pi-agent",
  model,
  authStorage,
  modelRegistry,
  resourceLoader,
  tools: parseAllowedTools(process.env.TEAMROOM_ALLOWED_TOOLS),
  sessionManager: SessionManager.inMemory(cwd),
});
```

Map allowed tools:

- if unset/empty for Pi, default to `["read", "write", "edit", "bash"]`
- normalize legacy Claude-style names (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`) to Pi lowercase equivalents where supported (`read`, `write`, `edit`, `bash`, `grep`, `find`/`ls` if needed)

Subscribe to text deltas and write to stderr as `[pi] ${delta}` or line-buffer if deltas are too granular. Do not emit secrets.

`handleWake()` should call:

```ts
await this.session.prompt(WAKE_PROMPT);
```

Catch errors and send them to `onError` without crashing the stdin loop.

**Step 4: Update README**

In `src/agent-runtime/README.md`, update:

- worker list now includes `PiAgentWorker`
- runtime selection is by `TEAMROOM_RUNTIME` with provider fallback
- Pi uses Team Room proxy and native Pi mail tools

**Step 5: Run tests**

```bash
npm test -- src/agent-runtime/pi-worker.test.ts src/agent-runtime/worker.test.ts
npm run typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add src/agent-runtime/pi-worker.ts src/agent-runtime/pi-worker.test.ts src/agent-runtime/README.md
git commit -m "feat(agent-runtime): add pi agent worker"
```

---

## Task 7: Add `pi-coder` agent folder and docs

**Files:**
- Create: `agents/pi-coder/agent.yaml`
- Create: `agents/pi-coder/AGENTS.md`
- Create: `agents/pi-coder/Dockerfile`
- Create: `agents/pi-coder/store/.gitkeep`
- Modify: `agents/README.md`
- Modify: `README.md`
- Modify if stale: `docs/runbooks/smoke-test.md`

**Step 1: Create agent files**

`agents/pi-coder/agent.yaml`:

```yaml
name: pi-coder
runtime: pi
provider: openai
model: openai/gpt-5.5
image_tag: teamroom-agent-pi-coder:latest
subscriptions: []
allowed_tools:
  - read
  - write
  - edit
  - bash
```

`agents/pi-coder/AGENTS.md`:

```md
# pi-coder

You are pi-coder, a general coding teammate in Team Room.

On every wake:
1. Check unread mail first.
2. Read relevant messages before acting.
3. Reply in-thread when responding to a request.
4. Use the mounted `/codebase` for code-reading and code-editing tasks.
5. Keep replies concise and include what you changed or verified.

Prefer small, reversible changes. Do not touch secrets. If a task needs broader design agreement, say so in mail instead of guessing.
```

`agents/pi-coder/Dockerfile` can match the studio image initially:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
```

If Pi's bash tool requires common Unix utilities missing from Alpine, add only the observed required packages after a failing acceptance run. Do not preinstall speculative tools in this task.

**Step 2: Update docs**

- `agents/README.md`: add `pi-coder` row with runtime Pi and notes.
- `README.md`: update current state from M4.5 to M5 + Pi worktree context if necessary; include Pi image build command.
- `docs/runbooks/smoke-test.md`: do not claim Pi is part of the smoke test unless the script is updated.

**Step 3: Run config test and typecheck**

```bash
npm test -- src/agent-config/agent-config.test.ts
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add agents/pi-coder agents/README.md README.md docs/runbooks/smoke-test.md
git commit -m "feat(agents): add pi-coder"
```

---

## Task 8: Add focused integration coverage for Pi config path

**Files:**
- Modify: `src/daemon/daemon.test.ts` or `src/agent-spec/build-spec.test.ts` only if enough coverage already exists
- Optional create: `tests/integration/pi-agent-config.test.ts`

**Step 1: Decide minimal useful coverage**

Do not write a live Pi/model integration test. It would be slow and credential-dependent. Instead, cover the host/container contract:

- daemon agent discovery accepts `agents/pi-coder/agent.yaml`
- build spec for `pi-coder` uses `TEAMROOM_RUNTIME=pi`
- token registry entry uses `provider=anthropic`, not `provider=pi`

If Task 2 already has this coverage, add only a test that loads the real `agents/pi-coder` folder.

**Step 2: Write test**

Example:

```ts
it("loads the real pi-coder agent config", () => {
  const cfg = loadAgentConfig(resolve("agents/pi-coder"));
  expect(cfg).toMatchObject({
    name: "pi-coder",
    runtime: "pi",
    provider: "anthropic",
    model: "claude-opus-4-7",
  });
});
```

Place this where real-agent config tests already live, or add it to `agent-config.test.ts` with repo-root path resolution.

**Step 3: Run tests**

```bash
npm test -- src/agent-config/agent-config.test.ts src/agent-spec/build-spec.test.ts
npm run typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/agent-config/agent-config.test.ts src/agent-spec/build-spec.test.ts tests/integration/pi-agent-config.test.ts
git commit -m "test: cover pi-coder container contract"
```

Only add files that actually changed.

---

## Task 9: Build, install CLI, and run manual acceptance

**Files:**
- No source edits expected unless acceptance reveals a bug.

**Step 1: Build**

Use Node 22, not Node 26:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22.16.0
npm run build
```

Expected: TypeScript build succeeds and `dist/agent-runtime/pi-worker.js` exists.

**Step 2: Point local CLI at this worktree**

```bash
npm run install-cli -- ~/.local/bin --force
which teamroom
ls -l ~/.local/bin/teamroom
```

Expected symlink target is this worktree's `dist/cli/main.js`.

**Step 3: Build Pi image**

```bash
docker build -t teamroom-agent-pi-coder:latest -f agents/pi-coder/Dockerfile .
```

Expected: image builds.

**Step 4: Start daemon**

```bash
rm -rf data
teamroom serve
```

Keep it running in terminal A.

**Step 5: Send a basic mail request**

In terminal B:

```bash
teamroom send pi-coder "Please read README.md and reply with a one-sentence summary."
```

Poll:

```bash
teamroom inbox pi-coder
```

Expected: a reply from `agent:pi-coder` or outbound channel mail visible through the CLI flow. If no reply, inspect daemon log and container logs before changing code.

**Step 6: Chat acceptance**

```bash
teamroom chat pi-coder
```

Ask:

```text
What files would you inspect before changing the agent runtime?
```

Expected: coherent reply that mentions relevant files.

**Step 7: Controlled edit acceptance**

Ask `pi-coder` to make a tiny reversible edit, for example add a temporary line to a scratch file under `/store` first. Only ask it to edit repo docs after confirming tool behavior.

Expected: edit appears on host if `/codebase` edit is requested.

**Step 8: Verify proxy routing**

In another terminal:

```bash
LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
grep '"agentId":"pi-coder"' "$LOG" | grep '"model.call.completed"' | tail -5
```

Expected: model spans exist for `pi-coder` with provider `openai` (or configured provider). No direct upstream credential appears in `docker inspect` env output.

**Step 9: Commit fixes if needed**

If acceptance reveals a bug, use systematic debugging before changing code. Make the smallest fix, add/adjust tests, rerun focused tests, and commit.

---

## Task 10: Final verification and handoff

**Files:**
- Modify docs only if final behavior differs from the plan.

**Step 1: Run full verification**

```bash
npm run typecheck
npm test
```

If the known LM Studio real test fails due to cold/missing local model, record the exact failure. Do not call the suite clean unless it passes.

**Step 2: Inspect git state**

```bash
git status --short
git log --oneline --decorate -10
```

Expected: only intentional changes committed; working tree clean or only expected local `.env`/ignored files.

**Step 3: Update plan/design if implementation diverged**

If implementation changed the design materially (for example Pi required a different model-registry API), update `docs/plans/2026-05-16-pi-agent-design.md` with a short "Implementation note" before final handoff.

**Step 4: Commit docs if changed**

```bash
git add docs/plans/2026-05-16-pi-agent-design.md docs/plans/2026-05-16-pi-agent-implementation.md
git commit -m "docs(plan): update pi agent implementation notes"
```

Only commit if files changed.

**Step 5: Handoff summary**

Report:

- commits created
- tests run and results
- manual acceptance result
- how to run `pi-coder`
- known limitations / follow-ups
