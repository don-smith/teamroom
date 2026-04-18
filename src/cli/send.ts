import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { loadAgentConfig } from "../agent-config/agent-config.js";

export interface SendToDbResult {
  traceId: string;
  messageId: string;
  agentName: string;
  daemonRunning: boolean;
}

export interface SendToDbOpts {
  repoRoot: string;
  body: string;
}

export async function sendToDb(opts: SendToDbOpts): Promise<SendToDbResult> {
  const root = resolve(opts.repoRoot);
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) throw new Error(`no agents/ directory at ${agentsDir}`);

  const entries = readdirSync(agentsDir).filter((e) => statSync(join(agentsDir, e)).isDirectory());
  if (entries.length === 0) throw new Error("no agent folders found");
  const entry = entries[0]!;
  const cfg = loadAgentConfig(join(agentsDir, entry));

  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = createDatabase(join(dataDir, "teamroom.db"));
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  if (!agentRepo.findById(cfg.name)) {
    agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: new Date().toISOString() });
  }
  const messageId = randomUUID();
  const traceId = randomUUID();
  new MessageRepo(db).create({
    id: messageId,
    agentId: cfg.name,
    channel: "cli",
    direction: "in",
    body: opts.body,
    turnId: null,
    traceId,
    createdAt: new Date().toISOString(),
  });
  db.close();

  const daemonRunning = existsSync(join(dataDir, "teamroom.pid"));

  return { traceId, messageId, agentName: cfg.name, daemonRunning };
}

export async function send(body: string): Promise<void> {
  const result = await sendToDb({ repoRoot: process.cwd(), body });
  process.stdout.write(
    `queued for ${result.agentName} (trace: ${result.traceId})${
      result.daemonRunning ? "" : "  [warning: daemon not running — message will be processed when daemon starts]"
    }\n`,
  );
}
