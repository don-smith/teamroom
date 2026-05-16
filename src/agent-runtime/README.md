# `agent-runtime/` — what runs inside each container

The module that drives one worker per agent container. An `AgentWorker` interface defines the shape (`handleWake(envelope)`); a stdin loop in `main.ts` reads wake envelopes one per line and dispatches each to `worker.handleWake()`. Three worker implementations ship today: `AnthropicAgentWorker` (wraps `AnthropicLlmClient` driving `@anthropic-ai/claude-agent-sdk`), `LangGraphAgentWorker` (a prebuilt `createReactAgent` over `@langchain/mcp-adapters`, holding a bounded in-process `BaseMessage[]` capped at 40 for within-container context persistence), and `PiAgentWorker` (embeds the Pi SDK as a general coding-agent runtime with Team Room mail tools and coding tools).

**Runs inside each agent container**, not on the host. Baked into each agent image at build time via the agent's `Dockerfile` (`COPY dist/agent-runtime /app/agent-runtime`). The daemon treats this code as opaque beyond the stdin/stdout JSONL contract in spec §9 — this module's implementation details never leak to the host side. The container contract is language-agnostic, so a future agent could use a Python-based runtime instead.

## Files

- `main.ts` — container entry. Reads stdin wake envelopes one per line, delegates to `worker.handleWake(envelope)`. Errors per-envelope are logged to stderr; the loop continues.
- `worker.ts` — `AgentWorker` interface + `WakeEnvelope` type + `buildWorker()` factory keyed on `TEAMROOM_RUNTIME` with a backward-compatible `TEAMROOM_PROVIDER` fallback. `anthropic` → `AnthropicAgentWorker`; `langgraph` → `LangGraphAgentWorker`; `pi` → `PiAgentWorker`.
- `anthropic-worker.ts` — wraps `AnthropicLlmClient`; each wake reads AGENTS.md as system prompt, sends a canned `WAKE_PROMPT`, pipes LLM text to stderr. Claude-agent-sdk handles the tool-call loop internally.
- `anthropic-llm-client.ts` — SDK shim around `@anthropic-ai/claude-agent-sdk`. Proxied via `ANTHROPIC_BASE_URL`; session resume via the sidecar under `/store`.
- `langgraph-worker.ts` — wraps LangGraph's prebuilt `createReactAgent` + `@langchain/mcp-adapters` MCP client pointed at the daemon's mail MCP. Holds a bounded `messages: BaseMessage[]` (cap 40, trimmed at HumanMessage boundaries) across wakes for within-container context persistence. Uses `ChatOpenAI` pointed at the daemon proxy URL (OpenAI-compat, routes to LM Studio or Ollama per the proxy adapter). `recursionLimit: 50`, `maxRetries: 2`.
- `pi-worker.ts` — embeds `@earendil-works/pi-coding-agent` SDK. Creates a long-lived Pi session rooted at `/codebase` when mounted, registers Team Room mail tools as Pi extension tools, and configures Pi models to call the daemon model proxy with the container routing token.
- `pi-mail-tools.ts` — Pi-native wrappers around the existing daemon mail MCP HTTP endpoint (`mail_list`, `mail_get`, `mail_send`, `mail_reply`, `mail_mark_read`, `mail_archive`, `mail_delete`).
- `pi-model.ts` — builds Pi custom-model configuration that points Anthropic/OpenAI-compatible Pi providers at Team Room's model proxy instead of direct upstream credentials.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** `@anthropic-ai/claude-agent-sdk`, `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`, `@langchain/mcp-adapters` npm packages, Node `fs` (for the writable `/store` mount and `/AGENTS.md`).
- **Used by:** the container `ENTRYPOINT` in each agent's `Dockerfile`. Not imported by any other `src/` module — the process boundary is strict.
- **Host-side counterpart:** [agent-config/README.md](../agent-config/README.md) — the loader that prepares what this runtime needs at spawn time.
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 container contract, §3 language-agnostic contract decision.
- **Memory:** `project_teamroom_langgraph_direction` — LangGraph is now the present shape for non-Anthropic workers, not a future direction.
