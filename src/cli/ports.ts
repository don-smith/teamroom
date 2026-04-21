import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

export function portsDir(dataDir: string): string {
  return join(dataDir, "ports");
}

export function writePortFile(dataDir: string, name: string, port: number): void {
  mkdirSync(portsDir(dataDir), { recursive: true });
  writeFileSync(join(portsDir(dataDir), `${name}.port`), String(port));
}

export function readPortFile(dataDir: string, name: string): number | null {
  const path = join(portsDir(dataDir), `${name}.port`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

export function deletePortFile(dataDir: string, name: string): void {
  try {
    unlinkSync(join(portsDir(dataDir), `${name}.port`));
  } catch {
    /* best-effort */
  }
}
