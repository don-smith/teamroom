# Team Room

A multi-agent harness modeled after a software delivery team — now focused on enabling personal myflow-driven development workflows.

> **AI assistants working here:** read [`AGENTS.md`](AGENTS.md) first. It covers the reading order, working practices, and the `## Related` convention used across module READMEs to navigate the codebase.

## Current state

Post-persona-realignment: Team Room has four named agents — **Micah** (coder, Pi), **Doc** (health monitor, Pi), **Libby** (librarian, DeepAgents), **Archie** (architect, DeepAgents) — all routing through OpenRouter as the sole provider. The `anthropic` and `langgraph` agent runtimes have been removed. Agents communicate through the mail substrate (dispatcher -> session-management -> MCP/tools); `chat`, `send`, `inbox`, and `thread` are the main CLI surfaces.

## Install the CLI

Prerequisites: Bun 1.3+, Docker Desktop running, and a directory on your `PATH` that you control (e.g. `~/bin`).

> **Submodules.** Team Room vendors DeepAgents source under `vendor/`. When cloning fresh, use `git clone --recurse-submodules <url>`. If you already cloned without, run `git submodule update --init --recursive` once.

```bash
# 1. Dependencies
bun install

# 2. Configure secrets
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY

# 3. Install the teamroom binary
bun scripts/install-cli.ts ~/bin --force

# 4. Verify
teamroom --help
```
```

## Day-to-day use

```bash
# One-time per agent: build each agent's Docker image
docker build -t teamroom-agent-archie:latest -f agents/archie/Dockerfile .
docker build -t teamroom-agent-micah:latest -f agents/micah/Dockerfile .
docker build -t teamroom-agent-doc:latest -f agents/doc/Dockerfile .
docker build -t teamroom-agent-libby:latest -f agents/libby/Dockerfile .

# Three terminals
teamroom serve                                          # daemon (foreground — Ctrl+C to stop)
teamroom chat micah                                     # interactive REPL with Micah the coder
teamroom chat archie                                    # interactive REPL with Archie the architect
teamroom send micah "run npm test and report"            # fire-and-forget send
teamroom inbox micah                                    # read agent's inbox
teamroom status                                         # daemon liveness
```

If the CLI code changes, no rebuild is needed — the installed symlink points at `src/cli/main.ts`, so Bun executes the current source directly.

## Layout

- `src/` — daemon, CLI, agent-runtime shim. See [`src/README.md`](src/README.md) for the module index.
- `agents/<name>/` — per-agent folder (`AGENTS.md`, `agent.yaml`, `Dockerfile`, `store/`, `shim.py` for DeepAgents agents).
- `data/` — runtime state (gitignored): SQLite DB, logs, bus events.
- `docs/` — specs, plans, retros, runbooks, `ways-of-working.md`, `tabled.md`.

Module orientation: start at [`src/README.md`](src/README.md) and follow the `## Related` links.
