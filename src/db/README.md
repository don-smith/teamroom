# `db/` — SQLite layer

Every effectful SQL call goes through one of three repositories: `AgentRepo`, `MessageRepo`, `TurnRepo`. `createDatabase(dsn)` is the factory (accepts `:memory:` for tests or a file path for production). `runMigrations(db)` applies numbered SQL files from `migrations/` on boot.

The schema is owned by the design spec (`docs/specs/2026-04-18-teamroom-m1-design.md` §6). Three tables — `agents`, `messages`, `turns` — plus a `_migrations` ledger.
