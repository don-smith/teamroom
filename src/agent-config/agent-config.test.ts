import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
    expect(cfg.runtime).toBe("langgraph");
    expect(cfg.lifecycle).toBe("session");
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

  it("loads the real pi-coder agent config", () => {
    const cfg = loadAgentConfig(join(process.cwd(), "agents/pi-coder"));
    expect(cfg).toMatchObject({
      name: "pi-coder",
      runtime: "pi",
      provider: "openai",
      model: "openai/gpt-5.5",
    });
  });

  it("loads the real Archie agent config", () => {
    const cfg = loadAgentConfig(join(process.cwd(), "agents/archie"));
    expect(cfg).toMatchObject({
      name: "archie",
      runtime: "deepagents",
      provider: "lm-studio",
      model: "qwen/qwen3.6-27b",
      lifecycle: "persistent",
    });
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

  it("parses list:* subscriptions (defaults to empty)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nsubscriptions:\n  - list:harness-activity\n  - list:team-wide\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.subscriptions).toEqual(["list:harness-activity", "list:team-wide"]);

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
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nsubscriptions:\n  - list:ok\n  - 42\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/subscriptions.*must be a string/);
  });

  it("rejects non-list:* subscriptions (M4: only list:<name> allowed)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nsubscriptions:\n  - bare-name\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/list:<name>/);
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

describe("loadAgentConfig — lifecycle field", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "a");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# test");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("defaults lifecycle to 'session' when omitted", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("session");
  });

  it("parses lifecycle: persistent", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nlifecycle: persistent\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("persistent");
  });

  it("rejects unknown lifecycle values", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nlifecycle: forever\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/lifecycle.*'session'.*'persistent'.*got 'forever'/);
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
      "name: x\nmodel: y\nimage_tag: z\nprovider: bespoke\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/provider/);
  });

  it("echoes the offending provider value in the error message", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: bespoke\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/got 'bespoke'/);
  });

  it("accepts provider: ollama", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: m\nimage_tag: t\nprovider: ollama\nsubscriptions: []\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("ollama");
  });

  it("accepts provider: openai", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: openai/gpt-5.5\nimage_tag: t\nprovider: openai\nruntime: pi\nsubscriptions: []\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("openai");
    expect(cfg.runtime).toBe("pi");
  });
});

describe("loadAgentConfig — runtime field", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "runtime-agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# test");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("infers runtime from provider when runtime is omitted", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\n",
    );
    expect(loadAgentConfig(agentDir).runtime).toBe("anthropic");

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: lm-studio\n",
    );
    expect(loadAgentConfig(agentDir).runtime).toBe("langgraph");

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: ollama\n",
    );
    expect(loadAgentConfig(agentDir).runtime).toBe("langgraph");

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openai\n",
    );
    expect(loadAgentConfig(agentDir).runtime).toBe("langgraph");
  });

  it("accepts explicit runtime: pi with an existing model provider", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: pi-coder\nmodel: claude-opus-4-7\nimage_tag: teamroom-agent-pi-coder:latest\nruntime: pi\nprovider: anthropic\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.runtime).toBe("pi");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-opus-4-7");
  });

  it("accepts explicit runtime: deepagents with an existing model provider", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: archie\nmodel: qwen/qwen3.6-27b\nimage_tag: teamroom-agent-archie:latest\nruntime: deepagents\nprovider: lm-studio\nlifecycle: persistent\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.runtime).toBe("deepagents");
    expect(cfg.provider).toBe("lm-studio");
    expect(cfg.lifecycle).toBe("persistent");
  });

  it("rejects unknown runtime values", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nruntime: bespoke\nprovider: anthropic\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*anthropic.*langgraph.*pi.*deepagents/);
  });

  it("rejects runtime: anthropic with a non-anthropic provider", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: openai/gpt-5.5\nimage_tag: z\nruntime: anthropic\nprovider: openai\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*provider/);
  });

  it("rejects runtime: langgraph with provider: anthropic", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: claude-opus-4-7\nimage_tag: z\nruntime: langgraph\nprovider: anthropic\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*provider/);
  });
});
