import type { Message, MessageCreateInput } from "../types.js";
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
  topic: string;
  from_agent_id: string | null;
  conversation_id: string | null;
  to: string;                     // JSON-encoded string[]
  from: string | null;
  cc: string | null;              // JSON-encoded string[] or null
  subject: string | null;
  thread_id: string | null;
  read_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
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
    topic: row.topic,
    fromAgentId: row.from_agent_id,
    conversationId: row.conversation_id,
    to: JSON.parse(row.to ?? "[]") as string[],
    from: row.from ?? null,
    cc: row.cc == null ? null : (JSON.parse(row.cc) as string[]),
    subject: row.subject ?? null,
    threadId: row.thread_id ?? null,
    readAt: row.read_at ?? null,
    archivedAt: row.archived_at ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}

export interface ListInboxOpts {
  unreadOnly?: boolean;
  threadId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export class MessageRepo {
  constructor(private readonly db: Db) {}

  create(m: MessageCreateInput): void {
    const to = JSON.stringify(m.to ?? []);
    const cc = m.cc == null ? null : JSON.stringify(m.cc);
    this.db
      .prepare(
        `INSERT INTO messages
           (id, agent_id, channel, direction, body, turn_id, trace_id, created_at,
            topic, from_agent_id, conversation_id,
            "to", "from", cc, subject, thread_id, read_at, archived_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.agentId, m.channel, m.direction, m.body, m.turnId, m.traceId, m.createdAt,
        m.topic ?? "", m.fromAgentId ?? null, m.conversationId ?? null,
        to, m.from ?? null, cc, m.subject ?? null, m.threadId ?? null,
        m.readAt ?? null, m.archivedAt ?? null, m.deletedAt ?? null,
      );
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

  listInbox(agentId: string, opts: ListInboxOpts): Message[] {
    const wheres: string[] = ["agent_id = ?", "direction = ?", "deleted_at IS NULL"];
    const params: unknown[] = [agentId, "in"];
    if (!opts.includeArchived) wheres.push("archived_at IS NULL");
    if (opts.unreadOnly) wheres.push("read_at IS NULL");
    if (opts.threadId != null) {
      wheres.push("thread_id = ?");
      params.push(opts.threadId);
    }
    const limit = opts.limit ?? 100;
    const sql = `SELECT * FROM messages WHERE ${wheres.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as MessageRow[]).map(rowToMessage);
  }

  countInThread(threadId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages WHERE thread_id = ? AND deleted_at IS NULL`,
      )
      .get(threadId) as { c: number };
    return row.c;
  }

  markRead(id: string, now: string): void {
    this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ?`).run(now, id);
  }

  archive(id: string, now: string): void {
    this.db.prepare(`UPDATE messages SET archived_at = ? WHERE id = ?`).run(now, id);
  }

  softDelete(id: string, now: string): void {
    this.db.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run(now, id);
  }

  listCliOutbound(limit = 100): Message[] {
    // M4 CLI is single-user — we don't yet tag rows per-user. When a second
    // user lands, add a `cli_user` column and filter here.
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE channel = 'cli' AND direction = 'out' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as MessageRow[];
    return rows.map(rowToMessage);
  }
}
