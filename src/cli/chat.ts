import { WebSocket } from "ws";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface RunChatArgs {
  port: number;
  agent: string;
  user: string;
  initialBody?: string;
  stdin: Readable;
  stdout: Writable;
  /**
   * When true, render a `you: ` prompt and add blank-line separators around
   * incoming messages — for terminal use. Defaults to false so test
   * harnesses (PassThrough streams) get clean structured output.
   */
  interactive?: boolean;
}

async function assertChatServerReachable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const fail = () => new Error(`chat server unavailable on 127.0.0.1:${port} — is the daemon running?`);
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(1000, () => finish(fail()));
    socket.once("connect", () => finish());
    socket.once("error", () => finish(fail()));
  });
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
  await assertChatServerReachable(args.port);

  const ws = new WebSocket(`ws://127.0.0.1:${args.port}/`);

  // Connect
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });

  // Track the session thread: null until the first mail frame carries one;
  // reused thereafter so subsequent publishes stay in the same thread.
  let sessionThreadId: string | null = null;

  const interactive = args.interactive === true;
  const writePrompt = (): void => {
    if (interactive) args.stdout.write("you: ");
  };

  // Set up message handling
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; from?: string; body?: string; code?: string; message?: string; threadId?: string };
      if (msg.type === "mail") {
        if (sessionThreadId === null && typeof msg.threadId === "string" && msg.threadId.length > 0) {
          sessionThreadId = msg.threadId;
        }
        if (interactive) args.stdout.write("\n");
        args.stdout.write(`${msg.from ?? ""}: ${msg.body ?? ""}\n`);
        if (interactive) args.stdout.write("\n");
        writePrompt();
      } else if (msg.type === "error") {
        args.stdout.write(`error: ${msg.code ?? ""} — ${msg.message ?? ""}\n`);
        writePrompt();
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

  // Initial prompt so the user knows where to type.
  writePrompt();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed.length === 0) {
        writePrompt();
        continue;
      }
      publish(trimmed);
      writePrompt();
    }
  } finally {
    rl.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}

/**
 * Interactive chat via Team Room daemon WebSocket with repo context.
 * Mirrors runChat() but routes through the Team Room daemon.
 *
 * The register message carries a `repo` field so the Team Room chat WS
 * knows which per-repo daemon to deliver publishes to. Everything else
 * — REPL loop, session tracking, prompt rendering — is identical to the
 * direct-chat path.
 */
export async function runChatViaTeamRoom(opts: {
  port: number;
  agent: string;
  user: string;
  initialBody?: string;
  repo: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  interactive: boolean;
}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/`);

  // Connect
  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", (err) => fail(err));
  });

  let sessionThreadId: string | null = null;

  const interactive = opts.interactive === true;
  const writePrompt = (): void => {
    if (interactive) opts.stdout.write("you: ");
  };

  // Set up message handling
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; from?: string; body?: string; code?: string; message?: string; threadId?: string };
      if (msg.type === "mail") {
        if (sessionThreadId === null && typeof msg.threadId === "string" && msg.threadId.length > 0) {
          sessionThreadId = msg.threadId;
        }
        if (interactive) opts.stdout.write("\n");
        opts.stdout.write(`${msg.from ?? ""}: ${msg.body ?? ""}\n`);
        if (interactive) opts.stdout.write("\n");
        writePrompt();
      } else if (msg.type === "error") {
        opts.stdout.write(`error: ${msg.code ?? ""} — ${msg.message ?? ""}\n`);
        writePrompt();
      }
    } catch {
      /* ignore malformed server frames */
    }
  });

  // Register as the user's CLI channel — with repo for Team Room daemon routing
  ws.send(
    JSON.stringify({
      type: "register",
      channel: "cli",
      externalId: opts.user,
      repo: opts.repo,
    }),
  );

  const publish = (body: string): void => {
    ws.send(
      JSON.stringify({
        type: "publish",
        to: [`agent:${opts.agent}`],
        body,
        threadId: sessionThreadId,
        cc: [],
      }),
    );
  };

  const rl = createInterface({ input: opts.stdin, terminal: false });

  ws.on("error", (err) => {
    opts.stdout.write(`error: transport — ${err.message}\n`);
    rl.close();
  });

  if (opts.initialBody) publish(opts.initialBody);

  writePrompt();

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed.length === 0) {
        writePrompt();
        continue;
      }
      publish(trimmed);
      writePrompt();
    }
  } finally {
    rl.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
