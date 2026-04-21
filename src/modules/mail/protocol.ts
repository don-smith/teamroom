/**
 * Over-the-wire protocol for the daemon's read-only mail WebSocket endpoint.
 *
 * Client → daemon messages:
 *   - query: a request with an id and a query-name + params
 *
 * Daemon → client messages:
 *   - result: response rows matched by id
 *   - error: structured error with machine-readable code
 *
 * Distinct from the chat protocol (`../channels/protocol.ts`), which is
 * bidirectional and bus-native. Mail is request/response; each query is
 * self-contained; no registration step.
 */

export type ClientMessage =
  | { type: "query"; id: string; query: "inbox"; params: { agent: string } }
  | { type: "query"; id: string; query: "thread"; params: { id: string } };

export type ServerMessage =
  | { type: "result"; id: string; rows: unknown[] }
  | { type: "error"; id: string; code: string; message: string };

const QUERIES = new Set(["inbox", "thread"]);

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
  if (p.type !== "query") {
    throw new Error(`unknown client message type: ${String(p.type)}`);
  }
  if (typeof p.id !== "string" || typeof p.query !== "string") {
    throw new Error("query: id and query are required strings");
  }
  if (!QUERIES.has(p.query)) {
    throw new Error(`unknown query: ${p.query}`);
  }
  const params = p.params as Record<string, unknown> | undefined;
  if (p.query === "inbox") {
    if (!params || typeof params.agent !== "string") {
      throw new Error("inbox: params.agent is required");
    }
    return { type: "query", id: p.id, query: "inbox", params: { agent: params.agent } };
  }
  if (p.query === "thread") {
    if (!params || typeof params.id !== "string") {
      throw new Error("thread: params.id is required");
    }
    return { type: "query", id: p.id, query: "thread", params: { id: params.id } };
  }
  throw new Error(`unreachable: unknown query ${p.query}`);
}
