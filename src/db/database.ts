import { Database as BunDatabase } from "bun:sqlite";

export interface Statement {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
  close(): void;
}

export function createDatabase(dsn: string): Db {
  const db = new BunDatabase(dsn);
  db.exec("PRAGMA foreign_keys = ON");
  if (dsn !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}
