import { join } from "node:path";
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
  /** Optional path to the myflow skills directory, mounted read-only at /myflow-skills */
  myflowSkillsPath: string | null;
  genId: () => string;
  /**
   * Base directory for per-repo agent stores.
   * e.g. ~/.teamroom/repos/<name>/stores
   * When provided, the store mount is constructed as
   * `join(storeBasePath, cfg.name)` instead of `cfg.storePath`.
   * Optional — defaults to cfg.storePath for backward compat (tests).
   */
  storeBasePath?: string;
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

  // Resolve store mount: per-repo override if storeBasePath provided, else default
  const storeMount = args.storeBasePath
    ? join(args.storeBasePath, cfg.name)
    : cfg.storePath;

  const mounts: Mount[] = [
    { hostPath: cfg.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },
    { hostPath: storeMount, containerPath: "/store", readOnly: false },
  ];
  if (args.codebasePath) {
    mounts.push({ hostPath: args.codebasePath, containerPath: "/codebase", readOnly: false });
  }
  if (args.myflowSkillsPath) {
    mounts.push({ hostPath: args.myflowSkillsPath, containerPath: "/myflow-skills", readOnly: true });
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
