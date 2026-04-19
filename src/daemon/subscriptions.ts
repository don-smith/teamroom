import type { AgentConfig } from "../agent-config/agent-config.js";

export interface SubscriptionIndex {
  lookup(channel: string, topic: string): string[];
}

export class AgentSubscriptionIndex implements SubscriptionIndex {
  private readonly index = new Map<string, Set<string>>();

  constructor(agentConfigs: Map<string, AgentConfig>) {
    for (const [agentId, cfg] of agentConfigs) {
      for (const topic of cfg.subscriptions) {
        const key = `dm:${topic}`;
        let set = this.index.get(key);
        if (!set) {
          set = new Set();
          this.index.set(key, set);
        }
        set.add(agentId);
      }
    }
  }

  lookup(channel: string, topic: string): string[] {
    const key = `${channel}:${topic}`;
    const set = this.index.get(key);
    return set ? Array.from(set) : [];
  }
}
