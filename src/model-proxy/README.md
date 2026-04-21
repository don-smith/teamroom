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
- **Used by:** [daemon/](../daemon/README.md) (composition root), [modules/session-management/](../modules/session-management/) (mints per-turn routing tokens).
- **Container counterpart:** [agent-runtime/](../agent-runtime/README.md) — `AnthropicLlmClient` is mode-agnostic; all OAuth machinery lives here, not there.
- **Spec:** [M2 design](../../docs/specs/2026-04-18-m2-model-abstraction-design.md) — §3.1 (interfaces), §4 (data flow), §6 (auth modes).
- **Memory:** [project_teamroom_langgraph_direction](../../docs/memory/project_teamroom_langgraph_direction.md) — the language-agnostic container contract is preserved by this module.
