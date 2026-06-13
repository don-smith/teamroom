import type { MailDeliveredEvent } from "../types.js";

/**
 * Agent runtime worker abstraction. One worker per container.
 * The container's stdin loop drives `handleWake(wake)` once per inbound
 * envelope. Workers are constructed once at container boot (async, to
 * allow MCP handshake / graph compilation); they may hold cross-wake
 * state (e.g. LangGraph messages array) bounded by the container lifetime.
 */

export interface WakeEnvelope {
  type: "wake";
  /** Informational wake events. Older callers may send string tags; newer mail wakes include structured delivery metadata. */
  events: Array<string | MailDeliveredEvent>;
}

export interface AgentWorker {
  handleWake(wake: WakeEnvelope): Promise<void>;
}

function runtimeFromEnv(): { runtime: string; source: "TEAMROOM_RUNTIME" | "TEAMROOM_PROVIDER" } {
  const runtime = process.env.TEAMROOM_RUNTIME;
  if (runtime) return { runtime, source: "TEAMROOM_RUNTIME" };

  const provider = process.env.TEAMROOM_PROVIDER;
  if (!provider) {
    throw new Error("TEAMROOM_PROVIDER is required");
  }
  switch (provider) {
    case "anthropic":
      return { runtime: "anthropic", source: "TEAMROOM_PROVIDER" };
    case "lm-studio":
    case "ollama":
    case "openai":
    case "openrouter":
      return { runtime: "langgraph", source: "TEAMROOM_PROVIDER" };
    default:
      throw new Error(`unknown TEAMROOM_PROVIDER: '${provider}'`);
  }
}

export async function buildWorker(): Promise<AgentWorker> {
  const { runtime, source } = runtimeFromEnv();
  switch (runtime) {
    case "anthropic": {
      const { AnthropicAgentWorker } = await import("./anthropic-worker.js");
      return AnthropicAgentWorker.create();
    }
    case "langgraph": {
      const { LangGraphAgentWorker } = await import("./langgraph-worker.js");
      return LangGraphAgentWorker.create();
    }
    case "pi": {
      const { PiAgentWorker } = await import("./pi-worker.js");
      return PiAgentWorker.create();
    }
    case "deepagents":
      throw new Error(
        `runtime '${runtime}' is implemented by agents/archie/shim.py; the TypeScript worker factory does not build it`,
      );
    default:
      throw new Error(`unknown ${source}: '${runtime}'`);
  }
}
