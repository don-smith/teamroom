# `bus/` — NotifyBus seam

`NotifyBus` is the event-notification interface used to signal cross-process state changes (outbound message created, turn state transitions, etc.). Events are **notifications, not payloads** — bodies live in the DB and subscribers fetch them by ID. This keeps event size small and ensures the DB remains the single source of truth.

**Runs on the host in the daemon process.** The production `FileNotifyBus` is also read from a separate CLI process (`teamroom tail`), so the implementation must survive cross-process subscription. The container does not use `NotifyBus` — it signals via stdout JSONL events parsed by the daemon.

M1 scope: no topic registry, no durable delivery guarantees, no broker-side routing. Subscribers filter by `event.type` string locally. The interface is the seam M3's event store will upgrade behind without touching callers.

## Adding new events

Don't add events without a real consumer. Even observability is fair game only when something actually subscribes to the new event — span-shaped log records cover the analytic use case until M3's bus rewrite lands a proper telemetry destination.

## Files

- `notify-bus.ts` — `NotifyBus` interface + `EventFilter` type.
- `in-memory-bus.ts` — `InMemoryBus`, EventEmitter-like implementation for tests.
- `file-notify-bus.ts` — `FileNotifyBus`, production impl using `chokidar` polling on a sentinel file plus an append-only `events.jsonl` log.
- `in-memory-bus.test.ts`, `file-notify-bus.test.ts` — co-located unit tests.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [types.ts](../types.ts) (`BusEvent`), `chokidar` npm package.
- **Used by:** [daemon/README.md](../daemon/README.md) (turn-processor, reconcile publish), [cli/README.md](../cli/README.md) (`tail` subscribes).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 event bus, §3 `NotifyBus` seam decision.
