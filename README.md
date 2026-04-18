# Team Room

A multi-agent harness modeled after a software delivery team. See `docs/specs/2026-04-18-teamroom-m1-design.md` for the M1 design and `docs/ways-of-working.md` for how we build this.

## Quick start (M1)

```bash
npm install
npm run build
npm test
```

## Structure

- `src/` — daemon, CLI, agent-runtime
- `agents/<name>/` — per-agent folder (M1: just `assistant/`)
- `data/` — runtime state (gitignored): SQLite DB, logs, bus
- `docs/` — specs, plans, retros, runbooks, ways-of-working

## Milestone 1

Ship the smallest end-to-end slice: terminal message in → one hand-configured agent processes it in a Docker container → reply out via `teamroom tail`. See the spec for details.
