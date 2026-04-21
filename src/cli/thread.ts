import { runQuery } from "./query-client.js";

export interface RunThreadArgs {
  port: number;
  threadId: string;
  out: (line: string) => void;
}

/**
 * One-shot WebSocket client: connect, send `query thread`, print each row
 * as a JSON line via `out`, exit. Surfaces server errors as a thrown
 * Error; connect/transport errors propagate unchanged.
 */
export async function runThread(args: RunThreadArgs): Promise<void> {
  await runQuery({
    port: args.port,
    query: { type: "query", id: "1", query: "thread", params: { id: args.threadId } },
    out: args.out,
  });
}
