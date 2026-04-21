#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import { serve } from "./serve.js";
import { send } from "./send.js";
import { tail } from "./tail.js";
import { status } from "./status.js";
import { readPortFile } from "./ports.js";
import { runInbox } from "./inbox.js";
import { runThread } from "./thread.js";

const program = new Command();
program.name("teamroom").description("Team Room CLI").version("0.1.0");

program.command("serve").description("Run the daemon in the foreground").action(serve);

program
  .command("send <text...>")
  .description("Queue an inbound message for an agent")
  .option("--agent <name>", "agent folder name (defaults to alphabetically first)")
  .action(async (text: string[], opts: { agent?: string }) => {
    await send(text.join(" "), opts.agent);
  });

program
  .command("tail")
  .description("Stream outbound messages as they arrive")
  .option("--json", "emit raw JSON events")
  .option("--verbose", "include trace/turn IDs")
  .action(async (opts: { json?: boolean; verbose?: boolean }) => {
    await tail({ json: !!opts.json, verbose: !!opts.verbose });
  });

program.command("status").description("Show daemon/turn status").action(status);

program
  .command("inbox <agent>")
  .description("List unread messages in an agent's inbox")
  .action(async (agent: string) => {
    const dataDir = join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "mail");
    if (port == null) {
      process.stderr.write("error: mail port file not found — is the daemon running?\n");
      process.exit(1);
    }
    try {
      await runInbox({ port, agent, out: (l) => process.stdout.write(l + "\n") });
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("thread <id>")
  .description("List all messages in a thread")
  .action(async (id: string) => {
    const dataDir = join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "mail");
    if (port == null) {
      process.stderr.write("error: mail port file not found — is the daemon running?\n");
      process.exit(1);
    }
    try {
      await runThread({ port, threadId: id, out: (l) => process.stdout.write(l + "\n") });
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
