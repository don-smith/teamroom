# Team Room M2 — Model Abstraction Layer

*Date: 2026-04-18. Active spec for the M2 milestone. Purged into the M2 as-built at milestone close.*

> Predecessor context: [`team-room-context.md`](../../team-room-context.md) (vision, milestone roadmap, M2 framing as "Multi-model credential proxy" — renamed during M1 to "Model abstraction layer"); [M1 as-built](../as-built/2026-04-18-teamroom-m1.md) (architecture being extended); [`tabled.md`](../tabled.md) (future items intentionally deferred from M2).

---

## 1. Goal and exit criteria

**Goal.** Introduce the seam where containers talk *through* the daemon to model providers, with credentials never reaching the container, and per-agent provider/model declared in `agent.yaml`. Establish the patterns (credential isolation, span-shaped end-to-end telemetry, agent identity at the proxy boundary, two-mode auth) that later milestones extend rather than rewrite.

**Exit criteria.**

1. Two agents run concurrently against two different backends end-to-end:
   - Renamed `studio-assistant` agent (M1's `assistant`, renamed for clarity since agents are increasingly named after their backing model) against local LM Studio (M1 path, now via the proxy).
   - New `claude-assistant` agent against the real Anthropic API using either the user's Claude Code subscription (OAuth, preferred) or an API key (fallback).
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
│   SQLite        ModelProxy (in-process listener) ─┼─→ OAuth │
│                  127.0.0.1:PORT                   │   temp- │
│                  ▲                                │   key   │
│                  │ HTTP/1.1                       │   cache │
│                  │ x-api-key: <routing-token>     │         │
│                  │                                │         │
│  ┌───────────────┼────────────────────────────────┘         │
│  │  Container (per-turn, opaque, mode-agnostic)             │
│  │    agent-runtime → LlmClient → openai|anthropic SDK      │
│  │      SDK targets http://host.docker.internal:PORT        │
│  │      apiKey = routing-token  (sent as x-api-key)         │
│  └─────────────────────────────────────────────────────────┐│
│                                                            ││
│  Proxy → reads x-api-key (= routing token) → registry      ││
│       → resolves agent + provider + auth mode              ││
│       → API-key mode: substitute x-api-key with real key   ││
│       → OAuth mode:   ensure cached temp key is fresh,     ││
│                       (server-to-server exchange if not),  ││
│                       substitute x-api-key with temp key   ││
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
│   ├── anthropic-adapter.ts        # /v1/messages → api.anthropic.com
│   ├── anthropic-oauth-cache.ts    # in-memory temp-key cache (OAuth mode only)
│   └── lm-studio-adapter.ts        # /v1/chat/completions → LM Studio
├── span.ts                         # span-shaped log record builder + ID helpers
└── *.test.ts                       # co-located unit tests
```

**Shared types (sketch).**

```ts
type Provider = "anthropic" | "lm-studio";
type AuthMode = "api-key" | "oauth";

interface MintTokenInput {
  turnId: string;
  agentId: string;
  traceId: string;
  provider: Provider;
  model: string;
}

// Value stored in the token registry — keyed by the routing token.
// Real upstream credentials are NOT stored here; they live in the adapter,
// resolved per-call. See multi-model tabled item: this shape will evolve.
interface TokenEntry {
  agentId: string;
  turnId: string;
  traceId: string;
  provider: Provider;
  model: string;
}
```

**`ModelProxy` interface (sketch).**

```ts
interface ModelProxy {
  start(): Promise<{ port: number }>;     // listens on 127.0.0.1, OS-assigned port
  stop(): Promise<void>;
  mintToken(input: MintTokenInput): string; // returns the routing token
  evictToken(token: string): void;        // called from processTurn `finally`
}
```

**`ProviderAdapter` interface (sketch).**

```ts
interface ProviderAdapter {
  readonly id: Provider;
  readonly authMode: AuthMode;           // resolved at proxy startup from .env
  upstreamUrl(): string;
  injectAuth(headers: OutgoingHttpHeaders): void;
  extractUsage(responseBody: unknown): {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

**Terminology — "routing token".** A single per-turn ephemeral identifier minted by the daemon and injected into the container env as `TEAMROOM_MODEL_API_TOKEN`. The container's SDK sends it as `x-api-key` on every outbound call (the SDK's `apiKey` ctor option puts it there). It serves two roles for the proxy:

- **Routing.** The proxy reads `x-api-key`, looks it up in the registry → gets the entry → knows which agent and which provider this call is for.
- **Auth placeholder.** The proxy substitutes `x-api-key` with a real upstream credential before forwarding — either the real `ANTHROPIC_API_KEY` (API-key mode) or a cached/freshly-fetched Anthropic temp API key (OAuth mode). LM Studio gets the same treatment with `LM_STUDIO_API_TOKEN`.

The container is **mode-agnostic** — its only outbound auth scheme is `apiKey = routing-token` regardless of which Anthropic auth mode the proxy is configured for. All OAuth mechanics (exchange call, temp-key caching, refresh) live in the proxy. See §6 for the two modes.

**Routing rule.** Proxy reads `x-api-key`. Looks up the registry entry → gets `provider` → hands off to the adapter for credential substitution and forwarding.

### 3.2 Updates to `src/daemon/`

- **Composition root.** Constructs `LocalModelProxy`, calls `start()`, stores assigned port.
- **`turn-processor.ts`.** New ordering:
  1. `markRunning(turnId, placeholderContainerId)` ← *moved before* `runner.run()` (debt #1).
  2. `mintToken({turnId, agentId, traceId, provider: agent.provider, model: agent.model})`.
  3. `runner.run({ env: { ..., TEAMROOM_MODEL_BASE_URL, TEAMROOM_MODEL_API_TOKEN: token, TEAMROOM_PROVIDER, TEAMROOM_MODEL, TEAMROOM_TURN_ID, TEAMROOM_TRACE_ID, TEAMROOM_AGENT_ID }, ... })`.
  4. In a `finally` block: `evictToken(token)` regardless of success/error.
  5. Replace placeholder container_id with the real one once known (`turnRepo.attachContainer`).
- **`reconcile.ts`.** Adds aged-`pending` reclamation: rows with `status='pending'`, no `container_id`, older than threshold → mark errored with `'daemon_restart_during_pending'`.
- **`safety-nets.ts` and shutdown** (debt #2): static `import * as fs from "node:fs"` instead of dynamic import; on clean stop, unlink PID file; `let stopped = false` guard around `db.close()`.
- **`docker-runner.ts` `parseEvent`** (debt #3): swap spread order so the typed `type` field always wins over malformed JSON payload.

### 3.3 Updates to `src/agent-runtime/`

- **`main.ts`.** Reads `TEAMROOM_PROVIDER` env var. Factory picks the right `LlmClient` impl.
- **`anthropic-llm-client.ts`** *(new)*. Uses `@anthropic-ai/sdk`, configured with `baseURL = TEAMROOM_MODEL_BASE_URL` and `apiKey = TEAMROOM_MODEL_API_TOKEN` (the routing token). That's the entire client setup — **identical for both API-key and OAuth auth modes**. The container has no awareness of OAuth, exchange endpoints, or temp keys; that machinery lives entirely in the proxy. ~10–15 LOC total.
- **`runtime.ts`.** Unchanged contract (`LlmClient` already abstracts the call).
- Co-located `anthropic-llm-client.test.ts` — uses real local http test server stand-in (matching M1 pattern: real impls, no mocks).

### 3.4 Agent population: rename `assistant` → `studio-assistant`, add `claude-assistant`

**Rename M1's existing agent.** `agents/assistant/` → `agents/studio-assistant/`. Naming convention going forward: agents are named primarily after their backing model/provider so the role is obvious from the name. Studio (LM Studio), claude (Anthropic), etc. The rename is a cross-cutting touch (29 file matches across live code, configs, tests, docs); frozen historical docs (`docs/as-built/`, `docs/retros/`, `team-room-context.md`) are left unchanged because they accurately describe M1 reality.

**New agent.** `agents/claude-assistant/`:

```
agents/claude-assistant/
├── agent.yaml          # name, provider: anthropic, model: claude-..., image_tag
├── AGENTS.md           # mounted writable as /AGENTS.md
├── Dockerfile          # node:22-alpine + dist/agent-runtime + @anthropic-ai/sdk
└── store/
    └── .gitkeep
```

`agent.yaml` schema gains a required `provider: anthropic | lm-studio` field. The `studio-assistant/agent.yaml` (renamed from `assistant/agent.yaml`) gains an explicit `provider: lm-studio`.

### 3.5 `.env` and credential discovery

`.env.example` updated with the new keys:

```
LM_STUDIO_API_TOKEN=...        # existing
ANTHROPIC_API_KEY=...          # optional; presence selects API-key mode
CLAUDE_CODE_OAUTH_TOKEN=...    # optional; selects OAuth mode (subscription)
```

**Credential discovery order (proxy startup) — OAuth preferred:**

1. If `CLAUDE_CODE_OAUTH_TOKEN` is set in `.env` → OAuth mode.
2. Else if `~/.claude/.credentials.json` exists with a usable OAuth token (where Claude Code stores it after login) → OAuth mode.
3. Else if `ANTHROPIC_API_KEY` is set in `.env` → API-key mode (fallback for non-subscription use).
4. Else: fail at startup with a clear error if any agent's `agent.yaml` declares `provider: anthropic`. Other agents still function.

Rationale: the user's primary use case is the Claude Code subscription (OAuth). API-key is a supported fallback for non-subscription consumption, but if both are present, OAuth wins.

Documented in `docs/runbooks/anthropic-auth.md` (new).

### 3.6 New runbook: agent onboarding skeleton

`docs/runbooks/agent-onboarding.md` — a deliberately-short skeleton documenting only what M2 actually demonstrates: create `agents/<name>/` folder, write `agent.yaml`, write `AGENTS.md`, write `Dockerfile`, register agent in DB, build image, send first message, verify in logs. Top-of-file note: "this skeleton is a starting point. Real specialized-agent onboarding will involve flowcharts, skill assignments, tool inventories, and metadata that M2 does not yet model. The expectation is that an agent role is observed-in-use before it is formally onboarded; the skeleton supports the manual path that exists today."

### 3.7 Tooling

`package.json`: bump `@types/node` and `engines.node` to `>=22` *if* a quick `npm ls` confirms no transitive dep requires `<22`. Otherwise leave at `^20` to match runtime (debt #4 — implementation-time decision).

---

## 4. Data flow (one turn, end-to-end)

Tracing a single inbound message destined for the new `claude-assistant` (Anthropic) agent. Same flow applies to `studio-assistant`/LM Studio with provider-specific bits swapped.

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
                    TEAMROOM_MODEL_API_TOKEN: token,   // routing token
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
                    ? new AnthropicLlmClient({                       // mode-agnostic
                        baseURL: env.TEAMROOM_MODEL_BASE_URL,
                        apiKey:  env.TEAMROOM_MODEL_API_TOKEN,       // routing token
                        model:   env.TEAMROOM_MODEL })
                    : new OpenAILlmClient({...})
                  reply = await runTurn({llm, history, agentsMd, inbound})

t5  Container→  AnthropicLlmClient.chat(messages, system):
    Proxy         POST /v1/messages
                    Host: host.docker.internal:PORT
                    x-api-key: <routing-token>          ← always; no OAuth-aware code
                    anthropic-version: 2023-06-01
                    Body: {model, system, messages, max_tokens}

t6  Proxy       routingToken = headers["x-api-key"]
                entry = tokenRegistry.lookup(routingToken)
                  ⇒ {agentId, provider:"anthropic", model, traceId, turnId}
                adapter = adapters[entry.provider]  // anthropic-adapter
                                                     // adapter.authMode set at startup

                // — API-key mode —
                IF adapter.authMode === "api-key":
                  headers["x-api-key"] = real ANTHROPIC_API_KEY

                // — OAuth mode (proxy handles all of it) —
                ELSE IF adapter.authMode === "oauth":
                  IF cache[oauthToken]?.expiresAt > now() + safetyMargin:
                    tempKey = cache[oauthToken].tempKey
                  ELSE:
                    // server-to-server exchange — container never sees this
                    resp = POST api.anthropic.com/api/oauth/claude_cli/create_api_key
                             Authorization: Bearer <real OAuth token>
                    cache[oauthToken] = {
                      tempKey: resp.api_key,
                      expiresAt: resp.expires_at
                    }
                    tempKey = resp.api_key
                    logger.info({event:"oauth.exchange.completed", traceId, ...})
                  headers["x-api-key"] = tempKey

                stripHopByHop(headers)
                start = clock.now()
                → forward to api.anthropic.com with adapter.upstreamUrl()

t7  Proxy       receive upstream response:
                  IF status === 401 AND adapter.authMode === "oauth"
                       AND not already retried:
                    // credential-refresh retry (the only retry in M2's proxy)
                    evict cache[oauthToken]
                    GOTO t6 with retried=true
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

**Span-shaped records emitted across this turn:** `turn.started` (t2, daemon), `model.call.completed` (t7, proxy; one per upstream `/v1/messages` call), and `oauth.exchange.completed` (t6, proxy; only when the temp-key cache missed and an exchange round-trip happened). `turn.completed` (t10, daemon). All carry the same `traceId`.

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

**No retries in M2 — except one.** Anthropic SDKs already retry transient network errors with backoff. Adding daemon-level retry without per-agent budgeting risks runaway cost. Future milestone (with budgeting): per-agent retry policy lives in agent-runtime config, not in the proxy.

The single allowed retry is **credential refresh** in OAuth mode. If a `/v1/messages` call returns 401 from Anthropic and the proxy is in OAuth mode, the proxy evicts the cached temp key, performs a fresh OAuth exchange, and retries the call **once** with the new temp key. Rationale: this is fundamentally different from a transient-error retry — we know exactly why it failed (temp key expired or revoked) and can fix it deterministically. Bounded to one retry; no exponential backoff; if the second call also fails, the error propagates normally.

---

## 6. Authentication modes

The proxy auto-detects the auth mode at startup based on which env vars are present (see §3.5). **Both modes look identical from the container's perspective** — the container always sends `x-api-key: <routing-token>` and never knows which mode is active. All credential resolution and OAuth machinery live in the proxy.

### 6.1 API-key mode

Selected when no OAuth credential is present and `ANTHROPIC_API_KEY` is set.

- **Container side.** `AnthropicLlmClient` is `new Anthropic({ baseURL, apiKey: routing-token })`. SDK sends `x-api-key: <routing-token>` on every request.
- **Proxy side.** On every request, `anthropic-adapter.injectAuth` replaces `x-api-key` with the real `ANTHROPIC_API_KEY` before forwarding to `api.anthropic.com`.
- **Routing.** Proxy looks up `x-api-key` (which is the routing token before substitution) in the registry to get the agent context. Substitution happens after lookup.

### 6.2 OAuth mode (Claude Code subscription, preferred)

Selected when `CLAUDE_CODE_OAUTH_TOKEN` env is set, or `~/.claude/.credentials.json` is readable. OAuth wins over API-key when both are present.

- **Container side.** Identical to API-key mode — `new Anthropic({ baseURL, apiKey: routing-token })`. Container has zero OAuth-aware code.
- **Proxy side.** On each request:
  1. Look up routing token in the registry → agent context.
  2. Check the OAuth-temp-key cache (`anthropic-oauth-cache.ts`) — keyed by the OAuth token itself (not by agent), so multiple agents sharing one OAuth token also share one cache entry.
  3. **Cache fresh** (i.e., `expiresAt > now() + safetyMargin`): substitute `x-api-key` with the cached temp key.
  4. **Cache stale or missing**: do a server-to-server exchange with `api.anthropic.com/api/oauth/claude_cli/create_api_key` using the real OAuth token; cache the returned temp key with its `expires_at`; substitute `x-api-key` with the new temp key. Emit an `oauth.exchange.completed` span.
  5. Forward `/v1/messages` to `api.anthropic.com`.
  6. **On 401 from Anthropic** with the substituted temp key: evict the cache entry, refetch, retry the original call **once** (see §5 — the only retry the M2 proxy performs).
- **Container is never involved in the exchange.** This is the meaningful simplification over NanoClaw's pattern (where the container did the exchange). Consequences:
  - Per-turn exchange round-trips drop to roughly "once per temp-key TTL" instead of "once per turn." Far less likely to be flagged as unusual behavior by Anthropic.
  - Container-side code is identical for both modes; mode-switching is invisible to the agent.
  - Cache key is the credential being substituted (the OAuth token), not the agent — so future "multiple agents on one subscription" works naturally.

### 6.3 Mode-detection failure

If no Anthropic credential resolves and an agent declares `provider:anthropic`, the daemon logs the failure once on startup and routes that agent's turns to the `missing_credential` error path (see §5). The `studio-assistant`/LM Studio agent still functions normally.

### 6.4 Anthropic OAuth-gating risk (tabled fallback plan)

Anthropic has been actively restricting programmatic use of subscription tokens outside Claude Code. If our server-to-server exchange in the proxy gets gated — most likely as a 401/403 on the exchange call or a signed-request / device-attestation requirement we can't reproduce — the documented fallback is to switch the container's runtime to the **Claude Agent SDK (Node)**, which Anthropic sanctions for this use case (and which would itself perform the exchange). Decision happens at implementation time; the fallback is captured in [`docs/tabled.md`](../tabled.md).

---

## 7. Testing

Holding the M1 line: in-memory real implementations, no `vi.mock`/`jest.mock`, co-located unit tests at `src/<module>/<file>.test.ts`, cross-module tests at `tests/integration/`.

### 7.1 Unit tests (co-located)

**`src/model-proxy/`:**

- `local-model-proxy.test.ts`
  - `start()` listens on 127.0.0.1, OS-assigned port; `stop()` releases.
  - End-to-end with a real local **fake-upstream** http server: proxy receives request with routing token in `x-api-key`, swaps it for the configured real credential, forwards, pipes response back, emits span via `CapturingLogger`.
  - Routing token unknown (not in registry) → 401 + `model.call.rejected` span (token prefix only).
  - Upstream returns 429 → forwarded as-is, span carries `status:"upstream_error"`.
  - Upstream timeout → 504, span carries `status:"upstream_timeout"`.
  - Concurrent in-flight tokens don't cross-contaminate.
  - **OAuth mode, cache miss:** proxy issues server-to-server exchange to fake-upstream's exchange endpoint, caches result, then forwards `/v1/messages` with the temp key. `oauth.exchange.completed` span emitted.
  - **OAuth mode, cache hit:** second call within TTL does not re-issue exchange; only one `/v1/messages` round-trip is observed by fake-upstream.
  - **OAuth mode, expired temp key:** fake-upstream returns 401 once; proxy evicts cache, re-exchanges, retries — second attempt succeeds. Exactly one retry; if the second attempt also 401s, error propagates.
  - **API-key mode:** every request gets `x-api-key` substituted with the real key; no exchange call ever happens.

- `token-registry.test.ts` — mint/lookup/evict; lookup-after-evict returns undefined; concurrent mints produce unique tokens.

- `adapters/anthropic-adapter.test.ts` — `upstreamUrl()` resolves correctly; `injectAuth` for both modes; `extractUsage` from canned Anthropic body (`usage.input_tokens`, `usage.output_tokens`).

- `adapters/anthropic-oauth-cache.test.ts` *(new)* — fresh-check honors `expiresAt` minus safety margin; eviction works; concurrent fetch-on-miss does not duplicate exchange calls (single-flight semantics).

- `adapters/lm-studio-adapter.test.ts` — same coverage for OpenAI-compat shape (`usage.prompt_tokens`, `usage.completion_tokens`).

**`src/agent-runtime/`:**

- `anthropic-llm-client.test.ts`
  - `chat()` against a real local http test server returns the parsed reply text.
  - SDK sends `x-api-key` with the configured `apiKey` value (the routing token); test server confirms header presence.
  - Tests are mode-agnostic — there is no OAuth-aware code path in the container; the same test exercises both production modes.

**`src/daemon/` (extensions to existing tests):**

- `turn-processor.test.ts`: `markRunning` is called *before* `runner.run()` (debt #1); `mintToken`/`evictToken` are called in pair under both success and error paths via a fake `ModelProxy` (real in-memory, not a mock).
- `reconcile.test.ts`: new case for aged-`pending` rows → marked errored with the daemon-restart class.
- `safety-nets.test.ts`: idempotent `shutdown` (call twice, no throw); PID file unlinked on clean stop.
- `docker-runner.test.ts`: `parseEvent` test case where malformed JSON includes a `type` field — typed `type` from event scaffolding wins (debt #3).

### 7.2 Integration tests

`tests/integration/proxy-end-to-end.test.ts` — new. Wires real `LocalModelProxy`, real `SQLite :memory:`, real `InMemoryBus`, real `FakeRunner`, and real fake-upstream http server. Three scenarios:

1. **Anthropic path, API-key mode.** Insert inbound for `claude-assistant` with API-key creds configured. Daemon mints token; FakeRunner acts as a container by sending an http request to the proxy using its received env vars, then writes a reply event on its mock stdout. Assert: proxy received the request with `x-api-key=<routing-token>`; fake upstream received the request with `x-api-key=<real-anthropic-api-key>`; outbound message stored; bus event fired; routing token evicted post-turn.
2. **Anthropic path, OAuth mode.** Same but with OAuth creds configured. First turn: assert proxy issued a server-to-server exchange to fake-upstream's exchange endpoint; cached temp key; forwarded `/v1/messages` with temp key. Second turn within TTL: assert no new exchange; cached temp key reused. Third turn after fake-upstream forces 401 on temp key: assert proxy evicted cache, re-exchanged, retried — exactly one retry.
3. **Provider isolation.** `studio-assistant` (LM Studio) and `claude-assistant` (Anthropic) interleaved. Assert each agent's request goes to its own provider's upstream with its own real key; no cross-talk between routing tokens.

The existing M1 integration test (`tests/integration/end-to-end.test.ts`) stays — extended by adding the proxy to its composition root rather than rewritten.

### 7.3 Smoke test

`./scripts/smoke-test.sh` extended:

1. Build both agent images.
2. Start daemon (proxy comes up automatically).
3. `teamroom send --agent studio-assistant "hello"` → expect reply via LM Studio (existing path, renamed).
4. `teamroom send --agent claude-assistant "hello"` → expect reply via real Anthropic.
5. Both turns complete; both `model.call.completed` spans visible in the log; in OAuth mode an `oauth.exchange.completed` span is also visible (once across the run).

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
  - `oauth.exchange.completed` (proxy; OAuth mode only, on cache miss)
  - `container.spawn.started`, `container.spawn.completed` (daemon)
- **Bus events vs. log events with the same name — both intentional, distinct destinations.** The bus also fires `turn.started` / `turn.completed` / `turn.errored` (M1 behavior, payload-free notifications used by `tail` and future subscribers). The log emits the same-named events as **span-shaped records** for trace reconstruction. Same logical happening, two destinations, neither replacing the other. M3's bus rewrite is the moment to revisit whether log events should also fire onto the bus.
- **End-to-end reconstructability.** Daemon, container, and proxy all emit the same vocabulary — a `cat | jq` over the JSONL log files reconstructs a full turn trace.
- **No new persistence in M2.** No `model_usage` table. No new bus events for telemetry. The destination evolves in M3 once the bus rewrite earns the second sighting; until then, span-shaped log records are the same data with a one-pass migration when the real telemetry layer arrives (per Q6 dialogue).
- **Token-prefix only on rejection.** Unknown-token rejections log `tokenPrefix: <first-8-chars>` for debug, never the full token.
- **Sensitive payloads not logged.** Request and response bodies are not in spans. Only metadata (sizes, model, status, token counts). OAuth tokens, temp API keys, and real provider keys never appear in any log.

---

## 9. M1 debts and cross-cutting cleanups absorbed in M2

Carried forward from the M1 retro and as-built, plus M2-spec cleanups added during brainstorm:

1. **Reconciler `pending`-blind-spot.** Fix shape (i): `markRunning` *before* `runner.run()` with a placeholder container_id, plus reconcile sweeps aged `pending` rows. Touched naturally because we're already modifying `processTurn` to mint/evict tokens.
2. **Daemon shutdown polish.** Static `import * as fs from "node:fs"`; `stop()` unlinks PID file; `let stopped = false` guard around `db.close()`.
3. **`parseEvent` spread ordering.** One-line spread reorder; typed `type` field always wins over malformed JSON payload.
4. **`@types/node` vs runtime target.** Bump to `^22` and `engines.node: ">=22"` if no transitive dep blocks it; otherwise revert `@types/node` to `^20`. Decision at implementation time after `npm ls` check.
5. **Agent-onboarding runbook (skeleton).** `docs/runbooks/agent-onboarding.md` written as part of hiring `claude-assistant`. Skeleton only — explicit note that real specialized-agent onboarding will need much more (flowcharts, skill assignments, tool inventories) and that the expectation is agent roles emerge from observed use before they're formally onboarded.
6. **Rename `assistant` → `studio-assistant`.** Cross-cutting touch (29 file matches; frozen historical docs left unchanged). Done as the first commit in the M2 implementation plan so it's easy to bisect. Convention going forward: agents named after their backing model/provider.
7. **Bus README YAGNI principle.** One-line addition to `src/bus/README.md`: don't add events without a real consumer; even observability is fair game only when there's a subscriber. Codifies the M2 dialogue in the place future contributors will look first.

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

1. **Anthropic OAuth-exchange gating** — see §6.4. Fallback documented; decision at implementation time. Mitigated by proxy-side caching (per-turn exchange round-trips drop to ~once per temp-key TTL), but does not eliminate the risk if Anthropic gates the exchange endpoint outright.
2. **OAuth temp-key TTL — verify on first real call.** The spec assumes Anthropic returns an `expires_at` (or equivalent) on the exchange response. If the actual field is named differently, has a different unit, or isn't returned at all, the cache needs adjustment. Capture exact field name + observed TTL in the M2 as-built once we have a real successful exchange.
3. **`host.docker.internal` resolution on Linux.** Works out-of-box on Docker Desktop (Mac/Windows); on Linux the daemon may need `--add-host=host.docker.internal:host-gateway` on the run args. Cheap defensive add.
4. **Per-turn token races.** If a container is unusually slow, an evicted token could be retried by a still-in-flight upstream-slow request. M2 simple stance: token lifetime = turn lifetime; any post-eviction request rejects. Acceptable.
5. **Anthropic SDK retries vs proxy timeout.** SDK retries by default; if proxy timeout fires first, SDK might think the request was retryable. Solution: align timeouts (proxy timeout > SDK total retry budget) or disable SDK retries inside `AnthropicLlmClient`.
6. **Writable single-file `/AGENTS.md` mount on macOS.** Single-file Docker mounts have well-known quirks. Fallback: mount the directory rw and access `AGENTS.md` from within. Decision at implementation time after a smoke test.
7. **Reading `~/.claude/.credentials.json` from the daemon process.** Format may evolve with Claude Code updates; treat the file as best-effort and produce a clear error message if the structure is unrecognized.
8. **OAuth-cache concurrency under multi-agent load.** If `claude-assistant` and a future second Anthropic agent both hit the proxy concurrently with the temp key cold, naïve fetch-on-miss will issue two exchange calls. Single-flight semantics in `anthropic-oauth-cache.ts` (one in-flight exchange per OAuth token; concurrent waiters share the result) mitigates this — covered by `anthropic-oauth-cache.test.ts`.

---

## 12. Files touched / created (summary)

**New:**

- `src/model-proxy/` (module)
- `src/agent-runtime/anthropic-llm-client.ts` + `.test.ts`
- `agents/claude-assistant/` (folder + `agent.yaml`, `AGENTS.md`, `Dockerfile`, `store/.gitkeep`)
- `tests/integration/proxy-end-to-end.test.ts`
- `docs/runbooks/agent-onboarding.md`
- `docs/runbooks/anthropic-auth.md`
- `docs/specs/2026-04-18-m2-model-abstraction-design.md` (this file)

**Renamed:**

- `agents/assistant/` → `agents/studio-assistant/` (folder rename + `agent.yaml` `name` field + ~25 references across live code, configs, tests, runbooks). Done as the first commit in the M2 plan.

**Updated:**

- `src/daemon/turn-processor.ts`, `reconcile.ts`, `safety-nets.ts`, `docker-runner.ts`
- `src/agent-runtime/main.ts` (provider factory)
- `src/types.ts` (if needed for new shared types — `Provider`, `AuthMode`, span shapes)
- `src/bus/README.md` (one-line YAGNI principle for new bus events)
- `agents/studio-assistant/agent.yaml` (add explicit `provider: lm-studio`)
- `.env.example` (add Anthropic vars; OAuth preferred)
- `README.md` (note both backends, rename references)
- `docs/runbooks/smoke-test.md` (extend for Anthropic path; rename references)
- `docs/runbooks/manual-cli-testing.md` (rename references)
- `package.json` (`@types/node`, `engines.node`; conditional bump to 22)
- Module READMEs for any module touched (per ways-of-working: doc updates land in the same change)

**Not touched (frozen historical docs):**

- `docs/as-built/2026-04-18-teamroom-m1.md`, `docs/retros/2026-04-18-m1.md`, `team-room-context.md`. These accurately describe M1 reality (the agent *was* called `assistant`); the rename is M2 reality.

---

*End of M2 design. Plan to follow under `docs/plans/`.*
