#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import os from "node:os";
import { serve } from "./serve.js";
import { send } from "./send.js";
import { status } from "./status.js";
import { readPortFile } from "./ports.js";
import { runInbox } from "./inbox.js";
import { runThread } from "./thread.js";
import { runChat } from "./chat.js";

const program = new Command();
program.name("teamroom").description("Team Room CLI").version("0.1.0");

program.command("serve").description("Run the daemon in the foreground").action(serve);

program
  .command("send <agent> <text...>")
  .description("Send a message to an agent via the chat WebSocket")
  .action(async (agent: string, text: string[]) => {
    const dataDir = join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "chat");
    if (port == null) {
      process.stderr.write("error: chat port file not found — is the daemon running?\n");
      process.exit(1);
    }
    const user = process.env["TEAMROOM_USER"] ?? os.userInfo().username;
    try {
      await send({ port, user, agent, body: text.join(" ") });
      process.stdout.write(`sent to ${agent}\n`);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
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

// Subcommand handler for `teamroom chat`
// Usage: teamroom chat <agent> [initial-body]
//
// Resolves user from TEAMROOM_USER env var with fallback to os.userInfo().username.
// Resolves port from readPortFile(dataDir, "chat").
program
  .command("chat <agent> [initial-body]")
  .description("Start an interactive chat session with an agent")
  .action(async (agent: string, initialBody: string | undefined) => {
    const dataDir = join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "chat");
    if (port == null) {
      process.stderr.write("error: chat port file not found — is the daemon running?\n");
      process.exit(1);
    }
    const user = process.env["TEAMROOM_USER"] ?? os.userInfo().username;
    // Clean exit on Ctrl-C
    process.once("SIGINT", () => process.exit(0));
    try {
      await runChat({
        port,
        agent,
        user,
        initialBody,
        stdin: process.stdin,
        stdout: process.stdout,
        interactive: true,
      });
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
