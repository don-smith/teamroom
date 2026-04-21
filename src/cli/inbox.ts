import { runQuery } from "./query-client.js";

export interface RunInboxArgs {
  port: number;
  agent: string;
  out: (line: string) => void;
}

/**
 * One-shot WebSocket client: connect, send `query inbox`, print each row
 * as a JSON line via `out`, exit. Surfaces server errors as a thrown
 * Error; connect/transport errors propagate unchanged.
 */
export async function runInbox(args: RunInboxArgs): Promise<void> {
  await runQuery({
    port: args.port,
    query: { type: "query", id: "1", query: "inbox", params: { agent: args.agent } },
    out: args.out,
  });
}
