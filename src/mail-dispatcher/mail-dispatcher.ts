import type { MessageRepo } from "../db/message-repo.js";
import type { EventBus } from "../bus/event-bus.js";
import type { Clock } from "../clock/clock.js";
import type { MailDeliveredEvent } from "../types.js";
import { parseAddress, formatAddress, type Address } from "./address.js";

/**
 * Internal daemon module. Performs validated mail sends:
 *   1. Parse + validate every recipient atomically.
 *   2. Expand `list:*` to agent subscribers (snapshots membership at send time).
 *   3. Enforce thread-cap.
 *   4. Insert one row per expanded recipient. All rows share identical
 *      `to`, `from`, `cc`, `subject`, `body`, `thread_id` — only `agent_id`
 *      and per-row state differ. This preserves group-discussion semantics.
 *   5. Publish `mail.delivered` / `channel.out` per row; `mail.sent`
 *      once for the sender (if the sender is an agent).
 */

export interface MailDispatcherDeps {
  messageRepo: MessageRepo;
  bus: EventBus;
  clock: Clock;
  genId: () => string;
  knownAgents: (name: string) => boolean;
  knownLists: (name: string) => boolean;
  listSubscribers: (name: string) => string[];
  /** Max non-deleted mails per thread. 0 disables the cap. */
  maxMailsPerThread: number;
}

export interface SendMailInput {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  threadId?: string | null;
}

export interface SendMailResult {
  threadId: string;
  rowIds: string[];
}

export class MailDispatcher {
  constructor(private readonly deps: MailDispatcherDeps) {}

  sendMail(input: SendMailInput): SendMailResult {
    const threadId = input.threadId ?? this.deps.genId();

    const parsedTo = input.to.map(parseAddress);
    const parsedCc = (input.cc ?? []).map(parseAddress);

    // Atomic validation: reject the whole send if any recipient is unknown.
    for (const a of [...parsedTo, ...parsedCc]) {
      if (a.kind === "agent" && !this.deps.knownAgents(a.name)) {
        throw new Error(`unknown recipient: agent:${a.name}`);
      }
      if (a.kind === "list" && !this.deps.knownLists(a.name)) {
        throw new Error(`unknown recipient: list:${a.name}`);
      }
    }

    const expandedTo = this.expand(parsedTo, { replyExpectedForDirectAgent: this.fromCreatesReplyExpectation(input.from) });
    const expandedCc = this.expand(parsedCc, { replyExpectedForDirectAgent: false });

    // Thread cap counts every row we'd add (multi-recipient dispatch counts N).
    const cap = this.deps.maxMailsPerThread;
    if (cap > 0) {
      const existing = this.deps.messageRepo.countInThread(threadId);
      const incoming = expandedTo.length + expandedCc.length;
      if (existing + incoming > cap) {
        throw new Error(`thread cap reached (thread=${threadId}, cap=${cap})`);
      }
    }

    // Post-expansion envelope strings — every recipient row sees the full
    // group on `to`/`cc`, not just their own address.
    const toStrings = expandedTo.map((delivery) => formatAddress(delivery.address));
    const ccStrings = expandedCc.length === 0 ? null : expandedCc.map((delivery) => formatAddress(delivery.address));

    const rowIds: string[] = [];
    const now = this.deps.clock.nowIso();

    for (const delivery of [...expandedTo, ...expandedCc]) {
      const id = this.deps.genId();
      rowIds.push(id);
      const addr = delivery.address;

      if (addr.kind === "agent") {
        this.deps.messageRepo.create({
          id,
          agentId: addr.name,
          channel: "mail",
          direction: "in",
          body: input.body,
          traceId: id,
          createdAt: now,
          to: toStrings,
          from: input.from,
          cc: ccStrings,
          subject: input.subject ?? null,
          threadId,
        });
        const payload: MailDeliveredEvent = {
          type: "mail.delivered",
          to: addr.name,
          messageId: id,
          threadId,
          from: input.from,
          replyExpected: delivery.replyExpected,
        };
        this.deps.bus.publish("mail.delivered", payload);
      } else if (addr.kind === "channel") {
        // Channel outbound rows carry the full mail envelope so that the
        // channel subscriber (ChatServer, Telegram gateway, etc.) can
        // forward it without additional lookups. The channel name in the
        // payload lets subscribers filter to their own channel.
        const senderLabel = this.senderLabel(input.from);
        this.deps.messageRepo.create({
          id,
          agentId: senderLabel,
          channel: addr.channel,
          direction: "out",
          body: input.body,
          traceId: id,
          createdAt: now,
          threadId,
          from: input.from,
          to: toStrings,
          cc: ccStrings,
        });
        this.deps.bus.publish("channel.out", {
          channel: addr.channel,
          user: addr.externalId,
          messageId: id,
          agentId: senderLabel,
          threadId,
          from: input.from,
          to: toStrings,
          body: input.body,
        });
      }
      // `list` is already expanded out of the list — not reachable here.
    }

    // One `mail.sent` per logical send, emitted only for agent senders
    // (cli:* and 'system' senders have no session to reset).
    const parsedFrom = this.safeParseFrom(input.from);
    if (parsedFrom?.kind === "agent") {
      this.deps.bus.publish("mail.sent", { from: parsedFrom.name });
    }

    return { threadId, rowIds };
  }

  private expand(addrs: Address[], opts: { replyExpectedForDirectAgent: boolean }): Array<{ address: Address; replyExpected: boolean }> {
    const out: Array<{ address: Address; replyExpected: boolean }> = [];
    for (const a of addrs) {
      if (a.kind === "list") {
        const subs = this.deps.listSubscribers(a.name);
        for (const s of subs) out.push({ address: { kind: "agent", name: s }, replyExpected: false });
      } else {
        out.push({ address: a, replyExpected: a.kind === "agent" ? opts.replyExpectedForDirectAgent : false });
      }
    }
    return out;
  }

  private fromCreatesReplyExpectation(from: string): boolean {
    return this.safeParseFrom(from)?.kind === "agent" || this.safeParseFrom(from)?.kind === "channel";
  }

  private safeParseFrom(from: string): Address | null {
    try {
      return parseAddress(from);
    } catch {
      return null;
    }
  }

  private senderLabel(from: string): string {
    const p = this.safeParseFrom(from);
    if (p?.kind === "agent") return p.name;
    // cli:* / 'system' / unparseable → keep the raw string as the row's
    // agent_id so the CLI can identify the sender.
    return from;
  }
}
