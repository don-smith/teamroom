# `cli/` — `teamroom` binary

Four short-lived subcommands (`serve`, `send`, `tail`, `status`) plus the commander-driven entry point. The CLI layer is **intentionally thin**: each command parses its arguments and delegates to a service function that lives behind a DI-friendly service elsewhere in `src/`. Business logic does not live here — a CLI command is mostly argv parsing plus a single call.

**Runs on the host**, as separate short-lived processes that talk to the daemon indirectly (via SQLite writes and the `NotifyBus`). `serve` is the exception: it spawns the long-running daemon in-process.

## Files

- `main.ts` — entrypoint; wires the four subcommands via `commander`.
- `serve.ts` — loads `.env`, calls `startDaemon()`, parks the process and wires SIGINT/SIGTERM to graceful shutdown.
- `send.ts` — `sendToDb(opts)` writes an inbound message row. Optional `agentName` selects which `agents/<name>/` folder to target (defaults to alphabetically first; `--agent` CLI flag exposes this). Works with daemon down (queues for later processing).
- `tail.ts` — `tailRun(args)` subscribes to `message.outbound` events on the bus, fetches bodies from the DB, renders to stdout.
- `status.ts` — queries the DB for per-status turn counts; prints daemon liveness via PID file probe.
- `send.test.ts`, `tail.test.ts` — co-located unit tests. `serve.ts`, `status.ts`, `main.ts` have no direct tests (thin wiring).

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [env/env-file.ts](../env/env-file.ts), [agent-config/README.md](../agent-config/README.md), [daemon/README.md](../daemon/README.md).
- **Used by:** `package.json` `bin` entry (`teamroom` → `dist/cli/main.js`).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §1 exit criteria, §2 processes and boundaries (CLI subcommands).
