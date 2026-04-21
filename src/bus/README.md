# `bus/` — in-process EventBus

The `EventBus` is the typed, in-process event bus for M4 signals (mail, session, tool-call, channel). Events are **notifications, not payloads** — bodies live in the DB and subscribers fetch them by ID. Not durable; crashes drop events. The DB covers durability for anything that needs it.

**Runs in-process in the daemon.** All publishers and subscribers are co-located in the same process; no cross-process delivery is needed.

## Files

- `event-bus.ts` — typed, in-process `EventBus` for M4 signals. Publishers call `emit(event)`, subscribers call `on(type, handler)`.
- `event-bus.test.ts` — co-located unit test.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [types.ts](../types.ts) (`BusEvent`).
- **Used by:** [modules/](../modules/README.md) (composeMessaging wires the bus; session-management and mcp-mail subscribe).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 event bus. M4.5 as-built lands at milestone close.
