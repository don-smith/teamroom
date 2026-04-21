import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPortFile } from "./ports.js";

export async function status(): Promise<void> {
  const root = resolve(process.cwd());
  const dataDir = join(root, "data");
  const pidFile = join(dataDir, "teamroom.pid");

  if (!existsSync(pidFile)) {
    process.stdout.write("daemon:    not running\n");
    process.exit(1);
  }

  const pid = Number(readFileSync(pidFile, "utf8").trim());
  const alive = pidAlive(pid);
  process.stdout.write(`daemon:    pid ${pid} (${alive ? "alive" : "dead"})\n`);

  const mailMcpPort = readPortFile(dataDir, "mail-mcp");
  const chatPort = readPortFile(dataDir, "chat");
  const mailPort = readPortFile(dataDir, "mail");

  process.stdout.write(`mail-mcp:  ${mailMcpPort != null ? `127.0.0.1:${mailMcpPort}` : "(no port file)"}\n`);
  process.stdout.write(`chat:      ${chatPort != null ? `127.0.0.1:${chatPort}` : "(no port file)"}\n`);
  process.stdout.write(`mail:      ${mailPort != null ? `127.0.0.1:${mailPort}` : "(no port file)"}\n`);

  process.exit(alive ? 0 : 1);
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
