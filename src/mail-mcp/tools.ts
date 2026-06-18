import type { MessageRepo } from "../db/message-repo.js";
import type { MailDispatcher } from "../mail-dispatcher/mail-dispatcher.js";
import type { EventBus } from "../bus/event-bus.js";
import type { Clock } from "../clock/clock.js";
import type { Message } from "../types.js";

/**
 * Per-tool context resolved from the MCP token. The caller's agent id scopes
 * every inbox operation; the underlying repo never returns rows that belong
 * to another agent.
 */
export interface ToolContext {
  callerAgentId: string;
}

/**
 * Thin wrappers around MessageRepo + MailDispatcher. The MCP server calls
 * these after authenticating the token; tools never see raw HTTP concerns.
 *
 * Every tool publishes a `tool.call{agentId, tool}` bus event so the
 * SessionTimerManager can reset the caller's idle timer — reads count as
 * activity because an LLM that's still scrolling its inbox is still alive.
 */
export class MailMcpTools {
  constructor(
    private readonly deps: {
      messageRepo: MessageRepo;
      dispatcher: MailDispatcher;
      bus: EventBus;
      clock: Clock;
    },
  ) {}

  list(
    ctx: ToolContext,
    input: {
      unreadOnly?: boolean;
      threadId?: string;
      includeArchived?: boolean;
      limit?: number;
    },
  ): Message[] {
    this.activity(ctx, "mail.list");
    return this.deps.messageRepo.listInbox(ctx.callerAgentId, input);
  }

  get(ctx: ToolContext, input: { id: string }): Message {
    this.activity(ctx, "mail.get");
    if (!input.id) {
      throw new Error("mail_get requires an 'id' parameter. First call mail_list() to see available messages, then call mail_get({id: '...'}) with the id from the result.");
    }
    return this.scopedGet(ctx, input.id);
  }

  send(
    ctx: ToolContext,
    input: {
      to: string[];
      cc?: string[];
      subject?: string;
      body: string;
      threadId?: string;
    },
  ): { threadId: string; rowIds: string[] } {
    this.activity(ctx, "mail.send");
    return this.deps.dispatcher.sendMail({
      from: `agent:${ctx.callerAgentId}`,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId ?? null,
    });
  }

  reply(
    ctx: ToolContext,
    input: { id: string; body: string; ccAll?: boolean },
  ): { threadId: string; rowIds: string[] } {
    this.activity(ctx, "mail.reply");
    const parent = this.scopedGet(ctx, input.id);
    if (!parent.from) {
      throw new Error(`cannot reply: mail ${input.id} has no 'from'`);
    }
    const self = `agent:${ctx.callerAgentId}`;
    const cc = input.ccAll
      ? [
          ...new Set([...(parent.to ?? []), ...(parent.cc ?? [])]),
        ].filter((a) => a !== self && a !== parent.from)
      : undefined;
    return this.deps.dispatcher.sendMail({
      from: self,
      to: [parent.from],
      cc,
      subject: parent.subject ?? undefined,
      body: input.body,
      threadId: parent.threadId ?? null,
    });
  }

  markRead(ctx: ToolContext, input: { id: string }): void {
    this.activity(ctx, "mail.mark_read");
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.markRead(row.id, this.deps.clock.nowIso());
  }

  archive(ctx: ToolContext, input: { id: string }): void {
    this.activity(ctx, "mail.archive");
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.archive(row.id, this.deps.clock.nowIso());
  }

  delete(ctx: ToolContext, input: { id: string }): void {
    this.activity(ctx, "mail.delete");
    const row = this.scopedGet(ctx, input.id);
    this.deps.messageRepo.softDelete(row.id, this.deps.clock.nowIso());
  }

  private scopedGet(ctx: ToolContext, id: string): Message {
    const row = this.deps.messageRepo.findById(id);
    if (!row || row.agentId !== ctx.callerAgentId) {
      // Don't leak that the row exists for another agent — return the same
      // error either way.
      throw new Error(`mail not found: ${id}`);
    }
    return row;
  }

  private activity(ctx: ToolContext, tool: string): void {
    this.deps.bus.publish("tool.call", {
      agentId: ctx.callerAgentId,
      tool,
    });
  }
}
