# Team Room M2 — Model Abstraction Layer

*Date: 2026-04-18. Active spec for the M2 milestone. Purged into the M2 as-built at milestone close.*

> Predecessor context: [`team-room-context.md`](../../team-room-context.md) (vision, milestone roadmap, M2 framing as "Multi-model credential proxy" — renamed during M1 to "Model abstraction layer"); [M1 as-built](../as-built/2026-04-18-teamroom-m1.md) (architecture being extended); [`tabled.md`](../tabled.md) (future items intentionally deferred from M2).

---

## 1. Goal and exit criteria

**Goal.** Introduce the seam where containers talk *through* the daemon to model providers, with credentials never reaching the container, and per-agent provider/model declared in `agent.yaml`. Establish the patterns (credential isolation, span-shaped end-to-end telemetry, agent identity at the proxy boundary, two-mode auth) that later milestones extend rather than rewrite.

**Exit criteria.**

1. Two agents run concurrently against two different backends end-to-end:
   - Existing `assistant` agent against local LM Studio (M1 path, now via the proxy).
   - New `claude-assistant` agent against the real Anthropic API using either the user's Claude Code subscription (OAuth) or an API key.
2. Real upstream credentials never appear in the container's environment, stdin, or `docker inspect` output. The proxy is the only process that holds them.
3. End-to-end smoke test passes against real Anthropic + real LM Studio (the milestone-completion gate). Includes both agents.
4. Full unit + integration suite passes (existing M1 tests still green; new tests cover the proxy, the new LLM client, and the absorbed M1 debts).
5. Span-shaped log records (`turn.started`, `model.call.completed`, `turn.completed`, etc.) carry a shared `traceId` and reconstruct each turn from JSONL files alone.
6. M1 debts absorbed (see §9): reconciler `pending`-blind-spot fix, daemon shutdown polish, `parseEvent` ordering, agent-onboarding runbook skeleton.

**Out of scope.** Per-turn / per-conversation model selection; model allowlists with explicit enforcement; OAuth scopes; rate-limit handling; bus events for telemetry; streaming responses; provider-body validation; multi-model-per-agent. All tabled in [`docs/tabled.md`](../tabled.md) — see §10 here for the index.

---

## 2. Architecture

Process topology unchanged from M1 except the daemon now owns one extra in-process listener — a localhost HTTP server. No new long-running process. SQLite stays embedded. Bus stays file-backed. Containers stay per-turn ephemeral.

```
┌─────────────────────────────────────────────────────────────┐
│ Daemon (host process — sole long-running process)           │
│                                                             │
│  Orchestrator ── processTurn ── Container spawn ──┐         │
│       │              │                            │         │
│       ▼              ▼                            │         │
│   SQLite        ModelProxy (in-process listener)  │         │
│                  127.0.0.1:PORT                   │         │
│                  ▲                                │         │
│                  │ HTTP/1.1                       │         │
│                  │ X-Teamroom-Token: <ephemeral>  │         │
│                  │ x-api-key OR Authorization     │         │
│                  │                                │         │
│  ┌───────────────┼────────────────────────────────┘         │
│  │  Container (per-turn, opaque)                            │
│  │    agent-runtime → LlmClient → openai|anthropic SDK      │
│  │      SDK targets http://host.docker.internal:PORT        │
│  └─────────────────────────────────────────────────────────┐│
│                                                            ││
│  Proxy → reads X-Teamroom-Token → registry lookup          ││
│       → resolves agent + provider + real upstream creds    ││
│       → swaps auth header(s) for the real credential       ││
│       → forwards to api.anthropic.com OR LM Studio         ││
│       → emits span-shaped log when upstream completes      ││
└─────────────────────────────────────────────────────────────┘
```

**Key seams (interfaces preserved or added).**

| Seam | Layer | Status | Purpose |
|---|---|---|---|
| `LlmClient` | container | existing (M1) | Unifies `chat(messages, system) → reply` across SDKs. Gains `AnthropicLlmClient` impl. |
| `ModelProxy` | host (daemon) | new | `start`/`stop`, `mintToken`, `evictToken`. One prod impl (`LocalModelProxy`); tests use real http on ephemeral ports. |
| `ProviderAdapter` | host (model-proxy module) | new | One per backend. Knows upstream URL, auth-header shape, response token-extraction pattern. Does **not** translate request/response bodies. |

