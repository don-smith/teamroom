import { describe, expect, it } from "vitest";
import { createDatabase } from "./database.js";
import { runMigrations, getAppliedMigrations } from "./migrator.js";

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

  it("applies 002_m3_team_substrate.sql and exposes new columns", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);

    const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
    expect(msgCols).toEqual(
      expect.arrayContaining(["topic", "from_agent_id", "conversation_id"]),
    );

    const turnCols = (db.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).map((r) => r.name);
    expect(turnCols).toEqual(expect.arrayContaining(["conversation_id"]));

    const applied = (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    expect(applied).toContain("002_m3_team_substrate.sql");
  });
});
