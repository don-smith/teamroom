import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "./agent-config.js";

describe("loadAgentConfig", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "studio-assistant");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# Assistant prompt");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: studio-assistant\nmodel: claude-opus-4-7\nimage_tag: teamroom-agent-studio-assistant:latest\n",
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("loads a valid agent config", () => {
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.name).toBe("studio-assistant");
    expect(cfg.model).toBe("claude-opus-4-7");
    expect(cfg.imageTag).toBe("teamroom-agent-studio-assistant:latest");
    expect(cfg.configPath).toBe(agentDir);
    expect(cfg.agentsMdPath).toBe(join(agentDir, "AGENTS.md"));
    expect(cfg.storePath).toBe(join(agentDir, "store"));
  });

  it("rejects when agent.yaml is missing", () => {
    rmSync(join(agentDir, "agent.yaml"));
    expect(() => loadAgentConfig(agentDir)).toThrow(/agent\.yaml/);
  });

  it("rejects when AGENTS.md is missing", () => {
    rmSync(join(agentDir, "AGENTS.md"));
    expect(() => loadAgentConfig(agentDir)).toThrow(/AGENTS\.md/);
  });

  it("rejects when store/ is missing", () => {
    rmSync(join(agentDir, "store"), { recursive: true });
    expect(() => loadAgentConfig(agentDir)).toThrow(/store/);
  });

  it("rejects when required yaml fields are missing", () => {
    writeFileSync(join(agentDir, "agent.yaml"), "name: studio-assistant\n");
    expect(() => loadAgentConfig(agentDir)).toThrow(/model|image_tag/);
  });
});
