CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  config_path  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  channel     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body        TEXT NOT NULL,
  turn_id     TEXT,
  trace_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX idx_messages_direction_created ON messages(direction, created_at);

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL REFERENCES agents(id),
  inbound_message_id   TEXT NOT NULL REFERENCES messages(id),
  status               TEXT NOT NULL CHECK (status IN ('pending','running','done','error')),
  container_id         TEXT,
  error                TEXT,
  trace_id             TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_turns_status ON turns(status);
