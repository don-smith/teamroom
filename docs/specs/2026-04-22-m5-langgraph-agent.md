# M5 — LangGraph Agent — Design

*Spec date: 2026-04-22. Milestone: one LangGraph-backed agent (`studio-assistant`) running Gemma 4 locally via LM Studio (works against Ollama too), participating in the existing mail substrate via MCP tools, establishing a reusable runtime branch for any OpenAI-compatible backend.*

## 1. Overall shape

M5 ships **one** thing: a new Node/TypeScript agent runtime branch built on LangGraph.js's prebuilt `createReactAgent` + `@langchain/mcp-adapters`, shared by any agent whose provider is `lm-studio` or `ollama`. The existing `studio-assistant` is migrated onto it (`qwen3.5-9b` → `google/gemma-4-e4b`, adds MCP mail access, AGENTS.md rewritten). The current no-MCP OpenAI-compat path in `src/agent-runtime/` is retired — it was placeholder scaffolding explicitly waiting for this milestone.

**Proxy / routing is identical to the Claude path today.** Containers receive `TEAMROOM_MODEL_BASE_URL` + `TEAMROOM_MODEL_API_TOKEN` + `TEAMROOM_MCP_URL` + `TEAMROOM_MCP_TOKEN` injected at spawn; the daemon mints per-turn routing tokens with a provider name; the proxy picks an adapter by provider. The LangGraph worker inside the container uses its own `ChatOpenAI` pointed at the proxy URL with the injected token — functionally the same shape as how claude-agent-sdk sets `ANTHROPIC_BASE_URL` on the Claude path.

**State model:** stateless across container restarts; within a container, a bounded `messages: BaseMessage[]` array preserves context across wakes (blunt-force trim to the last 40 per wake). Library defaults for retries (`ChatOpenAI.maxRetries: 2`). `recursionLimit: 10` to prevent runaway ReAct loops. No checkpointer, no sub-agents, no cross-turn memory — all that belongs to M6 and beyond.

## 2. Scope

**In scope:**

- Second agent runtime branch using LangGraph.js's prebuilt ReAct agent + MCP adapter library.
- Refactor `src/agent-runtime/` from a single-`processWake` / `LlmClient` shape to an `AgentWorker` interface with two implementations (`anthropic-worker`, `langgraph-worker`). Retire `runtime.ts` + `session-store.ts` + the obsolete `lm-studio` branch of `main.ts`.
- New `ollama` provider end-to-end: `Provider` union, daemon adapter registry wiring, `.env.example` entry, agent-config validator.
- Consolidate the LM Studio adapter and the new Ollama adapter into a single `OpenAICompatAdapter` parameterized by auth mode (`bearer` | `none`). Rename `lm-studio-adapter.{ts,test.ts}` → `openai-compat-adapter.{ts,test.ts}`.
- Migrate `studio-assistant` in place: model update, AGENTS.md rewritten for the MCP-mail pattern, stale yaml comment removed.
- Within-container context persistence via a bounded in-process `messages: BaseMessage[]` array (cap 40). Cleared on container restart.
- Delete the orphan `agents/assistant/` folder (only a `store/` subdir; superseded by named agent examples).

**Explicitly out of scope:**

- Cross-container memory / LangGraph checkpointers (M6).
- Codex / hosted-OpenAI agents (future milestone; lands as another `OpenAICompatAdapter` config when it arrives).
- Generic `openai-compat` fallback provider (defers until a third concrete backend forces the shape).
- Sub-agents or hierarchical graphs.
- Automated live-model end-to-end test (replaced by manual acceptance scenarios; evals is the long-term answer to agent quality).
- Per-wake `AbortSignal` wall-clock cap (defers until a runaway is observed).
- Python-LangGraph agent family (clean composition point for a later milestone).
- Pre-acceptance spike on Gemma tool-calling reliability (swap models if it misbehaves during acceptance; user has Qwen and others loaded locally as fallback).

## 3. Runtime code layout — `src/agent-runtime/`

The current runtime has one shared `processWake` taking an `LlmClient`. That shape fits the Claude path (where the Anthropic SDK internally loops tool-calls, so "one LLM call" equals a turn) but not the LangGraph path (where we own the messages array, and the tool-loop is the graph invocation). Introducing a narrower abstraction is cleaner than stretching `LlmClient`.

### New interface

```ts
interface AgentWorker {
  handleWake(wake: WakeEnvelope): Promise<void>;
}
```

Each provider implements it with its own state model.

### File map

