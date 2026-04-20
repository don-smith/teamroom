-- Migration 003: M4 agent mail
--
-- Adds email-shaped columns to messages so the same table can carry both
-- CLI lines (channel=cli) and per-agent inbox rows (channel=mail).
-- Recipient sets live in JSON arrays on `to`/`cc`; `from` is a single
-- prefixed address. Read/archive/delete are timestamps, not booleans, so
-- we can tell when state changed without a separate audit table.
--
-- Forward-only. Additive. The M3 columns (topic, from_agent_id,
-- conversation_id) stay in place; a later cleanup migration will drop
-- them once nothing reads from them.

ALTER TABLE messages ADD COLUMN "to" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN "from" TEXT;
ALTER TABLE messages ADD COLUMN cc TEXT;
ALTER TABLE messages ADD COLUMN subject TEXT;
ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN read_at TEXT;
ALTER TABLE messages ADD COLUMN archived_at TEXT;
ALTER TABLE messages ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_messages_inbox
  ON messages(agent_id, read_at)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX idx_messages_thread ON messages(thread_id);