**What does NOT change from M1.**

- Container contract: stdin JSONL envelope, stdout JSONL events, writable `/store`, `/AGENTS.md` mount. Only the value of `TEAMROOM_MODEL_BASE_URL` changes (now points at the proxy), plus new env vars are added (see §3.2).
- `NotifyBus`: proxy does not publish bus events in M2 (deferred per Q6 — avoid preempting M3's bus rewrite).
- Daemon's procedural orchestrator pattern; intelligence still lives in containers.

**One contract change.** The `/AGENTS.md` mount becomes **read-write** (M1 had it read-only). Self-improvement loops (M7) need this; M2 absorbs the change because there's no reason to wait.

---

## 3. Components

### 3.1 New module: `src/model-proxy/`

```
src/model-proxy/
├── README.md                       # one-paragraph contract + boundary statement
├── model-proxy.ts                  # ModelProxy interface
├── local-model-proxy.ts            # in-process http server impl
├── token-registry.ts               # in-memory routing token → entry map
├── adapters/
│   ├── adapter.ts                  # ProviderAdapter interface
│   ├── anthropic-adapter.ts        # /v1/messages → api.anthropic.com (two auth modes)
│   └── lm-studio-adapter.ts        # /v1/chat/completions → LM Studio
├── span.ts                         # span-shaped log record builder + ID helpers
└── *.test.ts                       # co-located unit tests
```

**`ModelProxy` interface (sketch).**

```ts
interface MintTokenInput {
  turnId: string;
  agentId: string;
  traceId: string;
  provider: "anthropic" | "lm-studio";
  model: string;
}

interface ModelProxy {
  start(): Promise<{ port: number }>;     // listens on 127.0.0.1, OS-assigned port
  stop(): Promise<void>;
  mintToken(input: MintTokenInput): string;
  evictToken(token: string): void;        // called from processTurn `finally`
}
```

**`ProviderAdapter` interface (sketch).**

```ts
interface ProviderAdapter {
  readonly id: "anthropic" | "lm-studio";
  upstreamUrl(): string;
  injectAuth(headers: OutgoingHttpHeaders, mode: AuthMode): void;
  extractUsage(responseBody: unknown): {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

**Routing rule.** Proxy reads `X-Teamroom-Token` header (always present, injected by daemon into container env, added by container's HTTP client on every outbound call). Looks up the registry entry → gets `provider` → hands off to the adapter. The auth header (`Authorization` or `x-api-key`) is handled separately by the adapter — see §6 for the two modes.

### 3.2 Updates to `src/daemon/`

- **Composition root.** Constructs `LocalModelProxy`, calls `start()`, stores assigned port.
- **`turn-processor.ts`.** New ordering:
  1. `markRunning(turnId, placeholderContainerId)` ← *moved before* `runner.run()` (debt #1).
  2. `mintToken({turnId, agentId, traceId, provider: agent.provider, model: agent.model})`.
  3. `runner.run({ env: { ..., TEAMROOM_MODEL_BASE_URL, TEAMROOM_PROXY_ROUTING_TOKEN, TEAMROOM_PROVIDER, TEAMROOM_MODEL, TEAMROOM_TURN_ID, TEAMROOM_TRACE_ID, TEAMROOM_AGENT_ID }, ... })`.
  4. In a `finally` block: `evictToken(token)` regardless of success/error.
  5. Replace placeholder container_id with the real one once known (`turnRepo.attachContainer`).
- **`reconcile.ts`.** Adds aged-`pending` reclamation: rows with `status='pending'`, no `container_id`, older than threshold → mark errored with `'daemon_restart_during_pending'`.
- **`safety-nets.ts` and shutdown** (debt #2): static `import * as fs from "node:fs"` instead of dynamic import; on clean stop, unlink PID file; `let stopped = false` guard around `db.close()`.
- **`docker-runner.ts` `parseEvent`** (debt #3): swap spread order so the typed `type` field always wins over malformed JSON payload.

### 3.3 Updates to `src/agent-runtime/`

- **`main.ts`.** Reads `TEAMROOM_PROVIDER` env var. Factory picks the right `LlmClient` impl. Adds `X-Teamroom-Token` header (from `TEAMROOM_PROXY_ROUTING_TOKEN`) to every HTTP call regardless of SDK.
- **`anthropic-llm-client.ts`** *(new)*. Uses `@anthropic-ai/sdk`, configured with `baseURL = TEAMROOM_MODEL_BASE_URL`. In API-key mode the SDK's `apiKey` ctor option carries the ephemeral token (sent as `x-api-key`); in OAuth mode the client first does the manual token-exchange dance (~30 LOC), caches the temp API key Anthropic returns, then sends `/v1/messages` calls with that temp key. Both modes always include the `X-Teamroom-Token` routing header.
- **`runtime.ts`.** Unchanged contract (`LlmClient` already abstracts the call).
- Co-located `anthropic-llm-client.test.ts` — uses real local http test server stand-in (matching M1 pattern: real impls, no mocks).

### 3.4 New agent: `agents/claude-assistant/`

```
agents/claude-assistant/
├── agent.yaml          # name, provider: anthropic, model: claude-..., image_tag
├── AGENTS.md           # mounted writable as /AGENTS.md
├── Dockerfile          # node:20-alpine + dist/agent-runtime + @anthropic-ai/sdk
└── store/
    └── .gitkeep
```

`agent.yaml` schema gains a required `provider: anthropic | lm-studio` field. Existing `assistant/agent.yaml` updated to declare `provider: lm-studio` explicitly.

Exact agent name TBD at implementation time (`claude-assistant` is a placeholder; could be e.g. `claude` or `anthropic-assistant`).

### 3.5 `.env` and credential discovery

`.env.example` updated with the new keys:

```
LM_STUDIO_API_TOKEN=...        # existing
ANTHROPIC_API_KEY=...          # optional; presence selects API-key mode
CLAUDE_CODE_OAUTH_TOKEN=...    # optional; selects OAuth mode (subscription)
```

**Credential discovery order (proxy startup):**

1. If `ANTHROPIC_API_KEY` is set in `.env` → API-key mode wins.
2. Else if `CLAUDE_CODE_OAUTH_TOKEN` is set in `.env` → OAuth mode.
3. Else read `~/.claude/.credentials.json` (where Claude Code stores its OAuth token after login) → OAuth mode if found.
4. Else: fail at startup with a clear error if any agent's `agent.yaml` declares `provider: anthropic`. Other agents still function.

Documented in `docs/runbooks/anthropic-auth.md` (new).

### 3.6 New runbook: agent onboarding skeleton

`docs/runbooks/agent-onboarding.md` — a deliberately-short skeleton documenting only what M2 actually demonstrates: create `agents/<name>/` folder, write `agent.yaml`, write `AGENTS.md`, write `Dockerfile`, register agent in DB, build image, send first message, verify in logs. Top-of-file note: "this skeleton is a starting point. Real specialized-agent onboarding will involve flowcharts, skill assignments, tool inventories, and metadata that M2 does not yet model. The expectation is that an agent role is observed-in-use before it is formally onboarded; the skeleton supports the manual path that exists today."

### 3.7 Tooling

`package.json`: bump `@types/node` and `engines.node` to `>=22` *if* a quick `npm ls` confirms no transitive dep requires `<22`. Otherwise leave at `^20` to match runtime (debt #4 — implementation-time decision).

---

## 4. Data flow (one turn, end-to-end)

Tracing a single inbound message destined for the new `claude-assistant` (Anthropic) agent. Same flow applies to `assistant`/LM Studio with provider-specific bits swapped.

```
t0  CLI         teamroom send --agent claude-assistant "hello"
                → MessageRepo.insertInbound(...) → SQLite row (direction='in')

t1  Daemon      Orchestrator polls pending → finds the row
                AgentConfigLoader.load("claude-assistant")
                  → returns { name, provider:"anthropic", model, imageTag }

t2  Daemon      processTurn(message, agent):
                  traceId  = newTraceId()
                  turnId   = TurnRepo.insertPending(message)
                  TurnRepo.markRunning(turnId, "pending-id")  ← debt #1 fix
                  token    = modelProxy.mintToken({turnId, agentId, traceId,
                                                   provider:"anthropic", model})
                  // Token registry now has:
                  //   token → {agentId, provider, model, traceId, turnId}
                  // Real upstream credentials are NOT in the registry value —
                  // they live in the proxy's adapter, resolved per-call.
                  logger.info({event:"turn.started", traceId, ...})

t3  Daemon      DockerRunner.run({
                  image: "teamroom-agent-claude-assistant:latest",
                  env: {
                    TEAMROOM_TURN_ID, TEAMROOM_TRACE_ID, TEAMROOM_AGENT_ID,
                    TEAMROOM_PROVIDER:"anthropic",
                    TEAMROOM_MODEL,
                    TEAMROOM_MODEL_BASE_URL: "http://host.docker.internal:" + port,
                    TEAMROOM_PROXY_ROUTING_TOKEN: token,
                  },
                  mounts: [/AGENTS.md (rw), /store (rw)],
                  stdin: JSON.stringify({inbound, turnId, agentId})
                })
                → spawns container; replaces "pending-id" with real container_id

t4  Container   agent-runtime/main.ts:
                  inbound = JSON.parse(await readStdin())
                  history = loadConversation("/store/conversation.jsonl")
                  agentsMd = readFileSync("/AGENTS.md")
                  llm = env.TEAMROOM_PROVIDER === "anthropic"
                    ? new AnthropicLlmClient({...})
                    : new OpenAILlmClient({...})
                  reply = await runTurn({llm, history, agentsMd, inbound})

t5a OAuth-only: AnthropicLlmClient first does the OAuth exchange dance:
                  POST /api/oauth/claude_cli/create_api_key
                    Authorization: Bearer <ephemeral OAuth placeholder>
                    X-Teamroom-Token: <ephemeral routing token>
                  → proxy substitutes Authorization with real OAuth token
                  → Anthropic returns temp API key
                  → AnthropicLlmClient caches temp key for the rest of the turn

t5  Container→  AnthropicLlmClient.chat(messages, system):
    Proxy         POST /v1/messages
                    Host: host.docker.internal:PORT
                    x-api-key: <temp-key (OAuth) | ephemeral (API-key mode)>
                    X-Teamroom-Token: <ephemeral routing token>
                    anthropic-version: 2023-06-01
                    Body: {model, system, messages, max_tokens}

t6  Proxy       routingToken = headers["x-teamroom-token"]
                entry = tokenRegistry.lookup(routingToken)
                  ⇒ {agentId, provider:"anthropic", model, traceId, turnId}
                adapter = adapters[entry.provider]  // anthropic-adapter
                clone headers; adapter.injectAuth(headers, mode):
                  - API-key mode: replace x-api-key with real key
                  - OAuth mode (post-exchange): leave x-api-key as-is
                stripHopByHop(headers)
                start = clock.now()
                → forward to api.anthropic.com with adapter.upstreamUrl()

t7  Proxy       receive upstream response:
                  pipe(upstream → client)
                  parsedBody = JSON.parse(buffered)
                  usage = adapter.extractUsage(parsedBody)
                  logger.info({
                    event:"model.call.completed",
                    traceId: entry.traceId,
                    spanId: newSpanId(),
                    parentSpanId: turn-level-span,
                    agentId, turnId, provider:"anthropic", model,
                    startedAt:start, finishedAt:now, latencyMs,
                    inputTokens, outputTokens, status:"ok"
                  })

t8  Container   AnthropicLlmClient.chat() returns reply text
                runTurn() appends reply to /store/conversation.jsonl
                stdout: {"type":"reply","body":"..."}
                exit 0

t9  Daemon      DockerRunner.run() resolves
                For each stdout reply event:
                  MessageRepo.insertOutbound(...)
                  NotifyBus.publish("message.outbound", {turnId})
                TurnRepo.markCompleted(turnId)
                NotifyBus.publish("turn.completed", {turnId})

t10 Daemon      finally { modelProxy.evictToken(token) }
                logger.info({event:"turn.completed", traceId, ...})

t11 tail        Receives "message.outbound", fetches body, prints reply
```

**Span-shaped records emitted across this turn:** `turn.started` (t2, daemon), `model.call.completed` (t7, proxy; one per upstream call — t5a's OAuth exchange also emits a span), `turn.completed` (t10, daemon). All carry the same `traceId`.

**Crash boundaries.**

- Daemon crash between t2 and t3 → next-start reconcile finds `running` turn with placeholder container_id → marks errored as `'daemon_restart_during_pending'` (debt #1 covered).
- Daemon crash during t6/t7 → container blocks on socket close → exits non-zero → reconcile marks errored.
- Container crash mid-call → `runner.run()` rejects → `evictToken` runs in `finally` → registry stays clean.

---

## 5. Error handling

Following the M1 principle — *nothing silent, nothing inconsistent, nothing crashes*. Proxy is deliberately dumb about retries: that's the SDK's or future agent's job.

| Scenario | Proxy behavior | Container/daemon outcome |
|---|---|---|
| Upstream 5xx / 429 | Forward response as-is. Emit `model.call.completed` with `status:"upstream_error"`, `errorClass:"<status>_<provider>"`, `httpStatus`. | SDK throws; runtime propagates; container exits non-zero; daemon marks turn errored. |
| Upstream timeout (configurable per-call deadline, default 60s) | Abort upstream socket; return 504 to container. Emit `model.call.completed` with `status:"upstream_timeout"`. | Same as above. |
| Routing token unknown (token already evicted, leaked, or daemon restart wiped registry) | Return 401 with `{"error":"unknown_token"}`. Emit `model.call.rejected` with `errorClass:"unknown_token"` and the **first 8 chars only** of the token (debug aid; no secret leakage). | SDK throws; treated as terminal. No retry. |
| Provider mismatch (registry says X, request looks like Y) | Not validated in M2. Forward to registry-entry's provider's upstream; upstream rejects normally. | Visible as a normal upstream error; debuggable locally. Premature defense. |
| Container exits before completing call | Proxy may finish upstream call after client-side close; response discarded; `model.call.completed` emits with `status:"client_disconnected"` and no `outputTokens`. | `runner.run()` rejects → `evictToken` in `finally` → turn marked errored. |
| Daemon crash mid-turn | Token registry is in-memory — wiped on restart. | Reconcile sweeps aged `pending` and dead-container `running` rows → marks errored with `"daemon_restart_during_turn"`. |
| Proxy listener errors (in-process to daemon) | Propagate to daemon's global safety-nets (M1 `uncaughtException` handler). Log fatal; attempt one listener restart; if that fails, mark daemon unhealthy. | Daemon does not exit (per M1 principle). |
| Configuration error: `provider:anthropic` agent but no Anthropic credential | Daemon refuses turns for that agent only; logs `agent.unhealthy` once on startup; inbound still queues but immediately marks errored with `"missing_credential"`. | Other agents continue normally — localized failure, not daemon-wide stop. |

**No retries in M2.** Anthropic SDKs already retry transient network errors with backoff. Adding daemon-level retry without per-agent budgeting risks runaway cost. Future milestone (with budgeting): per-agent retry policy lives in agent-runtime config, not in the proxy.

---

## 6. Authentication modes

The proxy auto-detects the auth mode at startup based on which env vars are present (see §3.5). The two modes work differently end-to-end.

### 6.1 API-key mode

Selected when `ANTHROPIC_API_KEY` is set.

- **Container side.** `AnthropicLlmClient` constructs the SDK with `apiKey` = the routing token (it gets sent as `x-api-key` by the SDK). All `/v1/messages` calls go directly to the proxy.
- **Proxy side.** On every request, `anthropic-adapter.injectAuth` replaces `x-api-key` with the real `ANTHROPIC_API_KEY` before forwarding.
- **Routing.** `X-Teamroom-Token` header carries the routing token (separate from auth).

### 6.2 OAuth mode (Claude Code subscription)

Selected when no `ANTHROPIC_API_KEY` and either `CLAUDE_CODE_OAUTH_TOKEN` env or `~/.claude/.credentials.json` is present.

- **Container side.** `AnthropicLlmClient` first performs the OAuth exchange (~30 LOC of `fetch`):
  1. `POST /api/oauth/claude_cli/create_api_key` with `Authorization: Bearer <placeholder>` and `X-Teamroom-Token: <routing-token>`.
  2. Proxy intercepts (sees the `Authorization` header), substitutes the real OAuth token, forwards to Anthropic.
  3. Anthropic returns a temp API key.
  4. Client caches the temp key in memory for the rest of the turn.
- All subsequent `/v1/messages` calls send `x-api-key: <temp-key>` (no `Authorization` header). Proxy passes them through unmodified, but still emits a `model.call.completed` span (routing token + temp key both present in the log context — no secret leakage in the span itself).
- **Routing.** Same `X-Teamroom-Token` header. **This is why we need the routing-vs-auth split:** without it, post-exchange calls would be unattributable to an agent.

### 6.3 Mode-detection failure

If neither credential source resolves and an agent declares `provider:anthropic`, the daemon logs the failure once and routes that agent's turns to the `missing_credential` error path (see §5). The `assistant`/LM Studio agent still functions normally.

### 6.4 Anthropic OAuth-gating risk (tabled fallback plan)

Anthropic has been actively restricting programmatic use of subscription tokens outside Claude Code. If our manual exchange (`@anthropic-ai/sdk` + ~30 LOC) gets gated — most likely as a 401/403 on the exchange call or a signed-request requirement we can't reproduce — the documented fallback is to switch the container to the **Claude Agent SDK (Node)**, which Anthropic sanctions for this use case. Decision happens at implementation time; the fallback is captured in [`docs/tabled.md`](../tabled.md).

---

## 7. Testing

Holding the M1 line: in-memory real implementations, no `vi.mock`/`jest.mock`, co-located unit tests at `src/<module>/<file>.test.ts`, cross-module tests at `tests/integration/`.

### 7.1 Unit tests (co-located)

**`src/model-proxy/`:**

- `local-model-proxy.test.ts`
  - `start()` listens on 127.0.0.1, OS-assigned port; `stop()` releases.
  - End-to-end with a real local **fake-upstream** http server: proxy receives request with routing token, swaps auth, forwards, pipes response back, emits span via `CapturingLogger`.
  - Routing token unknown → 401 + `model.call.rejected` span (token prefix only).
  - Upstream returns 429 → forwarded as-is, span carries `status:"upstream_error"`.
  - Upstream timeout → 504, span carries `status:"upstream_timeout"`.
  - Concurrent in-flight tokens don't cross-contaminate.
  - OAuth mode: exchange-call substitutes Authorization; subsequent requests pass through unmodified.
  - API-key mode: every request gets `x-api-key` substituted.

- `token-registry.test.ts` — mint/lookup/evict; lookup-after-evict returns undefined; concurrent mints produce unique tokens.

- `adapters/anthropic-adapter.test.ts` — `upstreamUrl()` resolves correctly; `injectAuth` for both modes; `extractUsage` from canned Anthropic body (`usage.input_tokens`, `usage.output_tokens`).

- `adapters/lm-studio-adapter.test.ts` — same coverage for OpenAI-compat shape (`usage.prompt_tokens`, `usage.completion_tokens`).

**`src/agent-runtime/`:**

- `anthropic-llm-client.test.ts`
  - `chat()` against a real local http test server returns the parsed reply text.
  - OAuth-mode happy path: client makes the exchange call, then the `/v1/messages` call.
  - OAuth-mode exchange failure (test server returns 401 on the exchange) → throws with the upstream error.
  - API-key-mode happy path: SDK sends `x-api-key`; test server confirms header presence.
  - Every outbound request includes `X-Teamroom-Token`.

**`src/daemon/` (extensions to existing tests):**

- `turn-processor.test.ts`: `markRunning` is called *before* `runner.run()` (debt #1); `mintToken`/`evictToken` are called in pair under both success and error paths via a fake `ModelProxy` (real in-memory, not a mock).
- `reconcile.test.ts`: new case for aged-`pending` rows → marked errored with the daemon-restart class.
- `safety-nets.test.ts`: idempotent `shutdown` (call twice, no throw); PID file unlinked on clean stop.
- `docker-runner.test.ts`: `parseEvent` test case where malformed JSON includes a `type` field — typed `type` from event scaffolding wins (debt #3).

### 7.2 Integration tests

`tests/integration/proxy-end-to-end.test.ts` — new. Wires real `LocalModelProxy`, real `SQLite :memory:`, real `InMemoryBus`, real `FakeRunner`, and real fake-upstream http server. Two scenarios:

1. **Anthropic path (both modes).** Insert inbound for `claude-assistant`. Daemon mints token; FakeRunner acts as a container by sending an http request to the proxy using its received env vars, then writes a reply event on its mock stdout. Assert: proxy received the request with the routing token; fake upstream received the request with the *real* credential; outbound message stored; bus event fired; routing token evicted post-turn.
2. **Provider isolation.** Two agents, two turns interleaved. Assert each agent's request goes to its own provider's upstream with its own real key; no cross-talk between routing tokens.

The existing M1 integration test (`tests/integration/end-to-end.test.ts`) stays — extended by adding the proxy to its composition root rather than rewritten.

### 7.3 Smoke test

`./scripts/smoke-test.sh` extended:

1. Build both agent images.
2. Start daemon (proxy comes up automatically).
3. `teamroom send --agent assistant "hello"` → expect reply via LM Studio (existing path).
4. `teamroom send --agent claude-assistant "hello"` → expect reply via real Anthropic.
5. Both turns complete; both `model.call.completed` spans visible in the log.

**Pass criterion.** Both agents responded; both providers' spans grep-able. Preconditions: Docker running, LM Studio running with a model loaded, Anthropic creds (API key OR OAuth token) discoverable. Documented in `docs/runbooks/smoke-test.md` (existing — updated).

### 7.4 What we do not test

- Real Anthropic API behavior under load, rate limits, or non-trivial response shapes — that's evaluation territory (M6).
- Streaming responses — out of scope.
- Multi-model selection — tabled.
- Provider-body validation — by design (per §5 "provider mismatch").

---

## 8. Observability slice

- **Span vocabulary.** Every effectful boundary emits one structured log record with `traceId`, `spanId`, optional `parentSpanId`, `agentId` (where known), `turnId` (where applicable), timestamps, and event-specific fields. Events:
  - `turn.started`, `turn.completed`, `turn.errored` (daemon)
  - `model.call.completed`, `model.call.rejected` (proxy)
  - `container.spawn.started`, `container.spawn.completed` (daemon)
- **End-to-end reconstructability.** Daemon, container, and proxy all emit the same vocabulary — a `cat | jq` over the JSONL log files reconstructs a full turn trace.
- **No new persistence in M2.** No `model_usage` table. No bus events for telemetry. The destination evolves in M3 once the bus rewrite earns the second sighting; until then, span-shaped log records are the same data with a one-pass migration when the real telemetry layer arrives (per Q6 dialogue).
- **Token-prefix only on rejection.** Unknown-token rejections log `tokenPrefix: <first-8-chars>` for debug, never the full token.
- **Sensitive payloads not logged.** Request and response bodies are not in spans. Only metadata (sizes, model, status, token counts).

---

## 9. M1 debts absorbed in M2

Carried forward from the M1 retro and as-built:

1. **Reconciler `pending`-blind-spot.** Fix shape (i): `markRunning` *before* `runner.run()` with a placeholder container_id, plus reconcile sweeps aged `pending` rows. Touched naturally because we're already modifying `processTurn` to mint/evict tokens.
2. **Daemon shutdown polish.** Static `import * as fs from "node:fs"`; `stop()` unlinks PID file; `let stopped = false` guard around `db.close()`.
3. **`parseEvent` spread ordering.** One-line spread reorder; typed `type` field always wins over malformed JSON payload.
4. **`@types/node` vs runtime target.** Bump to `^22` and `engines.node: ">=22"` if no transitive dep blocks it; otherwise revert `@types/node` to `^20`. Decision at implementation time after `npm ls` check.
5. **Agent-onboarding runbook (skeleton).** `docs/runbooks/agent-onboarding.md` written as part of hiring `claude-assistant`. Skeleton only — explicit note that real specialized-agent onboarding will need much more (flowcharts, skill assignments, tool inventories) and that the expectation is agent roles emerge from observed use before they're formally onboarded.

---

## 10. Non-goals and tabled items

Explicitly out of scope for M2; each lives in [`docs/tabled.md`](../tabled.md):

- Per-turn / per-conversation model selection.
- Multi-model-per-agent configuration; agents with skills + arrays of models + per-skill model instructions.
- Streaming model responses (re-evaluate before "soon" feature work).
- Tool-call telemetry (alignment confirmed; no M2 work — pattern is in place).
- Two-way / streaming transport between container and proxy (SSE, HTTP/2, WebSockets, tRPC).
- Future agent runtimes beyond LangGraph (Claude Agent SDK, subagent-spawning).
- Anthropic OAuth-gating fallback plan (Claude Agent SDK if vanilla SDK + manual exchange gets blocked).
- Runbook-vs-skill boundary heuristic (carried over from M1 close; revisit on second sighting — likely the agent-onboarding runbook itself if it grows beyond skeleton).

Also out of scope (no need to table — derivable from principles):

- Allowlists with explicit enforcement (N=1 — agent's config IS its allowlist of one).
- OAuth scopes / fine-grained permissions.
- Rate-limit handling and per-agent budgets.
- Bus events for telemetry (deferred to M3 bus rewrite).
- Provider-body validation at the proxy.
- CI (still local-only post-M1 per retro).

---

## 11. Open implementation risks to watch for

These don't block design approval but should be on the implementation plan's pre-execution review list:

1. **Anthropic OAuth-exchange gating** — see §6.4. Fallback documented; decision at implementation time.
2. **`host.docker.internal` resolution on Linux.** Works out-of-box on Docker Desktop (Mac/Windows); on Linux the daemon may need `--add-host=host.docker.internal:host-gateway` on the run args. Cheap defensive add.
3. **Per-turn token races.** If a container is unusually slow, an evicted token could be retried by a still-in-flight upstream-slow request. M2 simple stance: token lifetime = turn lifetime; any post-eviction request rejects. Acceptable.
4. **Anthropic SDK retries vs proxy timeout.** SDK retries by default; if proxy timeout fires first, SDK might think the request was retryable. Solution: align timeouts (proxy timeout > SDK total retry budget) or disable SDK retries inside `AnthropicLlmClient`.
5. **Writable single-file `/AGENTS.md` mount on macOS.** Single-file Docker mounts have well-known quirks. Fallback: mount the directory rw and access `AGENTS.md` from within. Decision at implementation time after a smoke test.
6. **Reading `~/.claude/.credentials.json` from the daemon process.** Format may evolve with Claude Code updates; treat the file as best-effort and produce a clear error message if the structure is unrecognized.

---

## 12. Files touched / created (summary)

**New:**

- `src/model-proxy/` (module)
- `src/agent-runtime/anthropic-llm-client.ts` + `.test.ts`
- `agents/<new-agent>/` (folder + `agent.yaml`, `AGENTS.md`, `Dockerfile`, `store/.gitkeep`)
- `tests/integration/proxy-end-to-end.test.ts`
- `docs/runbooks/agent-onboarding.md`
- `docs/runbooks/anthropic-auth.md`
- `docs/specs/2026-04-18-m2-model-abstraction-design.md` (this file)

**Updated:**

- `src/daemon/turn-processor.ts`, `reconcile.ts`, `safety-nets.ts`, `docker-runner.ts`
- `src/agent-runtime/main.ts` (provider factory + routing-token header)
- `src/types.ts` (if needed for new shared types — `Provider`, `AuthMode`, span shapes)
- `agents/assistant/agent.yaml` (add explicit `provider: lm-studio`)
- `.env.example` (add Anthropic vars)
- `README.md` (note both backends)
- `docs/runbooks/smoke-test.md` (extend for Anthropic path)
- `package.json` (`@types/node`, `engines.node`)
- Module READMEs for any module touched (per ways-of-working: doc updates land in the same change)

---

*End of M2 design. Plan to follow under `docs/plans/`.*
