# `agents/` — per-agent folders

Each subdirectory is one Team Room agent. The daemon discovers agents at startup by scanning this directory; every folder with a valid `agent.yaml` becomes a registered agent.

This README is **for repo readers** (humans / AI assistants working on Team Room itself) — it documents inventory, conventions, and the per-agent file-structure differences. It is **not mounted into any container** and the agents themselves don't see it.

## Agent inventory (post-persona-realignment)

| Agent | Folder | Runtime | Provider | Role |
|---|---|---|---|---|
| [**Micah**](micah/) | `micah/` | **Pi** | OpenRouter | Coding agent. Implements changes, writes tests, fixes bugs. Renamed from pi-coder. |
| [**Doc**](doc/) | `doc/` | **Pi** | OpenRouter | Health monitor. Runs tests, checks codebase health, announces failures. New. |
| [**Libby**](libby/) | `libby/` | **DeepAgents** | OpenRouter | Librarian. Documents decisions, traces git history, surfaces patterns. New. |
| [**Archie**](archie/) | `archie/` | **DeepAgents** | OpenRouter | Architect. Holds architecture, notices smells, advises on structural decisions. Existing (M6). |

### Runtime summary

| Runtime | Agents | Entrypoint |
|---|---|---|
| **Pi** | Micah, Doc | `src/agent-runtime/main.ts` — Bun/TypeScript, Pi SDK |
| **DeepAgents** | Libby, Archie | `agents/<name>/shim.py` — Python, DeepAgents framework |

### Provider

All agents use **OpenRouter** (`provider: openrouter`) routed through the daemon's model proxy. No other providers are supported after the persona-realignment consolidation.

## Per-agent folder shape

```
agents/<name>/
├── agent.yaml          # name, provider, runtime, model, image_tag, lifecycle
├── AGENTS.md           # mounted writable as /AGENTS.md inside the container
├── Dockerfile          # how to build the agent's image
└── store/              # mounted writable as /store inside the container
    └── .gitkeep        # tracked so the dir exists in fresh clones
```

DeepAgents agents (Libby, Archie) also have:
```
├── shim.py             # Python entrypoint (replaces main.ts)
```

`AGENTS.md` is the per-instance system prompt, read by the worker at each wake. `/store` is the agent's persistent scratch area.

## Shared codebase

`/codebase` is mounted read-write into every agent, representing the team's shared work area. The operator can redirect it to any codebase via `TEAMROOM_CODEBASE_PATH`.

## Onboarding a new agent

See [`docs/runbooks/agent-onboarding.md`](../docs/runbooks/agent-onboarding.md). Short version: copy an existing agent folder, edit `agent.yaml` (name, runtime, model, image_tag), edit `AGENTS.md` for the agent's voice, create a Dockerfile or shim.py, build the image, restart the daemon.

## Related

- **Runbooks:** [agent-onboarding](../docs/runbooks/agent-onboarding.md), [anthropic-auth](../docs/runbooks/anthropic-auth.md) (archived — OpenRouter-only now), [smoke-test](../docs/runbooks/smoke-test.md)
- **Code:** [`src/agent-config/`](../src/agent-config/README.md) (the loader), [`src/agent-runtime/`](../src/agent-runtime/README.md) (what runs inside the container)
