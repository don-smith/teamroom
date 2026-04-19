# `agents/` — per-agent folders

Each subdirectory is one Team Room agent. The daemon discovers agents at startup by scanning this directory; every folder with a valid `agent.yaml` becomes a registered agent the CLI can `--agent` into.

This README is **for repo readers** (humans / AI assistants working on Team Room itself) — it documents inventory, conventions, and the per-agent file-structure differences. It is **not mounted into any container** and the agents themselves don't see it.

## Agent inventory (M2)

| Agent | Provider | SDK in container | Notes |
|---|---|---|---|
| [`studio-assistant/`](studio-assistant/) | `lm-studio` | `openai` (vanilla, OpenAI-compatible HTTP) | Talks to local LM Studio. Stateless HTTP — no SDK-side persistence needed. |
| [`claude-assistant/`](claude-assistant/) | `anthropic` | `@anthropic-ai/claude-agent-sdk` (spawns Claude Code CLI as a subprocess) | Talks to real Anthropic via subscription OAuth. The CLI subprocess is stateful — its own session/config files live alongside Team Room's. |

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

`AGENTS.md` is the agent's per-instance system-prompt-extender. `store/` is the agent's persistent workspace — its only writable location across turns (the rest of the container is `--rm`-ephemeral).

## Why `claude-assistant/store/` has more files than `studio-assistant/store/`

After the M2 OAuth pivot, claude-assistant uses `@anthropic-ai/claude-agent-sdk`, which works by spawning the Claude Code CLI as a subprocess. That CLI is stateful — it persists sessions, config, backups, even an auto-memory subsystem. None of that exists for studio-assistant because the OpenAI SDK is stateless HTTP.

Concretely, after a few turns you'll see (in `claude-assistant/store/`):

| File / dir | Created by | Purpose | SDK-specific? |
|---|---|---|---|
| `conversation.jsonl` | Team Room (`runtime.ts`) | Portable Team Room–side log of the conversation. Loaded as `messages[]` and passed to `client.createMessage()`. | No — used by both providers. |
| `anthropic-session.txt` | `AnthropicLlmClient` | Sidecar holding the SDK's most recent `session_id`. Read at start of each turn, passed as `resume:`, rewritten after. | Yes — meaningless without the agent SDK. |
| `claude-sdk/` | The Claude Code CLI subprocess | The CLI's state directory (`CLAUDE_CONFIG_DIR`). We point it here so its session JSONL survives `--rm`. Contains config files, session backups, and the auto-memory subsystem. | Yes — anything the CLI writes. |
| `claude-sdk/projects/-store-work/<uuid>.jsonl` | CLI | The actual session file the SDK reads on `resume:`. The full conversation as the SDK sees it (assistant turns, tool calls, etc.). | Yes. |
| `work/` | We pass it as `cwd` to `query()` | The SDK groups sessions per-cwd. Pinning to a stable empty dir means resume can always find prior sessions. | Yes — only because the SDK requires a cwd. |

`studio-assistant/store/` only has `conversation.jsonl` because there's nothing else to persist — the OpenAI client is stateless HTTP and `runtime.ts` owns the whole conversation in that one file.

## Two sources of truth for claude-assistant — intentional

For claude-assistant, conversation history lives in **two** places:

- `store/conversation.jsonl` — Team Room's portable log, written by `runtime.ts` after every turn.
- `store/claude-sdk/projects/.../<uuid>.jsonl` — the SDK's authoritative session, replayed on `resume:`.

The SDK file is what Anthropic actually sees on each turn (we only send the latest user message; the SDK fills in history from its own session). The `conversation.jsonl` file is **kept as an audit log** that survives independently of the SDK choice — if a future agent switches SDKs, swaps to a different provider, or we want to inspect/export the conversation outside of Claude Code's machinery, the JSONL is what's portable.

This is duplicate-by-design, not an oversight.

## Tools / read-write access (M2 → M3)

Both agents currently have **no tool access**. For claude-assistant this is `allowedTools: []` in `AnthropicLlmClient`; the equivalent for studio-assistant is implicit (the OpenAI client doesn't run tool loops). Files placed in `store/` are persisted but the agent can't see or modify them.

M3 enables tools for claude-assistant only: it now has `Read`, `Edit`, `Write`, `Bash`, `Glob`, and `Grep` to explore and modify `/codebase`. Studio-assistant remains toolless; the tools mount infrastructure is ready for future work.

### M3 capability additions

**Inter-agent messaging:** agents can now DM each other via `{"type":"dm","to":"<name>","body":"..."}` on stdout. Subscriptions in `agent.yaml` define what topics wake an agent; replies to a DM-triggered turn route back as return DMs (not to the original CLI user — this is a known M3 limitation deferred to M4+; see `docs/m3-followups.md §6`).

**Shared codebase:** `/codebase` is mounted read-write into every agent, representing the team's shared work area. The operator can redirect it to any codebase via `TEAMROOM_CODEBASE_PATH` env var. Agents with filesystem tools can modify it; agents without tools still see it passively.

**Tool control:** `agent.yaml` now has an `allowed_tools` field. Claude-assistant lists filesystem tools; studio-assistant has none (yet).

## Onboarding a new agent

See [`docs/runbooks/agent-onboarding.md`](../docs/runbooks/agent-onboarding.md). Short version: copy one of the existing agent folders, edit `agent.yaml` (name, provider, model, image_tag), edit `AGENTS.md` for the agent's voice, edit `Dockerfile` if dependencies differ, build the image, restart the daemon. The naming convention from M2 onwards is `<provider-or-model>-<role>` (so the backing model is obvious from the name).

## Related

- **Spec:** [M2 design — §3.4 agent population](../docs/specs/2026-04-18-m2-model-abstraction-design.md)
- **Runbooks:** [agent-onboarding](../docs/runbooks/agent-onboarding.md), [anthropic-auth](../docs/runbooks/anthropic-auth.md), [smoke-test](../docs/runbooks/smoke-test.md)
- **Code:** [`src/agent-config/`](../src/agent-config/README.md) (the loader), [`src/agent-runtime/`](../src/agent-runtime/README.md) (what runs inside the container)
