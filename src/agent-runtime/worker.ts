/**
 * Agent runtime worker abstraction. One worker per container.
 * The container's stdin loop drives `handleWake(wake)` once per inbound
 * envelope. Workers are constructed once at container boot (async, to
 * allow MCP handshake / graph compilation); they may hold cross-wake
 * state (e.g. LangGraph messages array) bounded by the container lifetime.
 */

export interface WakeEnvelope {
  type: "wake";
  /** Informational tags — the agent's system prompt tells it what to check. */
  events: string[];
}

export interface AgentWorker {
  handleWake(wake: WakeEnvelope): Promise<void>;
}

export async function buildWorker(): Promise<AgentWorker> {
  const provider = process.env.TEAMROOM_PROVIDER;
  if (!provider) {
    throw new Error("TEAMROOM_PROVIDER is required");
  }
  switch (provider) {
    case "anthropic": {
      const { AnthropicAgentWorker } = await import("./anthropic-worker.js");
      return AnthropicAgentWorker.create();
    }
    case "lm-studio":
    case "ollama": {
      const { LangGraphAgentWorker } = await import("./langgraph-worker.js");
      return LangGraphAgentWorker.create();
    }
    default:
      throw new Error(`unknown TEAMROOM_PROVIDER: '${provider}'`);
  }
}
