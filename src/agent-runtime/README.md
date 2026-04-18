# `agent-runtime/` — what runs inside each container

The shim that reads a single stdin JSON envelope, loads conversation history from `/store/conversation.jsonl`, calls an LLM endpoint via an injected `LlmClient`, streams `type: "reply"` events on stdout, appends the new messages to the conversation file, and exits. `runtime.ts` holds the pure turn function (DI-testable). `main.ts` wires the real SDK — picking either the OpenAI-compatible client (LM Studio) or `AnthropicLlmClient` based on `TEAMROOM_PROVIDER`. `session-store.ts` owns the conversation file.

**Runs inside each agent container**, not on the host. Baked into each agent image at build time via the agent's `Dockerfile` (`COPY dist/agent-runtime /app/agent-runtime`). The daemon treats this code as opaque beyond the stdin/stdout JSONL contract in spec §9 — this module's implementation details never leak to the host side.

M1 deliberately uses a minimal runtime; **LangGraph is the intended long-term replacement** (see spec §9.1 and the `project_teamroom_langgraph_direction` memory entry). The container contract is language-agnostic, so a future agent could use a Python-based runtime instead.

## Files

- `main.ts` — container entry. Reads stdin once, builds an `LlmClient` via a `TEAMROOM_PROVIDER`-driven factory (`anthropic` → `AnthropicLlmClient`, `lm-studio` → inline OpenAI-compatible client), invokes `runTurn`, exits. Reads `TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`, `TEAMROOM_MODEL` from env. Unknown provider → throws with the offending value.
- `anthropic-llm-client.ts` — `AnthropicLlmClient` wrapping `@anthropic-ai/sdk`. Mode-agnostic: the daemon-side proxy handles OAuth-vs-API-key; this client just sends to whatever `baseURL` it's pointed at with whatever bearer token it's given.
- `runtime.ts` — `runTurn(deps)`: pure function with `LlmClient` interface; the testable core.
- `session-store.ts` — `loadConversation` / `appendMessage` for `conversation.jsonl`.
- `runtime.test.ts`, `session-store.test.ts`, `anthropic-llm-client.test.ts` — co-located unit tests using in-memory fakes.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** `openai` and `@anthropic-ai/sdk` npm packages, Node `fs` (for the writable `/store` mount and `/AGENTS.md`).
- **Used by:** the container `ENTRYPOINT` in each agent's `Dockerfile`. Not imported by any other `src/` module — the process boundary is strict.
- **Host-side counterpart:** [agent-config/README.md](../agent-config/README.md) — the loader that prepares what this runtime needs at spawn time.
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 container contract, §3 language-agnostic contract decision.
- **Memory:** `project_teamroom_langgraph_direction` — intended M4+ replacement framework.
