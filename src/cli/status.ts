import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { TurnRepo } from "../db/turn-repo.js";

export async function status(): Promise<void> {
  const root = resolve(process.cwd());
  const dataDir = join(root, "data");
  const pidFile = join(dataDir, "teamroom.pid");

  const daemonUp = existsSync(pidFile) && pidAlive(Number(readFileSync(pidFile, "utf8").trim()));
  process.stdout.write(`daemon:     ${daemonUp ? "running" : "not running"}\n`);

  const dbPath = join(dataDir, "teamroom.db");
  if (!existsSync(dbPath)) {
    process.stdout.write("database:   (none yet)\n");
    process.exit(daemonUp ? 0 : 1);
  }

  const db = createDatabase(dbPath);
  runMigrations(db);
  const turnRepo = new TurnRepo(db);
  const agents = new AgentRepo(db).findAll();

  process.stdout.write(`agents:     ${agents.map((a) => a.id).join(", ") || "(none)"}\n`);
  process.stdout.write(`pending:    ${turnRepo.countByStatus("pending")}\n`);
  process.stdout.write(`running:    ${turnRepo.countByStatus("running")}\n`);
  process.stdout.write(`done:       ${turnRepo.countByStatus("done")}\n`);
  process.stdout.write(`errors:     ${turnRepo.countByStatus("error")}\n`);

  const latest = turnRepo.latestDone();
  process.stdout.write(`last turn:  ${latest?.finishedAt ?? "(never)"}\n`);

  db.close();
  process.exit(daemonUp ? 0 : 1);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
