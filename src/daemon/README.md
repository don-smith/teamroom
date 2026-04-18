# `daemon/` — the orchestrator

- `daemon.ts` — composition root (`startDaemon(opts)`).
- `orchestrator.ts` — polling loop that picks up pending inbound messages.
- `turn-processor.ts` — processes one inbound → 0..N outbound via `ContainerRunner`.
- `reconcile.ts` — on boot, marks orphan running turns as errored.
- `safety-nets.ts` — global `uncaughtException` / `unhandledRejection` handlers that log fatal and do not exit.
- `main.ts` — process entry (`teamroom serve` dispatches here).

Invariants: nothing silent, nothing inconsistent, nothing crashes. See `docs/specs/2026-04-18-teamroom-m1-design.md` §3 and §12.
