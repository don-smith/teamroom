import { describe, expect, it } from "vitest";
import { buildSpec } from "./build-spec.js";
import { TokenRegistry } from "../model-proxy/token-registry.js";
import type { AgentConfig } from "../agent-config/agent-config.js";

describe("buildSpec", () => {
  const cfg: AgentConfig = {
    name: "alice",
    model: "claude-opus-4-7",
    imageTag: "teamroom-agent-alice:latest",
    provider: "anthropic",
    configPath: "/agents/alice",
    agentsMdPath: "/agents/alice/AGENTS.md",
    storePath: "/agents/alice/store",
    subscriptions: [],
    allowedTools: ["mail.send"],
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
      genId: () => "trace-1",
    });

    expect(spec.imageTag).toBe("teamroom-agent-alice:latest");
    expect(spec.name).toContain("teamroom-alice-mcp-tok-");
    expect(spec.env.TEAMROOM_AGENT_NAME).toBe("alice");
    expect(spec.env.TEAMROOM_MCP_URL).toBe("http://host.docker.internal:7777/mcp");
    expect(spec.env.TEAMROOM_MCP_TOKEN).toBe("mcp-tok-abcdef12");
    expect(spec.env.TEAMROOM_MODEL_BASE_URL).toBe("http://host.docker.internal:9000");
    expect(spec.env.ANTHROPIC_BASE_URL).toBe("http://host.docker.internal:9000");
    expect(spec.env.TEAMROOM_ALLOWED_TOOLS).toBe("mail.send");
    expect(spec.mounts.find((m) => m.containerPath === "/codebase")).toBeDefined();
    expect(spec.mounts.find((m) => m.containerPath === "/AGENTS.md")).toBeDefined();
    expect(spec.mounts.find((m) => m.containerPath === "/store")).toBeDefined();
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
      genId: () => "trace-1",
    });
    expect(spec.mounts.find((m) => m.containerPath === "/codebase")).toBeUndefined();
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
      genId: () => "trace-1",
    });
    expect(spec.labels["teamroom-agent"]).toBe("true");
    expect(spec.labels["teamroom-agent-id"]).toBe("alice");
  });
});
