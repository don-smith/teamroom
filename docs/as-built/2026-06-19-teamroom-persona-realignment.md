# Persona Realignment — 4 core agents, 2 runtimes, OpenRouter-only

## Quick Reference
- **Date:** 2026-06-19
- **Key files:** `src/types.ts`, `src/agent-config/agent-config.ts`, `src/agent-runtime/{worker,pi-worker,pi-model}.ts`, `src/modules/model-proxy/model-proxy.ts`, `src/daemon/daemon.ts`, `agents/{archie,doc,libby,micah}/`, `.env.example`
- **Key concepts:** runtime-consolidation, provider-consolidation, agent-roster, persona-realignment, openrouter-only
- **One-line summary:** Consolidated Team Room from 6 agents across 4 runtimes and 5 providers to 4 named agents (Doc, Micah, Libby, Archie) on 2 runtimes (Pi, DeepAgents) through a single provider backbone (OpenRouter).

## How It Works Now

### Agent roster

Team Room has four agents, each in its own folder under `agents/`:

| Agent | Folder | Runtime | Persona |
|---|---|---|---|
| **Micah** | `agents/micah/` | Pi | Coder — implements changes, writes tests, fixes bugs. Renamed from pi-coder. |
| **Doc** | `agents/doc/` | Pi | Health monitor — runs tests, checks for failures, keeps the team informed. New. |
| **Libby** | `agents/libby/` | DeepAgents | Librarian — maintains team knowledge, documents decisions, traces git history. New. |
| **Archie** | `agents/archie/` | DeepAgents | Architect — tracks project architecture, notices smells, suggests improvements. Existing, AGENTS.md updated. |

### Type system

The shared types in `src/types.ts` define:

- `Provider = "openrouter"` — single provider backbone
- `AgentRuntime = "pi" | "deepagents"` — two supported runtimes

### Agent config validation

`src/agent-config/agent-config.ts` enforces:

- `provider` must be `"openrouter"` — no other values accepted
- `runtime` is always explicit (no inference) — must be `"pi"` or `"deepagents"`
- Both runtimes accept OpenRouter; no runtime-provider restriction pairs

### Worker dispatch

`src/agent-runtime/worker.ts` requires `TEAMROOM_RUNTIME` env var directly (no provider fallback). `buildWorker()` handles only `"pi"`; `"deepagents"` throws with a direction to the shim.py entrypoint.

`src/agent-runtime/pi-worker.ts` accepts `"openrouter"` as the sole valid provider. `src/agent-runtime/pi-model.ts` uses an OpenAI-compatible code path with `teamroom-openrouter` prefix for OpenRouter.

### Model proxy

`src/modules/model-proxy/model-proxy.ts` composes only the OpenRouter adapter. The anthropic, lm-studio, ollama, and openai adapters and their test files have been removed. The OAuth cache for Anthropic is also removed.

### Daemon

`src/daemon/daemon.ts` — `DaemonOptions` simplified to a single `openrouter` config field. The `AnthropicCreds` type and `lmStudio`, `ollama`, `openai`, `anthropic` fields removed.

### Build spec

`src/agent-spec/build-spec.ts` no longer sets `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` env vars on containers.

### Environment

`.env.example` has been simplified to a single credential: `OPENROUTER_API_KEY`.

## Key Decisions

### Narrow Provider to OpenRouter only

- **What:** `Provider = "openrouter"` — removed anthropic, lm-studio, ollama, openai.
- **Why:** All agents use OpenRouter as their provider backbone. Anthropic direct access was only used by claude-assistant (removed). LM Studio and Ollama were used by studio-assistant (removed). OpenAI was used by pi-coder's original config (migrated to OpenRouter).
- **Regression risk:** low — these providers have no remaining consumers.

### Narrow AgentRuntime to pi and deepagents only

- **What:** `AgentRuntime = "pi" | "deepagents"` — removed anthropic and langgraph.
- **Why:** Anthropic runtime was used by claude-assistant (removed). LangGraph runtime was used by studio-assistant (removed). Pi and DeepAgents are the two remaining runtimes, matching the desired two-runtime production shape.
- **Regression risk:** low — removed runtimes have no remaining consumers.

### Require explicit runtime in agent.yaml

- **What:** `parseRuntime()` throws when runtime is omitted — no inference from provider.
- **Why:** With one provider, inferring default runtime from provider no longer makes sense. Every agent must declare its runtime explicitly.
- **Regression risk:** low — all four checked-in agents declare explicit runtime.

### Remove inferRuntime() entirely

- **What:** The `inferRuntime()` function was removed from agent-config.ts.
- **Why:** Only one provider remains; no meaningful inference can be performed. Explicit runtime is the cleaner contract.
- **Regression risk:** low — no callers remain.

### Micah replaces pi-coder

- **What:** Renamed `agents/pi-coder/` to `agents/micah/`, updated identity to "coder" persona.
- **Why:** Persona-named folders are the desired convention (archie, doc, libby, micah). Pi-coder was an implementation name, not a team-role name.
- **Regression risk:** low — no external consumers reference agent folder names.

### Doc and Libby created from existing patterns

- **What:** Doc uses the Pi Dockerfile pattern (from micah/formerly pi-coder). Libby uses the DeepAgents Dockerfile pattern (from archie). Both have persona-specific AGENTS.md with myflow awareness.
- **Why:** Establish the 4-agent team roster. Each agent has a distinct role that can be exercised through the mail substrate.
- **Regression risk:** low — new agents; no existing consumers.

## Background Context

Before this realignment, Team Room had grown to 6 agent folders (studio-assistant, claude-assistant, claude-researcher, pi-coder, archie, assistant) spanning 4 runtimes (anthropic, langgraph, pi, deepagents) and 5 providers (anthropic, lm-studio, ollama, openai, openrouter). This complexity reflected the project's experimental phase — proving that multiple runtimes and providers could coexist under a common harness.

The realignment marks a shift from "prove the concept" to "operate the team." The 4 named agents (Doc, Micah, Libby, Archie) fill concrete team roles on two proven runtimes through a single provider, matching the desired production shape discovered during M6.