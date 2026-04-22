import type { DockerRunSpec, Mount } from "../container/docker-command.js";
import type { AgentConfig } from "../agent-config/agent-config.js";
import type { TokenRegistry } from "../model-proxy/token-registry.js";
import type { Provider } from "../types.js";

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
  const modelProvider = resolveModelProvider(cfg.provider);
  const proxyToken = args.tokenRegistry.mint({
    agentId: args.agentId,
    turnId: `session-${args.mcpToken.slice(0, 8)}`,
    traceId: args.genId(),
    provider: modelProvider,
    model: cfg.model,
  });
  const mounts: Mount[] = [
    { hostPath: cfg.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },
    { hostPath: cfg.storePath, containerPath: "/store", readOnly: false },
  ];
  if (args.codebasePath) {
    mounts.push({ hostPath: args.codebasePath, containerPath: "/codebase", readOnly: false });
  }
  return {
    imageTag: cfg.imageTag,
    name: `teamroom-${args.agentId}-${args.mcpToken.slice(0, 8)}`,
    mounts,
    env: {
      TEAMROOM_TRACE_ID: args.genId(),
      TEAMROOM_AGENT_NAME: args.agentId,
      TEAMROOM_PROVIDER: cfg.provider,
      TEAMROOM_MODEL: cfg.model,
      TEAMROOM_MODEL_BASE_URL: args.modelBaseUrl,
      TEAMROOM_MODEL_API_TOKEN: proxyToken,
      ANTHROPIC_BASE_URL: args.modelBaseUrl,
      ANTHROPIC_AUTH_TOKEN: proxyToken,
      TEAMROOM_ALLOWED_TOOLS: cfg.allowedTools.join(","),
      TEAMROOM_MCP_URL: `http://host.docker.internal:${args.mailPort}/mcp`,
      TEAMROOM_MCP_TOKEN: args.mcpToken,
    },
    labels: {
      "teamroom-agent": "true",
      "teamroom-agent-id": args.agentId,
    },
  };
}

/**
 * Map an agent's harness provider to the model provider the daemon proxy
 * should use when minting its token. For internal harnesses the two are the
 * same. For external harnesses (deepagents, hermes) the harness runs in its
 * own container but routes LLM calls through Team Room's Anthropic proxy
 * (M6 decision — see docs/specs/...-m6-multi-harness-design.md §7).
 *
 * If a future agent wants a different model backend (e.g. Archie on a local
 * model), add an `model_provider` field on agent.yaml to override this default.
 */
function resolveModelProvider(harnessProvider: Provider): Provider {
  switch (harnessProvider) {
    case "deepagents":
    case "hermes":
      return "anthropic";
    case "anthropic":
    case "lm-studio":
    case "ollama":
      return harnessProvider;
  }
}
