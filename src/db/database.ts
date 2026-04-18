import Database from "better-sqlite3";
import type { Database as BetterDb } from "better-sqlite3";

export type Db = BetterDb;

export function createDatabase(dsn: string): Db {
  const db = new Database(dsn);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
