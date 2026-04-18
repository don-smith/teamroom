# `daemon/` — the orchestrator

The long-running process that owns the DB connection, polls for pending inbound messages, dispatches them to the turn processor, and reconciles on startup. Procedural — **no LLM in the hot path**. All intelligence lives in agent containers; the daemon is the boring conveyor belt that keeps them moving.

**Runs on the host as the main long-running process.** Every other module that isn't `agent-runtime/` is either called from here or supports it. Invariants: *nothing silent, nothing inconsistent, nothing crashes*. Once the daemon has started it does not die from an unhandled exception — see `safety-nets.ts`.

The daemon also **owns the [LocalModelProxy](../model-proxy/README.md)**: starts it on boot, stops it on shutdown, and passes the container-side base URL down to the turn processor. Per-provider credentials are configured via `DaemonOptions.lmStudio` and `DaemonOptions.anthropic` (OAuth preferred, API key fallback, `null` if unconfigured — see `main.ts`'s `discoverAnthropic`).

## Files

- `daemon.ts` — the composition root. `startDaemon(opts)` wires every dependency (clock, logger, DB, bus, container runner, agent configs, **model proxy + provider adapters**) and returns a `StartedDaemon` with a `stop()` function.
- `main.ts` — process entry. Loads `.env`, discovers Anthropic credentials (env-OAuth → `~/.claude/.credentials.json` → env-API-key), calls `startDaemon()`, wires SIGINT/SIGTERM.
- `orchestrator.ts` — `tickOnce()` drains pending inbound messages; `runLoop()` alternates tick + sleep. Serialises per-agent (no parallel turns for the same agent at M1).
- `turn-processor.ts` — `processTurn(deps)`: the heart of the daemon. Takes one pending inbound, creates a turn row and immediately `markRunning`s it with a placeholder container id (so the reconciler can always see the transition — see M1 debt #1), mints a per-turn routing token via the `ModelProxy`, spawns the container via `ContainerRunner` with `TEAMROOM_MODEL_BASE_URL` + `TEAMROOM_MODEL_API_TOKEN` injected, parses stdout events into outbound messages + bus events, updates the row with the real container id, moves the turn to its terminal state, and always evicts the token in a `finally`. Refuses `provider: anthropic` agents with `missing_credential` when no Anthropic adapter is configured.
- `reconcile.ts` — on startup, marks any `status='running'` turn as errored with `'daemon_restart'`. Provides deterministic recovery after a crash.
- `safety-nets.ts` — `installSafetyNets(logger)`: global `uncaughtException` / `unhandledRejection` handlers that log fatal and do NOT exit. Boot-time errors still exit so the OS supervisor can restart.
- `orchestrator.test.ts`, `turn-processor.test.ts`, `reconcile.test.ts` — co-located unit tests. `daemon.ts`, `main.ts`, `safety-nets.ts` are covered by the integration test at [tests/integration/end-to-end.test.ts](../../tests/integration/end-to-end.test.ts) and the smoke script at [scripts/smoke-test.sh](../../scripts/smoke-test.sh).

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [db/README.md](../db/README.md), [bus/README.md](../bus/README.md), [container/README.md](../container/README.md), [agent-config/README.md](../agent-config/README.md), [env/env-file.ts](../env/env-file.ts), [clock/clock.ts](../clock/clock.ts), [logger/logger.ts](../logger/logger.ts).
- **Used by:** [cli/serve.ts](../cli/README.md) (entry point for users).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 processes and boundaries, §2 turn lifecycle, §3 "nothing silent/inconsistent/crashes" invariant, §5 reconciler blind spot and shutdown debts.
