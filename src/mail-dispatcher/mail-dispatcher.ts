import type { MessageRepo } from "../db/message-repo.js";
import type { EventBus } from "../bus/event-bus.js";
import type { Clock } from "../clock/clock.js";
import { parseAddress, formatAddress, type Address } from "./address.js";

/**
 * Internal daemon module. Performs validated mail sends:
 *   1. Parse + validate every recipient atomically.
 *   2. Expand `list:*` to agent subscribers (snapshots membership at send time).
 *   3. Enforce thread-cap.
 *   4. Insert one row per expanded recipient. All rows share identical
 *      `to`, `from`, `cc`, `subject`, `body`, `thread_id` — only `agent_id`
 *      and per-row state differ. This preserves group-discussion semantics.
 *   5. Publish `mail.delivered` / `channel.cli.out` per row; `mail.sent`
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

    const expandedTo = this.expand(parsedTo);
    const expandedCc = this.expand(parsedCc);

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
    const toStrings = expandedTo.map(formatAddress);
    const ccStrings = expandedCc.length === 0 ? null : expandedCc.map(formatAddress);

    const rowIds: string[] = [];
    const now = this.deps.clock.nowIso();

    for (const addr of [...expandedTo, ...expandedCc]) {
      const id = this.deps.genId();
      rowIds.push(id);

      if (addr.kind === "agent") {
        this.deps.messageRepo.create({
          id,
          agentId: addr.name,
          channel: "mail",
          direction: "in",
          body: input.body,
          turnId: null,
          traceId: id,
          createdAt: now,
          to: toStrings,
          from: input.from,
          cc: ccStrings,
          subject: input.subject ?? null,
          threadId,
        });
        this.deps.bus.publish("mail.delivered", { to: addr.name });
      } else if (addr.kind === "channel" && addr.channel === "cli") {
        // CLI outbound rows carry the full mail envelope so that the
        // ChatServer can forward it over WebSocket without additional lookups.
        // We still scope the row to the sending agent via agent_id (or the
        // sender address verbatim when the sender is channel:cli:* or 'system').
        const senderLabel = this.senderLabel(input.from);
        this.deps.messageRepo.create({
          id,
          agentId: senderLabel,
          channel: "cli",
          direction: "out",
          body: input.body,
          turnId: null,
          traceId: id,
          createdAt: now,
          threadId,
          from: input.from,
          to: toStrings,
          cc: ccStrings,
        });
        // Include the row id so a bus-to-bus bridge (e.g., the daemon's
        // tail-facing FileNotifyBus) can forward a message.outbound event
        // without racing to find the most recent CLI row.
        // Also include from/to strings so ChatServer can forward the full
        // envelope to the registered WebSocket client.
        this.deps.bus.publish("channel.cli.out", {
          user: addr.externalId,
          messageId: id,
          agentId: senderLabel,
          threadId,
          from: input.from,
          to: toStrings,
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

  private expand(addrs: Address[]): Address[] {
    const out: Address[] = [];
    for (const a of addrs) {
      if (a.kind === "list") {
        const subs = this.deps.listSubscribers(a.name);
        for (const s of subs) out.push({ kind: "agent", name: s });
      } else {
        out.push(a);
      }
    }
    return out;
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
    // agent_id so the CLI tail can display it verbatim.
    return from;
  }
}
