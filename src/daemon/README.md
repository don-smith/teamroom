# `daemon/` — the composition roots

The long-running processes that own the DB connections, wire all compose-pattern modules, manage persistent container lifecycle (boot-spawn, respawn, idle timers), and manage the lifecycle of externally-visible ports. Procedural — **no LLM in the hot path**. All intelligence lives in agent containers or the session-management module; the daemon is the boring conveyor belt that keeps them moving.

**Three entry points, two process types:**

- **`startDaemon`** (`daemon.ts`) — the original monolithic daemon (backward compat). Composes all nine modules in-process.
- **`startMetaDaemon`** (`meta-daemon.ts`) — the meta-process. Owns model proxy, chat WebSocket, Telegram gateway, per-repo daemon WS listener, and auto-spawn. No storage, no containers, no session management.
- **`startRepoDaemon`** (`repo-daemon.ts`) — per-repo daemon. Owns storage, messaging, MCP mail, session management, mail query WS. Connects to meta-process WS on startup.
- **`repo-config.ts`** — `repos.yaml` persistence (atomic writes via temp-file + rename), repo config resolution, path constants for `~/.teamroom/` layout.

Invariants: *nothing silent, nothing inconsistent, nothing crashes*. Once a daemon has started it does not die from an unhandled exception — see `safety-nets.ts`.

## Files

- `daemon.ts` — original monolithic composition root. `startDaemon(opts)` wires eight modules and returns a `StartedDaemon` with a `stop()` function.
- `meta-daemon.ts` — meta-process composition root. `startMetaDaemon(opts)` wires model proxy, chat WS, daemon WS listener, and Telegram gateway (when configured). Auto-spawns per-repo daemons on first delivery.
- `repo-daemon.ts` — per-repo daemon composition root. `startRepoDaemon(opts)` composes five modules (observability, storage, messaging, MCP mail, session management) plus mail-MCP + mail query WS servers.
- `repo-config.ts` — `repos.yaml` I/O, `~/.teamroom/` path resolution, `DEFAULT_AGENTS` constant, repo config derivation.
- `safety-nets.ts` — `installSafetyNets(logger)`: global `uncaughtException` / `unhandledRejection` handlers that log fatal and do NOT exit. Boot-time errors still exit so the OS supervisor can restart.
- `daemon.test.ts` — integration-level test for `startDaemon` startup + shutdown.
- `repo-config.test.ts` — unit tests for `repos.yaml` persistence and repo config resolution.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [modules/README.md](../modules/README.md), [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [container/README.md](../container/README.md), [agent-config/README.md](../agent-config/README.md), [model-proxy/README.md](../model-proxy/README.md), [mail-mcp/](../mail-mcp/), [env/env-file.ts](../env/env-file.ts), [modules/meta-ws/](../modules/meta-ws/).
- **Used by:** [cli/serve.ts](../cli/README.md), [cli/serve-meta.ts](../cli/serve-meta.ts), [cli/serve-repo.ts](../cli/serve-repo.ts).
- **As-built:** [Meta-process daemon split](../../docs/as-built/2026-06-26-meta-process-per-repo-daemon-split.md).