| File | Status | Role |
|---|---|---|
| `main.ts` | Updated | Picks a worker at boot via `buildWorker()`; drives the stdin wake-loop as today. |
| `worker.ts` | **New** | `AgentWorker` interface + `buildWorker(): Promise<AgentWorker>` factory keyed on `TEAMROOM_PROVIDER`. |
| `anthropic-worker.ts` | **New** | Wraps existing `AnthropicLlmClient`. Absorbs the current `processWake` body (read AGENTS.md, call `createMessage` with `WAKE_PROMPT`, pipe text → stderr). |
| `langgraph-worker.ts` | **New** | Opens MCP client (`@langchain/mcp-adapters`) at construction; builds `ChatOpenAI` pointed at proxy; compiles `createReactAgent({ llm, tools, systemPrompt })`; holds bounded `messages: BaseMessage[]`; per-wake append → invoke → trim → stderr log. |
| `anthropic-llm-client.ts` | Unchanged | Still the Anthropic SDK shim. |
| `runtime.ts` | **Retired** | Its `processWake` body moves into `anthropic-worker.ts`; the `LlmClient` abstraction retires with it. |
| `session-store.ts` | **Retired** | Orphan from the M1 runtime; no live importers post-refactor. |

### Worker routing in `buildWorker()`

- `provider === "anthropic"` → `AnthropicAgentWorker`.
- `provider === "lm-studio"` OR `provider === "ollama"` → `LangGraphAgentWorker`. Same worker; provider name is used by the daemon for token-minting / proxy routing, not by the worker for behavior.
- Any other value → throw at boot with a clear error.

### Async construction

The LangGraph worker's construction is async (MCP handshake + tool discovery + graph compilation). `buildWorker()` returns `Promise<AgentWorker>`; `main()` awaits it before entering the wake loop. First wake cannot arrive until construction completes — already true for the Anthropic path's session resume on first turn.

### Context persistence (blunt-force)

`LangGraphAgentWorker` holds `private messages: BaseMessage[] = []`. Per wake:

