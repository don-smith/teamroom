import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "./agent-config.js";

describe("loadAgentConfig", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "test-agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# Agent prompt");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: test-agent\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-test:latest\nprovider: openrouter\nruntime: deepagents\n",
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("loads a valid agent config with deepagents runtime", () => {
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.name).toBe("test-agent");
    expect(cfg.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.imageTag).toBe("teamroom-agent-test:latest");
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.runtime).toBe("deepagents");
    expect(cfg.lifecycle).toBe("session");
    expect(cfg.configPath).toBe(agentDir);
    expect(cfg.agentsMdPath).toBe(join(agentDir, "AGENTS.md"));
    expect(cfg.storePath).toBe(join(agentDir, "store"));
  });

  it("loads a valid agent config with pi runtime", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: pi-agent\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-pi:latest\nprovider: openrouter\nruntime: pi\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.runtime).toBe("pi");
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
    writeFileSync(join(agentDir, "agent.yaml"), "name: test-agent\n");
    expect(() => loadAgentConfig(agentDir)).toThrow(/model|image_tag/);
  });

  it("loads the real micah agent config", () => {
    const cfg = loadAgentConfig(join(process.cwd(), "agents/micah"));
    expect(cfg).toMatchObject({
      name: "micah",
      runtime: "pi",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
  });

  it("loads the real Archie agent config", () => {
    const cfg = loadAgentConfig(join(process.cwd(), "agents/archie"));
    expect(cfg).toMatchObject({
      name: "archie",
      runtime: "deepagents",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      lifecycle: "persistent",
    });
  });
});

describe("loadAgentConfig — subscriptions and allowed_tools", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "test-agent");
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
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\nsubscriptions:\n  - list:harness-activity\n  - list:team-wide\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.subscriptions).toEqual(["list:harness-activity", "list:team-wide"]);

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\n",
    );
    const cfg2 = loadAgentConfig(agentDir);
    expect(cfg2.subscriptions).toEqual([]);
  });

  it("rejects non-string subscription entries", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\nsubscriptions:\n  - list:ok\n  - 42\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/subscriptions.*must be a string/);
  });

  it("rejects non-list:* subscriptions", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\nsubscriptions:\n  - bare-name\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/list:<name>/);
  });

  it("parses allowed_tools as string[] (defaults to empty)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\nallowed_tools:\n  - Read\n  - Write\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.allowedTools).toEqual(["Read", "Write"]);

    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\n",
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
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("session");
  });

  it("parses lifecycle: persistent", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: deepagents\nlifecycle: persistent\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.lifecycle).toBe("persistent");
  });

  it("rejects unknown lifecycle values", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\nlifecycle: forever\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/lifecycle.*'session'.*'persistent'.*got 'forever'/);
  });
});

describe("loadAgentConfig — provider field", () => {
  let base: string;
  let agentDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "teamroom-agent-"));
    agentDir = join(base, "test-agent");
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
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\nruntime: pi\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("openrouter");
  });

  it("throws when provider is missing", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/provider/);
  });

  it("throws when provider is not openrouter", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: anthropic\nruntime: pi\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/provider/);
  });

  it("echoes the offending provider value in the error message", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: lm-studio\nruntime: pi\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/got 'lm-studio'/);
  });

  it("accepts provider: openrouter with deepagents runtime", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: deepseek/deepseek-v4-flash\nimage_tag: t\nprovider: openrouter\nruntime: deepagents\nsubscriptions: []\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.runtime).toBe("deepagents");
  });

  it("accepts provider: openrouter with pi runtime", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      `name: x\nmodel: deepseek/deepseek-v4-flash\nimage_tag: t\nprovider: openrouter\nruntime: pi\nsubscriptions: []\n`,
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.provider).toBe("openrouter");
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

  it("throws when runtime is omitted (must be explicit with openrouter-only provider)", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nprovider: openrouter\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*required/);
  });

  it("accepts explicit runtime: pi", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: pi-agent\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-pi:latest\nruntime: pi\nprovider: openrouter\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.runtime).toBe("pi");
    expect(cfg.provider).toBe("openrouter");
  });

  it("accepts explicit runtime: deepagents", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: deep-agent\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-deep:latest\nruntime: deepagents\nprovider: openrouter\nlifecycle: persistent\n",
    );
    const cfg = loadAgentConfig(agentDir);
    expect(cfg.runtime).toBe("deepagents");
    expect(cfg.provider).toBe("openrouter");
    expect(cfg.lifecycle).toBe("persistent");
  });

  it("rejects unknown runtime values", () => {
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: x\nmodel: y\nimage_tag: z\nruntime: bespoke\nprovider: openrouter\n",
    );
    expect(() => loadAgentConfig(agentDir)).toThrow(/runtime.*must be.*pi.*deepagents/);
  });
});

describe("loadAgentConfig — every checked-in agent.yaml loads", () => {
  const agentsDir = join(process.cwd(), "agents");
  if (!existsSync(agentsDir)) {
    it.skip("no agents/ directory", () => {});
  } else {
    const entries = readdirSync(agentsDir)
      .map((name) => join(agentsDir, name))
      .filter((full) => statSync(full).isDirectory());
    for (const full of entries) {
      const name = full.split("/").pop() ?? full;
      it(`loads agents/${name}/agent.yaml without runtime/provider mismatch`, () => {
        const cfg = loadAgentConfig(full);
        expect(cfg.name).toBe(name);
        expect(cfg.runtime).toBeDefined();
        expect(cfg.provider).toBeDefined();
      });
    }
  }
});