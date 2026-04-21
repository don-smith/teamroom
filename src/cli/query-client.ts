import { WebSocket } from "ws";
import type { ClientMessage } from "../modules/mail/protocol.js";

export interface RunQueryArgs {
  port: number;
  query: ClientMessage;
  out: (line: string) => void;
}

/**
 * Shared one-shot WebSocket client for mail query commands (inbox, thread).
 * Connects, sends one query message, emits each result row via `out`, then
 * closes the socket. Surfaces server errors as a thrown Error; connect and
 * transport errors propagate unchanged.
 */
export async function runQuery(args: RunQueryArgs): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}/`);
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });
  try {
    ws.send(JSON.stringify(args.query));
    await new Promise<void>((ok, fail) => {
      ws.once("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "error") {
            fail(new Error(`${msg.code}: ${msg.message}`));
            return;
          }
          for (const row of msg.rows ?? []) {
            args.out(JSON.stringify(row));
          }
          ok();
        } catch (err) {
          fail(err as Error);
        }
      });
      ws.once("error", (err) => fail(err));
    });
  } finally {
    ws.close();
  }
}
