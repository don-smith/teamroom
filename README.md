# Team Room

A multi-agent harness modeled after a software delivery team.

> **AI assistants working here:** read [`AGENTS.md`](AGENTS.md) first. It covers the reading order, working practices, and the `## Related` convention used across module READMEs to navigate the codebase.

## Current state

Milestone 1 — "One agent that works." A single hand-configured agent (`assistant`) runs in a fresh Docker container per turn. Terminal-only channel. No memory, no inter-agent messaging, no scheduling — those arrive in later milestones.

For M1 the agent calls a local LM Studio model via an OpenAI-compatible endpoint; a model proxy lands in M2 that generalises this to Anthropic, OpenAI, and other backends.

- As-built: [`docs/as-built/2026-04-18-teamroom-m1.md`](docs/as-built/2026-04-18-teamroom-m1.md) — what shipped, key decisions, known debts.
- Practices: [`docs/ways-of-working.md`](docs/ways-of-working.md)
- Retro: [`docs/retros/2026-04-18-m1.md`](docs/retros/2026-04-18-m1.md)

## Quick start

Prerequisites: Node.js 20+, Docker Desktop, LM Studio running locally with a model loaded.

```bash
# Once
npm install
echo 'LM_STUDIO_API_TOKEN=<your-lm-studio-token>' > .env   # .env is gitignored

# Every time
npm run build
npm test                                                   # unit + integration tests (fast)
./scripts/smoke-test.sh                                    # end-to-end via Docker + LM Studio
```

## Day-to-day use

```bash
npm run build
docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .

node dist/cli/main.js serve   &       # daemon in background
node dist/cli/main.js tail            # stream replies
node dist/cli/main.js send "hello"    # send a message (from another terminal)
node dist/cli/main.js status          # daemon + turn stats
```

## Layout

- `src/` — daemon, CLI, agent-runtime shim. See [`src/README.md`](src/README.md) for the module index.
- `agents/<name>/` — per-agent folder (`AGENTS.md`, `agent.yaml`, `Dockerfile`, `store/`).
- `data/` — runtime state (gitignored): SQLite DB, logs, bus events.
- `docs/` — specs, plans, retros, runbooks, `ways-of-working.md`, `tabled.md`.

Module orientation: start at [`src/README.md`](src/README.md) and follow the `## Related` links.
