import type { DockerRunSpec, Mount } from "../container/docker-command.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { TokenRegistry } from "../model-proxy/token-registry.js";

export interface BuildSpecArgs {
  agentId: string;
  mcpToken: string;
  agentConfigs: Map<string, AgentConfig>;
  tokenRegistry: TokenRegistry;
  modelBaseUrl: string;
  mailPort: number;
  codebasePath: string | null;
  genId: () => string;
}

/**
 * Build the DockerRunSpec for one agent session. Lifted from the inline
 * closure in startDaemon so its dep contract is explicit and it can be
 * tested in isolation.
 */
export function buildSpec(args: BuildSpecArgs): DockerRunSpec {
  const cfg = args.agentConfigs.get(args.agentId);
  if (!cfg) throw new Error(`no agent config for '${args.agentId}'`);
  const proxyToken = args.tokenRegistry.mint({
    agentId: args.agentId,
    turnId: `session-${args.mcpToken.slice(0, 8)}`,
    traceId: args.genId(),
    provider: cfg.provider,
    model: cfg.model,
  });
  const mounts: Mount[] = [
    { hostPath: cfg.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },
    { hostPath: cfg.storePath, containerPath: "/store", readOnly: false },
  ];
  if (args.codebasePath) {
    mounts.push({ hostPath: args.codebasePath, containerPath: "/codebase", readOnly: false });
  }
  const spec: DockerRunSpec = {
    imageTag: cfg.imageTag,
    name: `teamroom-${args.agentId}-${args.mcpToken.slice(0, 8)}`,
    mounts,
    env: {
      TEAMROOM_TRACE_ID: args.genId(),
      TEAMROOM_AGENT_NAME: args.agentId,
      TEAMROOM_RUNTIME: cfg.runtime,
      TEAMROOM_PROVIDER: cfg.provider,
      TEAMROOM_MODEL: cfg.model,
      TEAMROOM_MODEL_BASE_URL: args.modelBaseUrl,
      TEAMROOM_MODEL_API_TOKEN: proxyToken,
      TEAMROOM_ALLOWED_TOOLS: cfg.allowedTools.join(","),
      TEAMROOM_MCP_URL: `http://host.docker.internal:${args.mailPort}/mcp`,
      TEAMROOM_MCP_TOKEN: args.mcpToken,
    },
    labels: {
      "teamroom-agent": "true",
      "teamroom-agent-id": args.agentId,
    },
  };
  return spec;
}
