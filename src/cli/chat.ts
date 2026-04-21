import { WebSocket } from "ws";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface RunChatArgs {
  port: number;
  agent: string;
  user: string;
  initialBody?: string;
  stdin: Readable;
  stdout: Writable;
}

/**
 * Interactive chat REPL over the chat WebSocket. Registers as
 * channel:cli:<user>, optionally sends an initial body, then reads stdin
 * lines and sends each as a publish. Prints incoming mail messages as
 * they arrive. Exits cleanly on /quit, /exit, EOF, or SIGINT.
 *
 * threadId handling: v1 sends each message with threadId=null. The
 * dispatcher allocates a new thread per publish — acceptable for a first
 * iteration; a later enhancement could track the assigned threadId from
 * the first publish and reuse it for the rest of the session.
 */
export async function runChat(args: RunChatArgs): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}/`);

  // Connect
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });

  // Set up message handling
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; from?: string; body?: string; code?: string; message?: string };
      if (msg.type === "mail") {
        args.stdout.write(`${msg.from ?? ""}: ${msg.body ?? ""}\n`);
      } else if (msg.type === "error") {
        args.stdout.write(`error: ${msg.code ?? ""} — ${msg.message ?? ""}\n`);
      }
    } catch {
      /* ignore malformed server frames */
    }
  });

  // Register as the user's CLI channel
  ws.send(
    JSON.stringify({
      type: "register",
      channel: "cli",
      externalId: args.user,
    }),
  );

  const publish = (body: string): void => {
    ws.send(
      JSON.stringify({
        type: "publish",
        to: [`agent:${args.agent}`],
        body,
        threadId: null,
        cc: [],
      }),
    );
  };

  // Initial body (if provided)
  if (args.initialBody) publish(args.initialBody);

  // REPL loop
  const rl = createInterface({ input: args.stdin, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed.length === 0) continue;
      publish(trimmed);
    }
  } finally {
    rl.close();
    ws.close();
  }
}
