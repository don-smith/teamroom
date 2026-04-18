# `db/` — SQLite persistence layer

Every effectful SQL call goes through one of three repositories: `AgentRepo`, `MessageRepo`, `TurnRepo`. The schema is owned by the design spec; this module is the code that materialises and talks to it.

**Runs on the host in the daemon and CLI processes.** All writes happen in the daemon; the CLI commands (`send`, `tail`, `status`) are readers or modest writers that the daemon tolerates via WAL mode. The container never touches the DB.

## Files

- `database.ts` — `createDatabase(dsn)` factory. Returns a `better-sqlite3` `Database`. `:memory:` for tests; a file path for production. Enables WAL mode and foreign keys.
- `migrator.ts` — `runMigrations(db)` applies numbered SQL files from `migrations/` on boot; `getAppliedMigrations(db)` returns the ledger. Idempotent; uses a `_migrations` table.
- `migrations/001_initial.sql` — initial schema (`agents`, `messages`, `turns`, three indexes).
- `agent-repo.ts` — `AgentRepo.create / findById / findAll`.
- `message-repo.ts` — `MessageRepo.create / findById / findPendingInbound / attachTurn / findOutboundAfter`.
- `turn-repo.ts` — `TurnRepo.create / markRunning / markDone / markError / findByStatus / countByStatus / latestDone`.
- `migrator.test.ts`, `agent-repo.test.ts`, `message-repo.test.ts`, `turn-repo.test.ts` — co-located unit tests using `:memory:` databases.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** [types.ts](../types.ts) (`Agent`, `Message`, `Turn`), `better-sqlite3` npm package.
- **Used by:** [daemon/README.md](../daemon/README.md), [cli/README.md](../cli/README.md).
- **Spec:** [M1 design](../../docs/specs/2026-04-18-teamroom-m1-design.md) — §6 database schema.
