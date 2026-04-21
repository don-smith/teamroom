-- Migration 005: drop the legacy turns table and the messages.turn_id column.
--
-- The Orchestrator that wrote to this table was removed in Plan Task 34.
-- Nothing live writes turns any more; the table is vestigial.
--
-- SQLite ≥ 3.35 (shipped with better-sqlite3) supports DROP COLUMN.
-- If this migration ever runs on an older SQLite the DROP COLUMN statement
-- will error; in that case the column can safely be left as a nullable tombstone.

DROP TABLE IF EXISTS turns;
ALTER TABLE messages DROP COLUMN turn_id;
