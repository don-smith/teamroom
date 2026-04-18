import type { Message } from "../types.js";
import type { Db } from "./database.js";

interface MessageRow {
  id: string;
  agent_id: string;
  channel: string;
  direction: "in" | "out";
  body: string;
  turn_id: string | null;
  trace_id: string;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    agentId: row.agent_id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    turnId: row.turn_id,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  create(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, agent_id, channel, direction, body, turn_id, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.agentId, m.channel, m.direction, m.body, m.turnId, m.traceId, m.createdAt);
  }

  findById(id: string): Message | null {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  findPendingInbound(): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'in' AND turn_id IS NULL
         ORDER BY created_at`,
      )
      .all() as MessageRow[];
    return rows.map(rowToMessage);
  }

  attachTurn(messageId: string, turnId: string): void {
    this.db.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turnId, messageId);
  }

  findOutboundAfter(lastSeenId: string | null): Message[] {
    const sql = lastSeenId
      ? `SELECT * FROM messages
         WHERE direction = 'out'
           AND created_at > (SELECT created_at FROM messages WHERE id = ?)
         ORDER BY created_at, id`
      : `SELECT * FROM messages WHERE direction = 'out' ORDER BY created_at, id`;
    const rows = lastSeenId
      ? (this.db.prepare(sql).all(lastSeenId) as MessageRow[])
      : (this.db.prepare(sql).all() as MessageRow[]);
    return rows.map(rowToMessage);
  }
}
