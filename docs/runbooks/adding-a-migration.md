# Adding a migration

Schema changes land as numbered SQL files in `src/db/migrations/`. The migrator applies them on daemon boot and records each applied file in a `_migrations` ledger table — idempotent, no ORM, no framework. Use this runbook when you need to add a new table, column, or index.

## Preconditions

- You know what schema change you want and have already thought about whether an equivalent change can be avoided (schemas are forever once a migration lands in main).
- `bun install` has run; the relevant DB tests pass on the current branch.
- Existing migrations live at `src/db/migrations/NNN_<description>.sql` — check the current highest number.

## Steps

1. Pick the next number (zero-padded to 3 digits):
   ```bash
   ls src/db/migrations
   # 001_initial.sql
   # ⇒ next is 002
   ```

2. Create `src/db/migrations/002_<short_description>.sql`. Keep descriptions short and snake-case (`002_add_turns_priority.sql`).

3. Write the migration as raw SQL. One logical change per file. `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` — vanilla SQLite. Example:
   ```sql
   ALTER TABLE turns ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX idx_turns_priority ON turns(priority);
   ```

4. Update type definitions in `src/types.ts` if the change is visible at the domain level (new column, new status value).

5. Update the repository in `src/db/` that owns the affected table — add a method, extend `SELECT` columns, etc. Co-locate the test (`src/db/<repo>.test.ts`).

6. Run the suite — co-located repo tests use `:memory:` databases and call `runMigrations` before each test, so they exercise your new migration every run:
   ```bash
   bun test src/db
   ```

7. Inspect the applied schema locally against a real file DB:
   ```bash
   rm -f data/teamroom.db
   bun src/cli/main.ts serve &   # or just wait for the next boot
   sqlite3 data/teamroom.db ".schema"
   sqlite3 data/teamroom.db "SELECT * FROM _migrations"
   ```

## Verifying success

- The `_migrations` ledger in a fresh DB contains both `001_initial` and your new file.
- `sqlite3 data/teamroom.db ".schema"` shows the new column/index/table.
- Focused DB tests pass.
- `runMigrations(createDatabase(":memory:"))` can see your new `.sql` file directly from `src/db/migrations/`.

## Troubleshooting

- **"no such table: _migrations" after startup.** The migrator didn't run. Check `src/daemon/daemon.ts` — `runMigrations` must be called before any repo is used. In tests, confirm the test bootstrap calls it.
- **Migration applied but tests fail on schema mismatch.** Your `:memory:` DB is fresh per-test; the failure is likely in the repo or the types. Grep for the old column name.
- **"near ALTER": syntax error.** SQLite's `ALTER TABLE` supports `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN`, and `DROP COLUMN` (3.35+). For anything more invasive (type change, constraint change), write a multi-step migration: create new table → copy data → drop old → rename.
- **The migration is applied in tests but not on boot.** Team Room now runs TypeScript directly with Bun, so the daemon should read `src/db/migrations/` from the source tree. If it does not, check `src/db/migrator.ts` for path resolution regressions before looking for a missing build step.

## Related

- `src/db/migrator.ts` — `runMigrations` and `getAppliedMigrations`.
- `src/db/README.md` — data-model overview.
- `docs/as-built/2026-04-18-teamroom-m1.md` — §2 data model.
