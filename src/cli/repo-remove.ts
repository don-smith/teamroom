import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadReposYaml, saveReposYaml, REPOS_DIR } from "../daemon/repo-config.js";

export async function repoRemove(name: string, opts: { keepData?: boolean } = {}): Promise<void> {
  const yaml = loadReposYaml();
  if (!yaml.repos[name]) {
    process.stderr.write(`error: repo '${name}' is not registered\n`);
    process.exit(1);
  }
  // Archive BEFORE mutating YAML — if rename fails, YAML is left untouched
  if (!opts.keepData && existsSync(join(REPOS_DIR, name))) {
    const archivePath = join(REPOS_DIR, `${name}.${Date.now()}.bak`);
    try {
      renameSync(join(REPOS_DIR, name), archivePath);
      process.stdout.write(`Data archived to ${archivePath}\n`);
    } catch (err) {
      process.stderr.write(
        `warning: could not archive data: ${err instanceof Error ? err.message : String(err)}\n` +
        "  The repo will still be removed from the registry.\n" +
        "  To retry the archive, use: mv " +
        `${join(REPOS_DIR, name)} ${archivePath}\n`,
      );
    }
  }
  delete yaml.repos[name];
  saveReposYaml(yaml);
  process.stdout.write(`Repo '${name}' removed.\n`);
}