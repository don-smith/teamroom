import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { ReposYaml, RepoConfig } from "../types.js";

function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
}

export function teamroomDir(): string {
  return join(home(), ".teamroom");
}

export function agentsDir(): string {
  return join(teamroomDir(), "agents");
}

export function reposDir(): string {
  return join(teamroomDir(), "repos");
}

export function reposYamlPath(): string {
  return join(teamroomDir(), "repos.yaml");
}

export const TEAMROOM_DIR = teamroomDir();
export const AGENTS_DIR = agentsDir();
export const REPOS_DIR = reposDir();
export const REPOS_YAML_PATH = reposYamlPath();
/** Default agent roster when no per-repo overrides are specified. */
export const DEFAULT_AGENTS = ["archie", "doc", "libby", "micah"];

export function loadReposYaml(): ReposYaml {
  const path = reposYamlPath();
  if (!existsSync(path)) return { repos: {} };
  return YAML.parse(readFileSync(path, "utf8")) as ReposYaml;
}

export function saveReposYaml(yaml: ReposYaml): void {
  const dir = teamroomDir();
  mkdirSync(dir, { recursive: true });
  const tmp = reposYamlPath() + ".tmp";
  writeFileSync(tmp, YAML.stringify(yaml), "utf8");
  renameSync(tmp, reposYamlPath());
}

export function resolveRepoConfig(repoName: string): RepoConfig {
  const yaml = loadReposYaml();
  const entry = yaml.repos[repoName];
  if (!entry) throw new Error(`unknown repo: ${repoName}`);
  const agentNames = Object.keys(entry.agents ?? {});
  return {
    name: repoName,
    codebasePath: entry.codebasePath,
    agents: agentNames.length > 0 ? agentNames : DEFAULT_AGENTS,
  };
}

export function repoDataDir(repoName: string): string {
  return join(reposDir(), repoName, "data");
}

export function repoStoresDir(repoName: string): string {
  return join(reposDir(), repoName, "stores");
}