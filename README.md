# Team Room

A multi-agent harness modeled after a software delivery team.

> **AI assistants working here:** read [`AGENTS.md`](AGENTS.md) first. It covers the reading order, working practices, and the `## Related` convention used across module READMEs to navigate the codebase.

## Current state

Milestone 5 shipped the LangGraph runtime for local/OpenAI-compatible agents, filesystem MCP access, and LM Studio/Ollama adapter consolidation. This branch extends that shape with a Bun-first runtime/tooling path and a Pi SDK based general coding teammate, `pi-coder`, while preserving Team Room's central model-proxy credential routing. Agents communicate through the mail substrate (dispatcher -> session-management -> MCP/tools); `chat`, `send`, `inbox`, and `thread` are the main CLI surfaces. See [`docs/runbooks/anthropic-auth.md`](docs/runbooks/anthropic-auth.md) for credential setup.

- Latest as-built: [`docs/as-built/2026-05-17-bun-runtime-and-pi-coder.md`](docs/as-built/2026-05-17-bun-runtime-and-pi-coder.md).
- Practices: [`docs/ways-of-working.md`](docs/ways-of-working.md)
- Retro: [`docs/retros/2026-04-18-m1.md`](docs/retros/2026-04-18-m1.md) (M1)

## Install the CLI

Prerequisites: Bun 1.3+, Docker Desktop running, LM Studio running locally with a model loaded, Anthropic credentials discoverable (Claude Code OAuth or `ANTHROPIC_API_KEY` — see [`docs/runbooks/anthropic-auth.md`](docs/runbooks/anthropic-auth.md)), and a directory on your `PATH` that you control (e.g. `~/bin`). If you want to run `pi-coder`, also set `OPENAI_TOKEN` for the hosted OpenAI provider.

```bash
# 1. Dependencies
bun install

# 2. Configure secrets
cp .env.example .env
# edit .env and set LM_STUDIO_API_TOKEN
# set OPENAI_TOKEN too if you plan to use pi-coder

# 3. Install the teamroom binary into a PATH directory you choose.
#    The script only writes into that directory — it does NOT modify your shell
#    config or PATH. Make sure the directory is already on your PATH.
bun scripts/install-cli.ts ~/bin --force
#    (use --force if ~/bin/teamroom already exists and you want to overwrite it)

# 4. Verify
teamroom --help
```

## Day-to-day use

```bash
# One-time per model/agent change: rebuild each agent's image
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .
docker build -t teamroom-agent-claude-assistant:latest -f agents/claude-assistant/Dockerfile .
docker build -t teamroom-agent-pi-coder:latest -f agents/pi-coder/Dockerfile .

# Three terminals
teamroom serve                                          # daemon (foreground — Ctrl+C to stop)
teamroom chat studio-assistant                          # interactive REPL with local LM Studio agent
teamroom chat claude-assistant                          # interactive REPL with real Anthropic agent
teamroom chat pi-coder                                  # interactive REPL with Pi SDK coding agent
teamroom send studio-assistant "hello"                  # fire-and-forget send
teamroom inbox studio-assistant                         # read agent's inbox
teamroom status                                         # daemon liveness
```

If the CLI code changes, no rebuild is needed — the installed symlink points at `src/cli/main.ts`, so Bun executes the current source directly.

## Smoke test

End-to-end sanity check against real Docker + real LM Studio:

```bash
./scripts/smoke-test.sh
```

Pass = both agents respond AND both providers' `model.call.completed` spans show up in the daemon log. See [`docs/runbooks/smoke-test.md`](docs/runbooks/smoke-test.md) for preconditions and troubleshooting.

## Layout

- `src/` — daemon, CLI, agent-runtime shim. See [`src/README.md`](src/README.md) for the module index.
- `agents/<name>/` — per-agent folder (`AGENTS.md`, `agent.yaml`, `Dockerfile`, `store/`).
- `data/` — runtime state (gitignored): SQLite DB, logs, bus events.
- `docs/` — specs, plans, retros, runbooks, `ways-of-working.md`, `tabled.md`.

Module orientation: start at [`src/README.md`](src/README.md) and follow the `## Related` links.
