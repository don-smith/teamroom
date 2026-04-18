import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { MessageRepo } from "../db/message-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import type { BusEvent, MessageOutboundEvent } from "../types.js";

export interface TailOptions {
  json: boolean;
  verbose: boolean;
}

export interface TailRunArgs {
  repoRoot: string;
  options: TailOptions;
  out: (line: string) => void;
  stopAfter?: number;                // test hook — exit after N events
}

export async function tailRun(args: TailRunArgs): Promise<void> {
  const root = resolve(args.repoRoot);
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const busDir = join(dataDir, "bus");
  if (!existsSync(busDir)) mkdirSync(busDir, { recursive: true });
  const dbPath = join(dataDir, "teamroom.db");

  const db = createDatabase(dbPath);
  runMigrations(db);
  const messageRepo = new MessageRepo(db);

  const bus = new FileNotifyBus(busDir);

  let count = 0;
  try {
    for await (const event of bus.subscribe((e) => e.type === "message.outbound")) {
      const m = event as MessageOutboundEvent;
      const msg = messageRepo.findById(m.messageId);
      if (!msg) continue;

      if (args.options.json) {
        args.out(JSON.stringify({ ...event, body: msg.body }));
      } else {
        const prefix = args.options.verbose
          ? `[${m.traceId.slice(0, 8)} turn=${m.turnId.slice(0, 8)}] `
          : "";
        args.out(`${prefix}${msg.body}`);
      }
      count += 1;
      if (args.stopAfter && count >= args.stopAfter) break;
    }
  } finally {
    await bus.close();
    db.close();
  }
}

export async function tail(options: TailOptions): Promise<void> {
  await tailRun({
    repoRoot: process.cwd(),
    options,
    out: (line) => process.stdout.write(line + "\n"),
  });
}

export type { BusEvent };
