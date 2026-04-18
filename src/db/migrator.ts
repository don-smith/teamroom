import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./database.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface AppliedMigration {
  name: string;
  applied_at: string;
}

export function getAppliedMigrations(db: Db): AppliedMigration[] {
  ensureMigrationsTable(db);
  return db
    .prepare("SELECT name, applied_at FROM _migrations ORDER BY name")
    .all() as AppliedMigration[];
}

export function runMigrations(db: Db): void {
  ensureMigrationsTable(db);
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const applyOne = db.transaction(() => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    });
    applyOne();
  }
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`);
}
