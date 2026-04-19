import type { Turn, TurnStatus } from "../types.js";
import type { Db } from "./database.js";

interface TurnRow {
  id: string;
  agent_id: string;
  inbound_message_id: string;
  status: TurnStatus;
  container_id: string | null;
  error: string | null;
  trace_id: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  conversation_id: string | null;
}

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    agentId: row.agent_id,
    inboundMessageId: row.inbound_message_id,
    status: row.status,
    containerId: row.container_id,
    error: row.error,
    traceId: row.trace_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    conversationId: row.conversation_id,
  };
}

export class TurnRepo {
  constructor(private readonly db: Db) {}

  create(t: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, agent_id, inbound_message_id, status, container_id, error, trace_id,
            started_at, finished_at, created_at, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.agentId, t.inboundMessageId, t.status, t.containerId, t.error, t.traceId,
        t.startedAt, t.finishedAt, t.createdAt, t.conversationId,
      );
  }

  findById(id: string): Turn | null {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  markRunning(id: string, containerId: string, startedAt: string): void {
    this.db
      .prepare(
        `UPDATE turns SET status='running', container_id=?, started_at=? WHERE id=?`,
      )
      .run(containerId, startedAt, id);
  }

  markDone(id: string, finishedAt: string): void {
    this.db
      .prepare(`UPDATE turns SET status='done', finished_at=? WHERE id=?`)
      .run(finishedAt, id);
  }

  markError(id: string, error: string, finishedAt: string): void {
    this.db
      .prepare(`UPDATE turns SET status='error', error=?, finished_at=? WHERE id=?`)
      .run(error, finishedAt, id);
  }

  findByStatus(status: TurnStatus): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE status=? ORDER BY created_at`)
      .all(status) as TurnRow[];
    return rows.map(rowToTurn);
  }

  findAgedPending(cutoffIso: string): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
           WHERE status='pending' AND container_id IS NULL AND created_at < ?
           ORDER BY created_at`,
      )
      .all(cutoffIso) as TurnRow[];
    return rows.map(rowToTurn);
  }

  countByStatus(status: TurnStatus): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE status=?`)
      .get(status) as { c: number };
    return row.c;
  }

  latestDone(): Turn | null {
    const row = this.db
      .prepare(`SELECT * FROM turns WHERE status='done' ORDER BY finished_at DESC LIMIT 1`)
      .get() as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  countByConversationId(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE conversation_id = ?`)
      .get(conversationId) as { c: number };
    return row.c;
  }
}
