# `src/` — Team Room source

The source tree is split by runtime responsibility. Most of it runs on the **host** as part of the long-running daemon; [`agent-runtime/`](agent-runtime/README.md) is the code that runs **inside** each agent container. Respecting that boundary matters — see [`AGENTS.md`](../AGENTS.md).

## Modules

- [`types.ts`](types.ts) — shared domain types (`Message`, `Turn`, `Agent`, `BusEvent`, `Address`).
- `clock/` — `Clock` interface with `SystemClock` (prod) and `ControllableClock` (tests). Single file; no README.
- `logger/` — `Logger` interface with `JsonLinesLogger` (prod) and `CapturingLogger` (tests). Single file; no README.
- `env/` — `readEnvFile` — reads `.env` without polluting `process.env`. Single file; no README.
- [`db/`](db/README.md) — SQLite schema, migrations, three repositories.
- [`bus/`](bus/README.md) — in-process `EventBus` only (`FileNotifyBus`/`NotifyBus`/`InMemoryBus` removed in M4.5).
- [`container/`](container/README.md) — `ContainerRunner` seam; `DockerRunner` (prod), `FakeRunner` (tests).
- [`agent-config/`](agent-config/README.md) — host-only loader for per-agent folder metadata.
- [`daemon/`](daemon/README.md) — composition root; `startDaemon` wires eight `compose*` modules and opens four daemon ports.
- [`model-proxy/`](model-proxy/README.md) — `ModelProxy` seam; in-daemon HTTP proxy that swaps routing tokens for real upstream credentials. Two-mode Anthropic auth.
- [`modules/`](modules/README.md) — compose-pattern module factories: `observability`, `storage`, `messaging`, `mcp-mail`, `model-proxy`, `session-management`, `channels`, `mail`.
- [`channels/`](channels/) — legacy `CliChannelAdapter`; kept for integration-test support only. The channel architecture lives in `modules/channels/`.
- [`cli/`](cli/README.md) — `teamroom` binary (`serve`, `send`, `chat`, `inbox`, `thread`, `status`).
- [`agent-runtime/`](agent-runtime/README.md) — the shim that runs *inside* each agent container.

## Related

- **Parent:** [repo root](../README.md)
- **As-built:** [M1](../docs/as-built/2026-04-18-teamroom-m1.md) — §2 architecture, §3 key decisions, §4 adaptations.
- **Practices:** [ways-of-working](../docs/ways-of-working.md)
