import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { readPortFile } from "./ports.js";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
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
  conversationId: string;
}

export interface SendToDbOpts {
  repoRoot: string;
  body: string;
  agentName?: string;
}

export async function sendToDb(opts: SendToDbOpts): Promise<SendToDbResult> {
  const root = resolve(opts.repoRoot);
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) throw new Error(`no agents/ directory at ${agentsDir}`);

  const entries = readdirSync(agentsDir).filter((e) => statSync(join(agentsDir, e)).isDirectory());
  if (entries.length === 0) throw new Error("no agent folders found");
  let entry: string;
  if (opts.agentName) {
    if (!entries.includes(opts.agentName)) {
      throw new Error(`agent '${opts.agentName}' not found in ${agentsDir}; available: ${entries.join(", ")}`);
    }
    entry = opts.agentName;
  } else {
    entry = entries[0]!;
  }
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
  const conversationId = randomUUID();
  new MessageRepo(db).create({
    id: messageId,
    agentId: cfg.name,
    channel: "cli",
    direction: "in",
    body: opts.body,
    turnId: null,
    traceId,
    createdAt: new Date().toISOString(),
    topic: "",
    fromAgentId: null,
    conversationId,
  });
  db.close();

  const daemonRunning = existsSync(join(dataDir, "teamroom.pid"));

  return { traceId, messageId, agentName: cfg.name, daemonRunning, conversationId };
}

export interface SendViaHttpOpts {
  port: number;
  user: string;
  target: string;
  body: string;
  threadId?: string | null;
}

export interface SendViaHttpResult {
  threadId: string;
  rowIds: string[];
}

/**
 * POST to the daemon's `/cli/send` endpoint. The daemon's dispatcher writes
 * the mail row AND publishes `mail.delivered` on the bus — which is what
 * wakes the target agent in M4. Writing directly to the DB (the M3 path)
 * bypasses the bus, so the target never gets spawned.
 */
export async function sendViaHttp(opts: SendViaHttpOpts): Promise<SendViaHttpResult> {
  const res = await fetch(`http://127.0.0.1:${opts.port}/cli/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: opts.user,
      target: opts.target,
      body: opts.body,
      ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`daemon rejected: ${res.status} ${text}`);
  }
  return JSON.parse(text) as SendViaHttpResult;
}

/**
 * Read the daemon-written mail-server port. Returns null if the daemon
 * hasn't published one (daemon not running, or M3 daemon with no MCP
 * server). The CLI uses this to decide between the HTTP path (M4) and
 * the legacy direct-DB path (M3 behavior — kept during the transition).
 */
export function readMailPort(dataDir: string): number | null {
  return readPortFile(dataDir, "mail-mcp");
}

export async function send(body: string, agentName?: string): Promise<void> {
  const root = resolve(process.cwd());
  const dataDir = join(root, "data");
  const port = readMailPort(dataDir);
  if (port != null) {
    const target = agentName ?? defaultAgent(root);
    const result = await sendViaHttp({
      port,
      user: os.userInfo().username,
      target,
      body,
    });
    process.stdout.write(`sent to ${target} (thread: ${result.threadId})\n`);
    return;
  }
  const result = await sendToDb({ repoRoot: process.cwd(), body, agentName });
  process.stdout.write(
    `queued for ${result.agentName} (trace: ${result.traceId})${
      result.daemonRunning ? "" : "  [warning: daemon not running — message will be processed when daemon starts]"
    }\n`,
  );
}

function defaultAgent(root: string): string {
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) throw new Error(`no agents/ directory at ${agentsDir}`);
  const entries = readdirSync(agentsDir).filter((e) => statSync(join(agentsDir, e)).isDirectory());
  if (entries.length === 0) throw new Error("no agent folders found");
  return entries[0]!;
}
