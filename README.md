# Team Room

A multi-agent harness modeled after a software delivery team.

> **AI assistants working here:** read [`AGENTS.md`](AGENTS.md) first. It covers the reading order, working practices, and the `## Related` convention used across module READMEs to navigate the codebase.

## Current state

Milestone 1 — "One agent that works." A single hand-configured agent (`studio-assistant`) runs in a fresh Docker container per turn. Terminal-only channel. No memory, no inter-agent messaging, no scheduling — those arrive in later milestones.

For M1 the agent calls a local LM Studio model via an OpenAI-compatible endpoint; a model proxy lands in M2 that generalises this to Anthropic, OpenAI, and other backends.

- As-built: [`docs/as-built/2026-04-18-teamroom-m1.md`](docs/as-built/2026-04-18-teamroom-m1.md) — what shipped, key decisions, known debts.
- Practices: [`docs/ways-of-working.md`](docs/ways-of-working.md)
- Retro: [`docs/retros/2026-04-18-m1.md`](docs/retros/2026-04-18-m1.md)

## Install the CLI

Prerequisites: Node.js 20+, Docker Desktop running, LM Studio running locally with a model loaded, and a directory on your `PATH` that you control (e.g. `~/bin`).

```bash
# 1. Dependencies
npm install

# 2. Configure secrets
cp .env.example .env
# edit .env and set LM_STUDIO_API_TOKEN to your LM Studio token

# 3. Build the CLI
npm run build

# 4. Install the teamroom binary into a PATH directory you choose.
#    The script only writes into that directory — it does NOT modify your shell
#    config or PATH. Make sure the directory is already on your PATH.
npm run install-cli -- ~/bin
#    (use --force if ~/bin/teamroom already exists and you want to overwrite it)

# 5. Verify
teamroom status
```

## Day-to-day use

```bash
# One-time per model/agent change: rebuild the agent image
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .

# Three terminals
teamroom serve                   # daemon (foreground — Ctrl+C to stop)
teamroom tail                    # stream replies
teamroom send "hello"            # queue an inbound message
teamroom status                  # daemon + turn counts
```

If the CLI code changes, rerun `npm run build` — the symlink points at `dist/cli/main.js` so rebuilds take effect without re-running `install-cli`.

## Smoke test

End-to-end sanity check against real Docker + real LM Studio:

```bash
./scripts/smoke-test.sh
```

Pass = "hello back" in the output. See `docs/runbooks/smoke-test.md` for preconditions and troubleshooting.

## Layout

- `src/` — daemon, CLI, agent-runtime shim. See [`src/README.md`](src/README.md) for the module index.
- `agents/<name>/` — per-agent folder (`AGENTS.md`, `agent.yaml`, `Dockerfile`, `store/`).
- `data/` — runtime state (gitignored): SQLite DB, logs, bus events.
- `docs/` — specs, plans, retros, runbooks, `ways-of-working.md`, `tabled.md`.

Module orientation: start at [`src/README.md`](src/README.md) and follow the `## Related` links.
