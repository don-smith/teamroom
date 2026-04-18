#!/usr/bin/env node
import { Command } from "commander";
import { serve } from "./serve.js";
import { send } from "./send.js";
import { tail } from "./tail.js";
import { status } from "./status.js";

const program = new Command();
program.name("teamroom").description("Team Room CLI").version("0.1.0");

program.command("serve").description("Run the daemon in the foreground").action(serve);

program
  .command("send <text...>")
  .description("Queue an inbound message for the sole agent")
  .action(async (text: string[]) => {
    await send(text.join(" "));
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

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