1. Append a `HumanMessage(WAKE_PROMPT)` to `messages`.
2. Invoke `agent.invoke({ messages }, { recursionLimit: 10 })`.
3. Replace `messages` with the returned graph state's messages.
4. Trim: if `messages.length > 40`, `messages = messages.slice(-40)`.
5. Log the final AI message text to stderr (diagnostic only; matches the existing Anthropic path's `[llm] <text>` convention).

When the container is torn down (idle timeout, daemon restart), `messages` dies with the process — exactly the "reset on container restart" behavior chosen.

## 4. Daemon-side changes — proxy + provider plumbing

Small and well-bounded. The existing token-minting / env-injection / container-spawn flow carries a new provider name through.

| File | Change |
|---|---|
| `src/types.ts` | `Provider` union gains `"ollama"`. Existing values (`"anthropic"`, `"lm-studio"`) unchanged. |
| `src/model-proxy/adapters/openai-compat-adapter.ts` | **Renamed from `lm-studio-adapter.ts`.** One class `OpenAICompatAdapter` with constructor opt `auth: { mode: "bearer"; key: string } \| { mode: "none" }`. Shared `extractUsage` (OpenAI-compat `prompt_tokens` / `completion_tokens` shape). `upstreamUrl()` returns configured URL. ~40 lines. |
| `src/model-proxy/adapters/openai-compat-adapter.test.ts` | **Renamed** from `lm-studio-adapter.test.ts`. Covers both auth modes + `extractUsage` + `upstreamUrl()`. |
| `src/model-proxy/adapters/anthropic-adapter.ts` | Unchanged. Stays a separate class — OAuth modes, `anthropic-beta` header merging, and Anthropic usage shape (`input_tokens` / `output_tokens`) are not meaningfully shareable with the OpenAI-compat family. |
| `composeModelProxy` (in `src/modules/model-proxy/`) | Constructs two `OpenAICompatAdapter` instances: `lm-studio` (bearer, `LM_STUDIO_API_TOKEN`, `LM_STUDIO_BASE_URL`) and `ollama` (none, `OLLAMA_BASE_URL`). |
| `src/agent-config/agent-config.ts` | Validator accepts `"ollama"` as a valid provider string. |
| `.env.example` | New entry: `OLLAMA_BASE_URL=http://host.docker.internal:11434` (commented default). |
| `src/session-manager/` | No change. Token-minting + env-injection are already provider-agnostic — they carry the provider name through unchanged. |

**What doesn't change:** daemon composition layout (the 13-section `startDaemon` composer), mail-MCP wiring, channels, dispatcher, mailing lists, the Anthropic adapter end-to-end, the mail substrate, the CLI.

**Codex / hosted-OpenAI future:** a future Codex or hosted-OpenAI agent is a third `OpenAICompatAdapter` config — `bearer` auth, `OPENAI_API_KEY`, `https://api.openai.com`. One more construction call; no new file.

## 5. Agent config — `studio-assistant`

### `agents/studio-assistant/agent.yaml`

**Before:**
```yaml
name: studio-assistant
model: qwen/qwen3.5-9b
image_tag: teamroom-agent-studio-assistant:latest
provider: lm-studio
# studio-assistant does not participate in M4 mail (no MCP; deferred to M5).
# See docs/m4-followups.md §1.
subscriptions: []
```

**After:**
```yaml
name: studio-assistant
model: google/gemma-4-e4b
image_tag: teamroom-agent-studio-assistant:latest
provider: lm-studio
subscriptions: []
```

Changes: model swap, delete the "deferred to M5" comment (M5 is now). Keep `provider: lm-studio` — the same value now routes to the LangGraph worker at the runtime level, and to the same adapter at the proxy level. No `allowed_tools` field: that field is Anthropic-only (controls claude-agent-sdk's tool allowlist); for LangGraph agents, tool access is MCP-tool-only and injected by the runtime.

### `agents/studio-assistant/AGENTS.md`

Full rewrite. The current file describes the obsolete M3 stdout-envelope pattern (`{"type":"reply","body":...}`), three architectural generations out of date. New content modeled on `claude-assistant/AGENTS.md`, kept terse per "basic system prompt" guidance:

- Identity paragraph ("You are `studio-assistant`…").
- Communication: how to use mail MCP tools on wake (list unread → get → reply/send/mark_read/archive/delete).
- Address scheme (`agent:`, `channel:`, `list:`) — copied from the M4.5 as-built.
- Team roster (self, `claude-assistant`, `claude-researcher`, `channel:cli:*`).
- Thread cap (40 post-M4.5) + housekeeping nudge.

Exact MCP tool-name strings land at plan-time once we verify what `@langchain/mcp-adapters` exposes (convention differs from claude-agent-sdk's `mcp__<server>__<tool>`). The AGENTS.md structure is the design decision; exact tokens are a wiring detail.

### `agents/studio-assistant/Dockerfile`

Structurally unchanged:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js
ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
```

No Claude Code CLI install (LangGraph.js doesn't need one). The new LangGraph dependencies flow in via the root `package.json` + `npm ci --omit=dev` — same pattern claude-assistant uses to pull in `@anthropic-ai/claude-agent-sdk`.

### Root `package.json` deps (new, all production)

- `@langchain/langgraph` — `createReactAgent` + graph primitives.
- `@langchain/core` — `BaseMessage`, `HumanMessage`, `AIMessage` + base abstractions.
- `@langchain/openai` — `ChatOpenAI` pointed at the daemon proxy with `baseURL: TEAMROOM_MODEL_BASE_URL`.
- `@langchain/mcp-adapters` — MCP → LangChain tool bridge.

### Delete `agents/assistant/`

Orphan from the M1/M2 era (contains only an empty `store/` subdir; no `agent.yaml`). Superseded by the three named agent examples.

## 6. Testing strategy

House rules: DI at every effectful boundary (`feedback_teamroom_testability_and_di`), real in-memory impls over mocks, no skipped tests (`feedback_teamroom_no_skipped_tests`), no failing tests (`feedback_teamroom_no_failing_tests`).

| Layer | File | Coverage |
|---|---|---|
| Adapter unit | `src/model-proxy/adapters/openai-compat-adapter.test.ts` (renamed) | Both auth modes: `bearer` sets `Authorization: Bearer …` + strips `x-api-key`; `none` strips both. Shared `extractUsage` on OpenAI-compat response shape. `upstreamUrl()` returns configured URL. |
| Worker unit (Anthropic) | `src/agent-runtime/anthropic-worker.test.ts` (refactored from `runtime.test.ts`) | Existing coverage ported: `handleWake` reads AGENTS.md, calls `AnthropicLlmClient`, logs text to stderr, graceful on missing AGENTS.md. No behavioral change. |
| Worker unit (LangGraph) | `src/agent-runtime/langgraph-worker.test.ts` (new) | **Fake `ChatModel`** scripts canned tool-calls / final answers; **real** in-process MCP server wired to a real `MailDispatcher` (same `composeIntegrationHarness`-style wiring). Verifies: MCP tools discovered at init; per-wake appends `HumanMessage`, invokes graph, trim-to-40 happens; 41+ message history keeps only the last 40; graph exceptions are logged but don't crash the wake loop. |
| Adapter integration | Existing daemon-composition tests | Gain an assertion that the proxy's adapter registry has `ollama` wired. |

**No automated live-model E2E this milestone.** Agent quality is an evals concern (future milestone). Manual acceptance covers the "the harness can be driven" proof.

## 7. Acceptance criteria

### Automated

- `npm test` passes (full suite; no skips).
- `tsc --noEmit` clean.
- New `langgraph-worker.test.ts` present and passing.
- Renamed `openai-compat-adapter.test.ts` covers both auth modes.
- Daemon composition wires `ollama` adapter.

### Manual scenarios (run at milestone close; documented in the as-built)

1. **Claude ↔ Studio mail round-trip.** `claude-assistant` mails `studio-assistant`; studio-assistant's LangGraph ReAct loop reads inbox via MCP `mail.list`/`mail.get`, composes a reply via `mail.reply`, reply lands in claude-assistant's inbox. Run in both directions.
2. **CLI ↔ Studio.** `teamroom chat agent:studio-assistant`, human sends a message, studio-assistant replies; reply surfaces in the chat REPL.
3. **Context cap.** After 20+ wakes against studio-assistant, daemon log (or debug inspection) confirms the in-process messages array stays at 40.
4. **Ollama smoke.** Stop LM Studio; start Ollama locally; update `agents/studio-assistant/agent.yaml` model to an Ollama tag (e.g. `gemma2:latest`) and provider to `ollama`; restart daemon; re-run scenario 1. Reply lands end-to-end through the Ollama-backed model proxy.

### Cleanup at close

- `src/agent-runtime/runtime.ts` + `session-store.ts` deleted.
- Old `lm-studio` branch in `main.ts` removed.
- `agents/assistant/` folder deleted.
- `docs/roadmap.md` updated: M5 status → Shipped; backlog refreshed.

## 8. New backlog items surfaced

Roll to `docs/roadmap.md#backlog` at milestone close:

- **Automated LangGraph live E2E test** — thin "harness can be driven" proof against a real local model. Trigger: next milestone if evals don't yet cover this surface.
- **LangGraph per-wake `AbortSignal` cap** — wall-clock ceiling on a single graph invocation. Trigger: first observed runaway.
- **Generic `openai-compat` provider** — for arbitrary OpenAI-compat endpoints beyond LM Studio / Ollama (Codex, hosted OpenAI, vLLM, etc.). Trigger: third concrete backend.
- **Shared cross-worker tests** — once both `anthropic-worker` and `langgraph-worker` are shipped, look for cross-worker contract tests (wake-loop behavior, AGENTS.md loading, error-continues-wake-loop). Trigger: worker #3, or a drift bug between them.
- **`LM_STUDIO_API_TOKEN` optionality** — after M5 it's only required when LM Studio is token-protected. Consider relaxing validation. Trigger: onboarding friction.

## 9. Related

- Roadmap: [`docs/roadmap.md`](../roadmap.md) — M5 entry.
- Predecessor as-builts:
  - [M4.5 AI-native harness](../as-built/2026-04-22-teamroom-m4.5.md) — modules refactor, channel architecture, MCP SDK retrofit this milestone builds on.
  - [M4 agent mail](../as-built/2026-04-21-teamroom-m4.md) — mail substrate this agent participates in.
- Memory entries load-bearing on this design:
  - [`project_teamroom_langgraph_direction.md`](../memory/project_teamroom_langgraph_direction.md) — LangGraph as the intended per-agent runtime; this milestone cashes it in.
  - [`feedback_teamroom_protocol_sdk_default.md`](../memory/feedback_teamroom_protocol_sdk_default.md) — why we use prebuilt `createReactAgent` + `@langchain/mcp-adapters` rather than hand-rolling.
  - [`feedback_teamroom_see_only_as_far_as_needed.md`](../memory/feedback_teamroom_see_only_as_far_as_needed.md) — why the OpenAI-compat adapter consolidation happens now (Ollama is the second example) but the generic provider defers.
  - [`feedback_teamroom_testability_and_di.md`](../memory/feedback_teamroom_testability_and_di.md) — DI-and-real-impls approach for the new tests.
  - [`feedback_teamroom_minimize_process_deps.md`](../memory/feedback_teamroom_minimize_process_deps.md) — why the LangGraph runtime is in-container (no new long-running process).
