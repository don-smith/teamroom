#!/usr/bin/env bun
import { Command } from "commander";
import { resolve, join } from "node:path";
import os from "node:os";
import { serveMeta } from "./serve-meta.js";
import { serveRepo } from "./serve-repo.js";
import { send, sendViaMeta } from "./send.js";
import { status } from "./status.js";
import { readPortFile } from "./ports.js";
import { runInbox } from "./inbox.js";
import { runThread } from "./thread.js";
import { runChat, runChatViaMeta } from "./chat.js";
import { repoInit } from "./repo-init.js";
import { repoList } from "./repo-list.js";
import { repoRemove } from "./repo-remove.js";
import { TEAMROOM_DIR } from "../daemon/repo-config.js";

const program = new Command();
program.name("teamroom").description("Team Room CLI").version("0.1.0");

// ── serve (meta-process is the default; --repo starts a per-repo daemon) ──
program
  .command("serve")
  .description("Start a teamroom process (default: meta-process gateway)")
  .option("--meta", "Start the meta-process gateway (default)")
  .option("--repo <name>", "Start a per-repo daemon")
  .action(async (opts) => {
    if (opts.repo) {
      await serveRepo(opts.repo);
    } else {
      // Default: meta-process
      await serveMeta();
    }
  });

// ── repo management subcommand group ──
const repoCmd = program.command("repo").description("Manage repos registered with Team Room");
repoCmd
  .command("init <path>")
  .description("Register a new repo")
  .action(async (path: string) => { await repoInit(resolve(path)); });
repoCmd
  .command("list")
  .description("List all registered repos")
  .action(repoList);
repoCmd
  .command("remove <name>")
  .option("--keep-data", "Keep instead of archiving")
  .description("Unregister a repo")
  .action(async (name, opts) => { await repoRemove(name, { keepData: opts.keepData }); });

// ── send ──
program
  .command("send <agent> <text...>")
  .description("Send a message to an agent")
  .action(async (agent, text) => {
    const repo = resolveRepoFromEnv();
    const user = process.env["TEAMROOM_USER"] ?? os.userInfo().username;
    if (repo) {
      const metaPort = readPortFile(join(TEAMROOM_DIR, "meta", "data"), "chat");
      if (!metaPort) { process.stderr.write("error: meta-process not running\n"); process.exit(1); }
      await sendViaMeta({ port: metaPort, user, agent, body: text.join(" "), repo });
    } else {
      const dataDir = join(resolve(process.cwd()), "data");
      const port = readPortFile(dataDir, "chat");
      if (!port) { process.stderr.write("error: chat port file not found\n"); process.exit(1); }
      await send({ port, user, agent, body: text.join(" ") });
    }
    process.stdout.write(`sent to ${agent}\n`);
  });

program
  .command("status")
  .description("Show daemon/turn status")
  .action(async () => {
    const repo = resolveRepoFromEnv();
    const dataDir = repo
      ? join(TEAMROOM_DIR, "repos", repo, "data")
      : join(resolve(process.cwd()), "data");
    await status(dataDir);
  });

program
  .command("inbox <agent>")
  .description("List unread messages")
  .action(async (agent) => {
    const repo = resolveRepoFromEnv();
    const dataDir = repo
      ? join(TEAMROOM_DIR, "repos", repo, "data")
      : join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "mail");
    if (!port) { process.stderr.write("error: mail port file not found\n"); process.exit(1); }
    try { await runInbox({ port, agent, out: (l) => process.stdout.write(l + "\n") }); }
    catch (err) { process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
  });

program
  .command("thread <id>")
  .description("List messages in a thread")
  .action(async (id) => {
    const repo = resolveRepoFromEnv();
    const dataDir = repo
      ? join(TEAMROOM_DIR, "repos", repo, "data")
      : join(resolve(process.cwd()), "data");
    const port = readPortFile(dataDir, "mail");
    if (!port) { process.stderr.write("error: mail port file not found\n"); process.exit(1); }
    try { await runThread({ port, threadId: id, out: (l) => process.stdout.write(l + "\n") }); }
    catch (err) { process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
  });

program
  .command("chat <agent> [initial-body]")
  .description("Interactive chat session")
  .action(async (agent, initialBody) => {
    const repo = resolveRepoFromEnv();
    const user = process.env["TEAMROOM_USER"] ?? os.userInfo().username;
    process.once("SIGINT", () => process.exit(0));
    if (repo) {
      const metaPort = readPortFile(join(TEAMROOM_DIR, "meta", "data"), "chat");
      if (!metaPort) { process.stderr.write("error: meta-process not running\n"); process.exit(1); }
      await runChatViaMeta({ port: metaPort, agent, user, initialBody, repo, stdin: process.stdin, stdout: process.stdout, interactive: true });
    } else {
      const dataDir = join(resolve(process.cwd()), "data");
      const port = readPortFile(dataDir, "chat");
      if (!port) { process.stderr.write("error: chat port file not found\n"); process.exit(1); }
      await runChat({ port, agent, user, initialBody, stdin: process.stdin, stdout: process.stdout, interactive: true });
    }
  });

function resolveRepoFromEnv(): string | null {
  return process.env["TEAMROOM_REPO"] ?? null;
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});