import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReposYaml, REPOS_DIR } from "../daemon/repo-config.js";

export async function repoList(): Promise<void> {
  const yaml = loadReposYaml();
  const entries = Object.entries(yaml.repos);
  if (entries.length === 0) {
    process.stdout.write("No repos registered.\n");
    return;
  }
  for (const [name, entry] of entries) {
    const portFile = join(REPOS_DIR, name, "data", "ports", "mail-mcp.port");
    const running = existsSync(portFile);
    process.stdout.write([
      `${name}:`,
      `  Codebase: ${entry.codebasePath}`,
      running
        ? `  Status: ✓ running (port: ${readFileSync(portFile, "utf8").trim()})`
        : "  Status: ✗ not running",
    ].join("\n") + "\n");
  }
}