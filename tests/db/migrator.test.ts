import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { runMigrations, getAppliedMigrations } from "../../src/db/migrator.js";

describe("migrator", () => {
  it("creates the schema on a fresh in-memory DB", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("agents");
    expect(names).toContain("messages");
    expect(names).toContain("turns");
    expect(names).toContain("_migrations");
  });

  it("is idempotent — running twice leaves applied state unchanged", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const first = getAppliedMigrations(db);
    runMigrations(db);
    const second = getAppliedMigrations(db);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
