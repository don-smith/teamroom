# `cli/` — `teamroom` binary

Six short-lived subcommands (`serve`, `send`, `chat`, `inbox`, `thread`, `status`) plus the commander-driven entry point. The CLI layer is **intentionally thin**: each command parses its arguments and delegates to a service function elsewhere in `src/`. Business logic does not live here — a CLI command is mostly argv parsing plus a single call.

**Runs on the host**, as separate short-lived processes. `chat` holds a WebSocket open for interactive use. `serve` is the exception: it spawns the long-running daemon in-process. Commands that need to reach the daemon discover its ports via the `ports/` file convention (see `ports.ts`).

**Direct execution.** After editing `src/**/*.ts`, rerun the CLI command you want to exercise — the `bin` entry in `package.json` points at `src/cli/main.ts`, so Bun picks up source changes without a rebuild.

## Files

- `main.ts` — entrypoint; wires the six subcommands via `commander`.
- `serve.ts` — loads `.env`, calls `startDaemon()`, parks the process and wires SIGINT/SIGTERM to graceful shutdown.
- `send.ts` — `send(opts)` fires a single message to an agent via the chat WebSocket and exits. Requires the daemon to be running.
- `chat.ts` — `runChat(args)` opens an interactive REPL over the chat WebSocket: reads lines from stdin, sends each as a message, prints replies to stdout.
- `inbox.ts` — `runInbox(args)` queries the mail WebSocket for an agent's inbox and renders to stdout.
- `thread.ts` — `runThread(args)` queries the mail WebSocket for a thread by ID and renders to stdout.
- `status.ts` — queries the DB for per-status turn counts; prints daemon liveness via PID file probe.
- `ports.ts` — `readPortFile` / `writePortFile` / `deletePortFile`; `ports/` folder convention for daemon-opened port files.
- `query-client.ts` — shared WebSocket client used by `inbox` and `thread`.
- `*.test.ts` — co-located unit tests.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [env/env-file.ts](../env/env-file.ts), [agent-config/README.md](../agent-config/README.md), [daemon/README.md](../daemon/README.md).
- **Used by:** `package.json` `bin` entry (`teamroom` → `src/cli/main.ts`).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §1 exit criteria, §2 processes and boundaries (CLI subcommands). M4.5 as-built lands at milestone close.
