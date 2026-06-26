import { mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { loadReposYaml, saveReposYaml, REPOS_DIR, DEFAULT_AGENTS } from "../daemon/repo-config.js";

export async function repoInit(path: string): Promise<void> {
  if (!existsSync(path)) {
    process.stderr.write(`error: path does not exist: ${path}\n`);
    process.exit(1);
  }
  const name = basename(path);
  const yaml = loadReposYaml();
  if (yaml.repos[name]) {
    process.stderr.write(`error: repo '${name}' is already registered\n`);
    process.exit(1);
  }
  const repoDir = join(REPOS_DIR, name);
  mkdirSync(join(repoDir, "data", "ports"), { recursive: true });
  mkdirSync(join(repoDir, "stores"), { recursive: true });
  yaml.repos[name] = { codebasePath: path };
  saveReposYaml(yaml);
  for (const agent of DEFAULT_AGENTS) {
    mkdirSync(join(repoDir, "stores", agent), { recursive: true });
  }
  process.stdout.write([
    `Repo '${name}' registered at ${repoDir}`,
    `  Codebase: ${path}`,
    `  Agents: ${DEFAULT_AGENTS.join(", ")}`,
    `Start: teamroom serve --repo ${name}`,
    `  Meta: teamroom serve --meta`,
  ].join("\n") + "\n");
}