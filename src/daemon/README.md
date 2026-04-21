# `daemon/` — the composition root

The long-running process that owns the DB connection, wires all compose-pattern modules, and manages the lifecycle of four externally-visible ports. Procedural — **no LLM in the hot path**. All intelligence lives in agent containers or the session-management module; the daemon is the boring conveyor belt that keeps them moving.

**Runs on the host as the main long-running process.** Every other module that isn't `agent-runtime/` is either called from here or supports it. Invariants: *nothing silent, nothing inconsistent, nothing crashes*. Once the daemon has started it does not die from an unhandled exception — see `safety-nets.ts`.

`startDaemon` composes eight modules in order (`observability` → `storage` → `messaging` → `mcp-mail` → `model-proxy` → `session-management` → `channels` → `mail`) and opens four ports: **mail-MCP** (HTTP/MCP), **model-proxy** (HTTP, internal only), **chat** (WebSocket), **mail** (WebSocket). Port numbers are written to `data/ports/` files so CLI commands can discover them without configuration.

## Files

- `daemon.ts` — the composition root. `startDaemon(opts)` wires every dependency and returns a `StartedDaemon` with a `stop()` function. Called from [`cli/serve.ts`](../cli/serve.ts), which is the real process entry (`teamroom serve`) — this module has no standalone `main.ts`.
- `safety-nets.ts` — `installSafetyNets(logger)`: global `uncaughtException` / `unhandledRejection` handlers that log fatal and do NOT exit. Boot-time errors still exit so the OS supervisor can restart.
- `daemon.test.ts` — integration-level test for `startDaemon` startup + shutdown. The full end-to-end path is exercised by [tests/integration/end-to-end.test.ts](../../tests/integration/end-to-end.test.ts) and the smoke script at [scripts/smoke-test.sh](../../scripts/smoke-test.sh).

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [modules/README.md](../modules/README.md), [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [container/README.md](../container/README.md), [agent-config/README.md](../agent-config/README.md), [model-proxy/README.md](../model-proxy/README.md), [mail-mcp/](../mail-mcp/), [env/env-file.ts](../env/env-file.ts).
- **Used by:** [cli/serve.ts](../cli/README.md) (entry point for users).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 processes and boundaries, §2 turn lifecycle, §3 invariants. [M4.5](../../docs/as-built/2026-04-21-m4.5-ai-native-harness.md) — `Orchestrator`, `turn-processor`, `reconcile` removed; replaced by compose-pattern modules + session-management.
