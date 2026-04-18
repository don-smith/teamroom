# `bus/` — NotifyBus seam

`NotifyBus` is the interface; events are notifications, not payloads (bodies live in the DB). Production: `FileNotifyBus` (chokidar-polled `events.jsonl` + `.notify` file). Tests: `InMemoryBus` (EventEmitter-like).

M1 scope: no topic registry, no durable delivery, no cross-process subscription coordination. The interface is the seam M3 will upgrade behind.
