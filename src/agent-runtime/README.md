# `agent-runtime/` — what runs inside each container

The shim that reads a single stdin JSON envelope, loads conversation history from `/store/conversation.jsonl`, calls an OpenAI-compatible LLM endpoint via an injected `LlmClient`, streams `type: "reply"` events on stdout, appends the new messages to the conversation file, and exits. `runtime.ts` holds the pure turn function (DI-testable). `main.ts` wires the real SDK. `session-store.ts` owns the conversation file.

**Runs inside each agent container**, not on the host. Baked into each agent image at build time via the agent's `Dockerfile` (`COPY dist/agent-runtime /app/agent-runtime`). The daemon treats this code as opaque beyond the stdin/stdout JSONL contract in spec §9 — this module's implementation details never leak to the host side.

M1 deliberately uses a minimal runtime; **LangGraph is the intended long-term replacement** (see spec §9.1 and the `project_teamroom_langgraph_direction` memory entry). The container contract is language-agnostic, so a future agent could use a Python-based runtime instead.

## Files

- `main.ts` — container entry. Reads stdin once, builds the OpenAI-compatible client from env (`TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`, `TEAMROOM_MODEL`), invokes `runTurn`, exits.
- `runtime.ts` — `runTurn(deps)`: pure function with `LlmClient` interface; the testable core.
- `session-store.ts` — `loadConversation` / `appendMessage` for `conversation.jsonl`.
- `runtime.test.ts`, `session-store.test.ts` — co-located unit tests using in-memory fake `LlmClient`.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** `openai` npm package, Node `fs` (for the writable `/store` mount and read-only `/AGENTS.md`).
- **Used by:** the container `ENTRYPOINT` in each agent's `Dockerfile`. Not imported by any other `src/` module — the process boundary is strict.
- **Host-side counterpart:** [agent-config/README.md](../agent-config/README.md) — the loader that prepares what this runtime needs at spawn time.
- **Spec:** [M1 design](../../docs/specs/2026-04-18-teamroom-m1-design.md) — §9 container contract, §9.1 agent internals are the agent's concern.
- **Memory:** `project_teamroom_langgraph_direction` — intended M4+ replacement framework.
