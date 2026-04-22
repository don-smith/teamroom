# `agents/` — per-agent folders

Each subdirectory is one Team Room agent. The daemon discovers agents at startup by scanning this directory; every folder with a valid `agent.yaml` becomes a registered agent.

This README is **for repo readers** (humans / AI assistants working on Team Room itself) — it documents inventory, conventions, and the per-agent file-structure differences. It is **not mounted into any container** and the agents themselves don't see it.

## Agent inventory (M5)

| Agent | Provider | Runtime SDK in container | Notes |
|---|---|---|---|
| [`studio-assistant/`](studio-assistant/) | `lm-studio` | LangGraph (`@langchain/langgraph` + `@langchain/mcp-adapters`) over `ChatOpenAI` | Local Gemma-4 via the LM Studio proxy. Ollama-ready — same runtime, swap the provider. |
| [`claude-assistant/`](claude-assistant/) | `anthropic` | `@anthropic-ai/claude-agent-sdk` (spawns Claude Code CLI as a subprocess) | Coding-focused teammate. OAuth via the daemon proxy. |
| [`claude-researcher/`](claude-researcher/) | `anthropic` | `@anthropic-ai/claude-agent-sdk` | Research-focused teammate — reads deeply, reasons carefully, surfaces patterns. Consulted in-thread by other agents. |

## Per-agent folder shape

Common to every agent (loaded by `src/agent-config/`):

```
agents/<name>/
├── agent.yaml          # name, provider, model, image_tag — required
├── AGENTS.md           # mounted writable as /AGENTS.md inside the container
├── Dockerfile          # how to build the agent's image
└── store/              # mounted writable as /store inside the container
    └── .gitkeep        # tracked so the dir exists in fresh clones
```

`AGENTS.md` is the per-instance system prompt, read by the worker at each wake. `/store` is the agent's persistent scratch area — the only writable location across turns (the rest of the container is `--rm`-ephemeral).

## Why `claude-assistant/store/` has more files than `studio-assistant/store/`

The claude-agent-sdk spawns the Claude Code CLI as a subprocess, which is stateful — it persists sessions, config, backups, and an auto-memory subsystem. None of that exists for studio-assistant because the LangGraph worker holds its conversation state in-process (`BaseMessage[]`, cap 40, trimmed at HumanMessage boundaries) and discards it at container teardown.

Concretely, after a few turns you'll see (in `claude-assistant/store/`):

| File / dir | Created by | Purpose |
|---|---|---|
| `anthropic-session.txt` | `AnthropicLlmClient` | Sidecar holding the SDK's most recent `session_id`. Read at start of each wake, passed as `resume:`, rewritten after. |
| `claude-sdk/` | The Claude Code CLI subprocess | The CLI's state directory (`CLAUDE_CONFIG_DIR`). Pinned here so its session JSONL survives `--rm`. Contains config files, session backups, and the auto-memory subsystem. |
| `claude-sdk/projects/-store-work/<uuid>.jsonl` | CLI | The actual session file the SDK reads on `resume:` — the full conversation as the SDK sees it (assistant turns, tool calls, etc.). |
| `work/` | We pass it as `cwd` to `query()` | The SDK groups sessions per-cwd. Pinning to a stable empty dir means resume can always find prior sessions. |

`studio-assistant/store/` stays empty beyond `.gitkeep` — no SDK-side persistence to land on disk.

## Tools / read-write access

- **claude-assistant / claude-researcher:** `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep` via the claude-agent-sdk's `allowedTools`, plus the mail-MCP tools (`mcp__mail__mail.*`) wired in via the daemon's mail MCP server.
- **studio-assistant:** mail-MCP tools auto-wired by `@langchain/mcp-adapters`. No filesystem tools — not needed for the M5 scope.

## Shared codebase

`/codebase` is mounted read-write into every agent, representing the team's shared work area. The operator can redirect it to any codebase via the `TEAMROOM_CODEBASE_PATH` env var. Agents with filesystem tools can modify it; agents without them still see it passively.

## Onboarding a new agent

See [`docs/runbooks/agent-onboarding.md`](../docs/runbooks/agent-onboarding.md). Short version: copy an existing agent folder, edit `agent.yaml` (name, provider, model, image_tag), edit `AGENTS.md` for the agent's voice, edit `Dockerfile` if dependencies differ, build the image, restart the daemon. The naming convention from M2 onwards is `<provider-or-model>-<role>` (so the backing model is obvious from the name).

## Related

- **Runbooks:** [agent-onboarding](../docs/runbooks/agent-onboarding.md), [anthropic-auth](../docs/runbooks/anthropic-auth.md), [smoke-test](../docs/runbooks/smoke-test.md)
- **Code:** [`src/agent-config/`](../src/agent-config/README.md) (the loader), [`src/agent-runtime/`](../src/agent-runtime/README.md) (what runs inside the container)
- **As-built:** [M4.5](../docs/as-built/2026-04-22-teamroom-m4.5.md) — channel architecture + MCP-SDK retrofit (the immediate predecessor to M5's LangGraph migration).
