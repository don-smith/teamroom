/**
 * Over-the-wire protocol for the daemon's chat WebSocket endpoint.
 *
 * Client → daemon messages:
 *   - register: establishes which channel:<channel>:<externalId> the
 *     connection owns for the session
 *   - publish: inbound mail (daemon will call dispatcher.sendMail)
 *
 * Daemon → client messages:
 *   - mail: outbound mail addressed to this connection's channel address
 *   - event: selected bus events relayed to the client (scope TBD per spec)
 *   - error: structured error envelope with machine-readable code
 */

export type ClientMessage =
  | { type: "register"; channel: string; externalId: string }
  | { type: "publish"; to: string[]; body: string; threadId: string | null; cc: string[] };

export type ServerMessage =
  | { type: "mail"; id: string; from: string; to: string[]; cc: string[]; body: string; threadId: string; ts: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "error"; code: string; message: string };

export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid client message: malformed JSON (${String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof (parsed as { type: unknown }).type !== "string") {
    throw new Error("invalid client message: missing type");
  }
  const p = parsed as Record<string, unknown>;
  if (p.type === "register") {
    if (typeof p.channel !== "string" || typeof p.externalId !== "string") {
      throw new Error("register: channel and externalId are required strings");
    }
    return { type: "register", channel: p.channel, externalId: p.externalId };
  }
  if (p.type === "publish") {
    if (!Array.isArray(p.to) || typeof p.body !== "string") {
      throw new Error("publish: to (array of strings) and body (string) are required");
    }
    // All to[] elements should be strings
    for (const t of p.to) {
      if (typeof t !== "string") {
        throw new Error("publish: to[] elements must be strings");
      }
    }
    const cc = Array.isArray(p.cc) ? p.cc.filter((x): x is string => typeof x === "string") : [];
    return {
      type: "publish",
      to: p.to as string[],
      body: p.body,
      threadId: typeof p.threadId === "string" ? p.threadId : null,
      cc,
    };
  }
  throw new Error(`unknown client message type: ${String(p.type)}`);
}
