-- src/db/migrations/002_m3_team_substrate.sql

-- M3: team-substrate DM primitive needs channel-specific routing fields on
-- messages and a business-level conversation_id on both messages and turns
-- (the latter powers the runaway-loop cap check).

ALTER TABLE messages ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN from_agent_id TEXT;
ALTER TABLE messages ADD COLUMN conversation_id TEXT;

ALTER TABLE turns ADD COLUMN conversation_id TEXT;

CREATE INDEX idx_messages_channel_topic ON messages(channel, topic);
CREATE INDEX idx_turns_conversation ON turns(conversation_id);
