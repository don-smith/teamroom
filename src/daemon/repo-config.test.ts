import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  loadReposYaml, saveReposYaml, repoDataDir, repoStoresDir,
  resolveRepoConfig, reposYamlPath, teamroomDir,
} from "./repo-config.js";

describe("repo-config", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    const base = mkdtempSync(join(tmpdir(), "teamroom-repoconfig-"));
    process.env.HOME = base;
  });

  afterEach(() => {
    const base = process.env.HOME;
    process.env.HOME = originalHome;
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("saveReposYaml writes YAML that round-trips correctly", () => {
    const data = {
      repos: {
        teamroom: { codebasePath: "/home/user/projects/teamroom" },
        myflow: {
          codebasePath: "/home/user/projects/myflow",
          agents: { archie: { model: "deepseek/deepseek-v4-flash" } },
        },
      },
    };
    saveReposYaml(data);
    expect(loadReposYaml()).toEqual(data);
  });

  it("saveReposYaml creates ~/.teamroom/ if needed", () => {
    const dir = teamroomDir();
    expect(existsSync(dir)).toBe(false);
    saveReposYaml({ repos: { test: { codebasePath: "/tmp" } } });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(reposYamlPath())).toBe(true);
  });

  it("loadReposYaml returns empty for missing file", () => {
    expect(loadReposYaml()).toEqual({ repos: {} });
  });

  it("resolveRepoConfig throws for unknown repo", () => {
    saveReposYaml({ repos: { known: { codebasePath: "/tmp" } } });
    expect(() => resolveRepoConfig("unknown")).toThrow("unknown repo: unknown");
  });

  it("resolveRepoConfig returns default agents when no overrides", () => {
    saveReposYaml({ repos: { myrepo: { codebasePath: "/tmp/myrepo" } } });
    expect(resolveRepoConfig("myrepo")).toMatchObject({
      name: "myrepo", codebasePath: "/tmp/myrepo", agents: ["archie", "doc", "libby", "micah"],
    });
  });

  it("resolveRepoConfig returns agent names from overrides", () => {
    saveReposYaml({
      repos: {
        myrepo: {
          codebasePath: "/tmp/myrepo",
          agents: { archie: { model: "gpt-4" }, doc: {} },
        },
      },
    });
    expect(resolveRepoConfig("myrepo").agents).toEqual(["archie", "doc"]);
  });

  it("repoDataDir returns correct path", () => {
    expect(repoDataDir("myrepo")).toContain(".teamroom/repos/myrepo/data");
  });

  it("repoStoresDir returns correct path", () => {
    expect(repoStoresDir("myrepo")).toContain(".teamroom/repos/myrepo/stores");
  });
});