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
 * threadId handling: the first incoming `mail` frame carries the thread
 * the dispatcher assigned; subsequent publishes reuse it, so a chat
 * session is a single logical thread. Until a reply arrives, publishes
 * go with threadId=null (dispatcher allocates).
 */
export async function runChat(args: RunChatArgs): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${args.port}/`);

  // Connect
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });

  // Track the session thread: null until the first mail frame carries one;
  // reused thereafter so subsequent publishes stay in the same thread.
  let sessionThreadId: string | null = null;

  // Set up message handling
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; from?: string; body?: string; code?: string; message?: string; threadId?: string };
      if (msg.type === "mail") {
        if (sessionThreadId === null && typeof msg.threadId === "string" && msg.threadId.length > 0) {
          sessionThreadId = msg.threadId;
        }
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
        threadId: sessionThreadId,
        cc: [],
      }),
    );
  };

  // REPL loop. Create the interface before installing the post-connect
  // error handler so the handler can close it on a transport failure.
  const rl = createInterface({ input: args.stdin, terminal: false });

  // Post-connect error handler: if the daemon dies mid-session or any other
  // transport error surfaces, print to stdout and end the readline so the
  // REPL's finally block runs cleanly instead of crashing on unhandled error.
  ws.on("error", (err) => {
    args.stdout.write(`error: transport — ${err.message}\n`);
    rl.close();
  });

  // Initial body (if provided)
  if (args.initialBody) publish(args.initialBody);

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
