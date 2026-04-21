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
    // turns table was dropped by migration 005
    expect(names).not.toContain("turns");
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

    // turns table was dropped by migration 005 — skip the turns column check

    const applied = (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    expect(applied).toContain("002_m3_team_substrate.sql");
  });

  it("applies 003_m4_agent_mail.sql and exposes mail columns + indexes", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);

    const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((r) => r.name);
    expect(msgCols).toEqual(
      expect.arrayContaining(["to", "from", "cc", "subject", "thread_id", "read_at", "archived_at", "deleted_at"]),
    );

    const indexes = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("idx_messages_inbox");
    expect(indexes).toContain("idx_messages_thread");

    const applied = (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    expect(applied).toContain("003_m4_agent_mail.sql");
  });
});

describe("migration 004 — channel address scheme", () => {
  it("rewrites legacy cli:* addresses to channel:cli:* across from/to/cc; is idempotent on re-run", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);

    db.prepare(`
      INSERT INTO agents (id, config_path, created_at)
      VALUES ('a', '/dev/null', '2026-04-21T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO messages (id, agent_id, body, channel, direction, created_at, trace_id, "from", "to", cc)
      VALUES ('m1', 'a', 'b', 'mail', 'in', '2026-04-21T00:00:00Z', 'trace-1',
              'cli:don', '["agent:a","cli:don"]', '["cli:other"]')
    `).run();

    // The row above was inserted AFTER runMigrations already applied 004
    // to an empty messages table — so the first db.exec(sql) below is the
    // actual rewrite for this row, and the second proves idempotency
    // (no double-prefix, no further changes).
    const sql = `
      UPDATE messages SET "from" = 'channel:' || "from" WHERE "from" LIKE 'cli:%';
      UPDATE messages SET "to" = (SELECT json_group_array(CASE WHEN value LIKE 'cli:%' THEN 'channel:' || value ELSE value END) FROM json_each(messages."to")) WHERE EXISTS (SELECT 1 FROM json_each(messages."to") WHERE value LIKE 'cli:%');
      UPDATE messages SET cc = (SELECT json_group_array(CASE WHEN value LIKE 'cli:%' THEN 'channel:' || value ELSE value END) FROM json_each(messages.cc)) WHERE cc IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(messages.cc) WHERE value LIKE 'cli:%');
    `;
    db.exec(sql);

    const row = db.prepare(`SELECT "from", "to", cc FROM messages WHERE id='m1'`).get() as any;
    expect(row.from).toBe("channel:cli:don");
    expect(JSON.parse(row.to)).toEqual(["agent:a", "channel:cli:don"]);
    expect(JSON.parse(row.cc)).toEqual(["channel:cli:other"]);

    // Second run: idempotent — no double-prefix.
    db.exec(sql);
    const row2 = db.prepare(`SELECT "from", "to", cc FROM messages WHERE id='m1'`).get() as any;
    expect(row2.from).toBe("channel:cli:don");
    expect(JSON.parse(row2.to)).toEqual(["agent:a", "channel:cli:don"]);
    expect(JSON.parse(row2.cc)).toEqual(["channel:cli:other"]);

    db.close();
  });
});
