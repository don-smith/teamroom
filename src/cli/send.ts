import { WebSocket } from "ws";

export interface SendArgs {
  port: number;
  user: string;
  agent: string;
  body: string;
  threadId?: string | null;
}

/**
 * Fire-and-forget send via the chat WebSocket. Registers as
 * channel:cli:<user>, publishes one message to agent:<agent>, then
 * closes. No reply-waiting — if you need to wait for a reply, use
 * `teamroom chat` (the interactive REPL).
 */
export async function send(args: SendArgs): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}/`);
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });
  try {
    ws.send(JSON.stringify({
      type: "register",
      channel: "cli",
      externalId: args.user,
    }));
    ws.send(JSON.stringify({
      type: "publish",
      to: [`agent:${args.agent}`],
      body: args.body,
      threadId: args.threadId ?? null,
      cc: [],
    }));
    // Brief wait for the dispatcher to process the publish on the daemon side.
    // The chat protocol has no ack; 30ms is enough for local loopback.
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    ws.close();
  }
}
