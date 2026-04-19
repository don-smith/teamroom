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
      "name: studio-assistant\nmodel: claude-opus-4-7\nimage_tag: teamroom-agent-studio-assistant:latest\nprovider: lm-studio\n",
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
    expect(cfg.provider).toBe("lm-studio");
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

describe("loadAgentConfig — subscriptions and allowed_tools", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "studio-assistant");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# test");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("parses subscriptions as string[] (defaults to empty)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nsubscriptions:\n  - a\n  - team-wide\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.subscriptions).toEqual(["a", "team-wide"]);

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    const cfg2 = loadAgentConfig(agentDir);
    expect(cfg2.subscriptions).toEqual([]);
  });

  it("rejects non-string subscription entries", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nsubscriptions:\n  - ok\n  - 42\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/subscriptions.*must be a string/);
  });

  it("parses allowed_tools as string[] (defaults to empty)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nallowed_tools:\n  - Read\n  - Write\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.allowedTools).toEqual(["Read", "Write"]);

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    const cfg2 = loadAgentConfig(agentDir);
    expect(cfg2.allowedTools).toEqual([]);
  });
});

describe("loadAgentConfig — provider field", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "studio-assistant");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# test");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns provider when present", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("anthropic");
  });

  it("throws when provider is missing", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/provider/);
  });

  it("throws when provider is not in the allowed set", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openai\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/provider/);
  });

  it("echoes the offending provider value in the error message", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openai\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/got 'openai'/);
  });
});
