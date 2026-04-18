# `src/` — Team Room source

- `types.ts` — shared domain types (Message, Turn, Agent, BusEvent).
- `clock/`, `logger/` — small effect-wrapping modules shared across the codebase.
- `db/` — SQLite schema, migrations, repositories.
- `bus/` — `NotifyBus` seam; `FileNotifyBus` production impl, `InMemoryBus` for tests.
- `container/` — `ContainerRunner` seam; `DockerRunner` production, `FakeRunner` for tests.
- `agent-config/` — loads `agents/<name>/agent.yaml`.
- `daemon/` — the orchestrator process (composition root, turn processor, reconcile).
- `cli/` — `teamroom` binary (`serve`, `send`, `tail`, `status`).
- `agent-runtime/` — the shim that runs *inside* each agent container.

See `docs/specs/2026-04-18-teamroom-m1-design.md` for the design and `docs/plans/2026-04-18-teamroom-m1-plan.md` for the plan this code was built against.
