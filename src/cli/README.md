# `cli/` — `teamroom` binary

Nine short-lived subcommands (`serve`, `send`, `chat`, `inbox`, `thread`, `status`, `repo init`, `repo list`, `repo remove`) plus the commander-driven entry point. The CLI layer is **intentionally thin**: each command parses its arguments and delegates to a service function elsewhere in `src/`. Business logic does not live here — a CLI command is mostly argv parsing plus a single call.

**Runs on the host**, as separate short-lived processes. `chat` holds a WebSocket open for interactive use. `serve` spawns a long-running daemon in-process — either the meta-process (default), a per-repo daemon (`--repo <name>`), or the legacy monolithic daemon. Commands that need to reach a daemon discover its ports via the `ports/` file convention (see `ports.ts`).

**Direct execution.** After editing `src/**/*.ts`, rerun the CLI command you want to exercise — the `bin` entry in `package.json` points at `src/cli/main.ts`, so Bun picks up source changes without a rebuild.

## Files

- `main.ts` — entrypoint; wires the nine subcommands via `commander`.
- `serve.ts` — loads `.env`, calls `startDaemon()`, parks the process and wires SIGINT/SIGTERM to graceful shutdown.
- `serve-meta.ts` — loads `.env`, calls `startMetaDaemon()`, parks the process (meta-process entry point).
- `serve-repo.ts` — loads `.env`, calls `startRepoDaemon()`, parks the process (per-repo daemon entry point).
- `send.ts` — `send(opts)` fires a single message to an agent via the chat WebSocket. `sendViaMeta()` routes through the meta-process chat WS when `TEAMROOM_REPO` is set.
- `chat.ts` — `runChat(args)` opens an interactive REPL over the chat WebSocket. `runChatViaMeta()` routes through the meta-process when `TEAMROOM_REPO` is set.
- `inbox.ts` — `runInbox(args)` queries the mail WebSocket for an agent's inbox and renders to stdout.
- `thread.ts` — `runThread(args)` queries the mail WebSocket for a thread by ID and renders to stdout.
- `status.ts` — queries the DB for per-status turn counts; prints daemon liveness via PID file probe.
- `repo-init.ts` — registers a repo in `~/.teamroom/repos.yaml` and creates per-repo directories.
- `repo-list.ts` — lists registered repos with running/not-running status.
- `repo-remove.ts` — unregisters a repo and optionally archives its data.
- `ports.ts` — `readPortFile` / `writePortFile` / `deletePortFile`; `ports/` folder convention for daemon-opened port files.
- `query-client.ts` — shared WebSocket client used by `inbox` and `thread`.
- `*.test.ts` — co-located unit tests.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [env/env-file.ts](../env/env-file.ts), [agent-config/README.md](../agent-config/README.md), [daemon/README.md](../daemon/README.md).
- **Used by:** `package.json` `bin` entry (`teamroom` → `src/cli/main.ts`).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §1 exit criteria, §2 processes and boundaries (CLI subcommands). M4.5 as-built lands at milestone close.
