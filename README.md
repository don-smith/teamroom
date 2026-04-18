# Team Room

A multi-agent harness modeled after a software delivery team.

## Current state

Milestone 1 — "One agent that works." A single hand-configured agent (`assistant`) runs in a fresh Docker container per turn. Terminal-only channel. No memory, no inter-agent messaging, no scheduling — those arrive in later milestones.

- Design: `docs/specs/2026-04-18-teamroom-m1-design.md`
- Plan: `docs/plans/2026-04-18-teamroom-m1-plan.md`
- Practices: `docs/ways-of-working.md`

## Quick start

```bash
npm install
npm run build
npm test                                      # unit + integration tests (fast)
./scripts/smoke-test.sh                       # end-to-end; requires Docker + ANTHROPIC_API_KEY
```

## Day-to-day use

```bash
export ANTHROPIC_API_KEY=...
npm run build
docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .

node dist/cli/main.js serve   &       # daemon in background
node dist/cli/main.js tail            # stream replies
node dist/cli/main.js send "hello"    # send a message (from another terminal)
node dist/cli/main.js status          # daemon + turn stats
```

## Layout

- `src/` — daemon, CLI, agent-runtime shim.
- `agents/<name>/` — per-agent folder (AGENTS.md, agent.yaml, Dockerfile, store/).
- `data/` — runtime state (gitignored).
- `docs/` — specs, plans, retros, runbooks, ways-of-working, tabled.

Module orientation: start at `src/README.md`.
