import { describe, expect, it } from "bun:test";
import { buildSpec } from "./build-spec.js";
import { TokenRegistry } from "../model-proxy/token-registry.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

describe("buildSpec", () => {
  const cfg: AgentConfig = {
    name: "alice",
    model: "deepseek/deepseek-v4-flash",
    imageTag: "teamroom-agent-alice:latest",
    provider: "openrouter",
    runtime: "pi",
    configPath: "/agents/alice",
    agentsMdPath: "/agents/alice/AGENTS.md",
    storePath: "/agents/alice/store",
    subscriptions: [],
    allowedTools: ["mail.send"],
    lifecycle: "session",
  };

  it("constructs a DockerRunSpec with mail-MCP URL, model proxy URL, and tokens", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "mcp-tok-abcdef12",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: "/codebase",
      myflowSkillsPath: "/myflow-skills",
      genId: () => "trace-1",
    });

    expect(spec.imageTag).toBe("teamroom-agent-alice:latest");
    expect(spec.name).toContain("teamroom-alice-mcp-tok-");
    expect(spec.env.TEAMROOM_AGENT_NAME).toBe("alice");
    expect(spec.env.TEAMROOM_RUNTIME).toBe("pi");
    expect(spec.env.TEAMROOM_PROVIDER).toBe("openrouter");
    expect(spec.env.TEAMROOM_MCP_URL).toBe("http://host.docker.internal:7777/mcp");
    expect(spec.env.TEAMROOM_MCP_TOKEN).toBe("mcp-tok-abcdef12");
    expect(spec.env.TEAMROOM_MODEL_BASE_URL).toBe("http://host.docker.internal:9000");
    expect(spec.env.TEAMROOM_ALLOWED_TOOLS).toBe("mail.send");
    expect(spec.mounts.find((m) => m.containerPath === "/codebase")).toBeDefined();
    expect(spec.mounts.find((m) => m.containerPath === "/AGENTS.md")).toBeDefined();
    expect(spec.mounts.find((m) => m.containerPath === "/store")).toBeDefined();
    expect(spec.mounts.find((m) => m.containerPath === "/myflow-skills")).toBeDefined();
    const skillsMount = spec.mounts.find((m) => m.containerPath === "/myflow-skills");
    expect(skillsMount).toBeDefined();
    if (skillsMount) {
      expect(skillsMount.readOnly).toBe(true);
    }
  });

  it("omits the codebase mount when codebasePath is null", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "x",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
    });
    expect(spec.mounts.find((m) => m.containerPath === "/codebase")).toBeUndefined();
  });

  it("omits the myflow-skills mount when myflowSkillsPath is null", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "x",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
    });
    expect(spec.mounts.find((m) => m.containerPath === "/myflow-skills")).toBeUndefined();
  });

  it("uses storeBasePath for per-repo store mount when provided", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "x",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
      storeBasePath: "/home/user/.teamroom/repos/myproject/stores",
    });

    const storeMount = spec.mounts.find((m) => m.containerPath === "/store");
    expect(storeMount).toBeDefined();
    expect(storeMount!.hostPath).toBe(
      "/home/user/.teamroom/repos/myproject/stores/alice",
    );
  });

  it("falls back to cfg.storePath when storeBasePath is not provided", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "x",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
    });

    const storeMount = spec.mounts.find((m) => m.containerPath === "/store");
    expect(storeMount).toBeDefined();
    expect(storeMount!.hostPath).toBe("/agents/alice/store");
  });

  it("sets runtime and provider env vars for pi agents", () => {
    const tokenRegistry = new TokenRegistry(() => "proxy-token");
    const piCfg: AgentConfig = {
      ...cfg,
      name: "pi-coder",
      runtime: "pi",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      imageTag: "teamroom-agent-pi-coder:latest",
    };
    const spec = buildSpec({
      agentId: "pi-coder",
      mcpToken: "mcp-token",
      agentConfigs: new Map([["pi-coder", piCfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: "/codebase",
      myflowSkillsPath: "/myflow-skills",
      genId: () => "trace-1",
    });

    expect(spec.env.TEAMROOM_RUNTIME).toBe("pi");
    expect(spec.env.TEAMROOM_PROVIDER).toBe("openrouter");
    expect(spec.env.TEAMROOM_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(tokenRegistry.lookup("proxy-token")).toMatchObject({
      agentId: "pi-coder",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
  });

  it("supports the DeepAgents runtime while preserving provider for token routing", () => {
    const tokenRegistry = new TokenRegistry(() => "archie-proxy-token");
    const archie: AgentConfig = {
      ...cfg,
      name: "archie",
      model: "deepseek/deepseek-v4-flash",
      imageTag: "teamroom-agent-archie:latest",
      provider: "openrouter",
      runtime: "deepagents",
      lifecycle: "persistent",
    };
    const spec = buildSpec({
      agentId: "archie",
      mcpToken: "mcp-tok",
      agentConfigs: new Map([["archie", archie]]),
      tokenRegistry,
      modelBaseUrl: "http://proxy",
      mailPort: 9000,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
    });

    expect(spec.env.TEAMROOM_RUNTIME).toBe("deepagents");
    expect(spec.env.TEAMROOM_PROVIDER).toBe("openrouter");
    expect(spec.env.TEAMROOM_MODEL_API_TOKEN).toBe("archie-proxy-token");
    expect(tokenRegistry.lookup("archie-proxy-token")).toMatchObject({
      agentId: "archie",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
    });
  });

  it("throws when agentConfigs has no entry for agentId", () => {
    const tokenRegistry = new TokenRegistry();
    expect(() =>
      buildSpec({
        agentId: "ghost",
        mcpToken: "x",
        agentConfigs: new Map(),
        tokenRegistry,
        modelBaseUrl: "http://host.docker.internal:9000",
        mailPort: 7777,
        codebasePath: null,
        myflowSkillsPath: null,
        genId: () => "trace-1",
      }),
    ).toThrow(/no agent config for 'ghost'/);
  });

  it("includes the labels expected by docker-runner discovery", () => {
    const tokenRegistry = new TokenRegistry();
    const spec = buildSpec({
      agentId: "alice",
      mcpToken: "x",
      agentConfigs: new Map([["alice", cfg]]),
      tokenRegistry,
      modelBaseUrl: "http://host.docker.internal:9000",
      mailPort: 7777,
      codebasePath: null,
      myflowSkillsPath: null,
      genId: () => "trace-1",
    });
    const { labels } = spec;
    expect(labels).toBeDefined();
    if (!labels) throw new Error("expected buildSpec to set docker labels");
    expect(labels["teamroom-agent"]).toBe("true");
    expect(labels["teamroom-agent-id"]).toBe("alice");
  });
});
