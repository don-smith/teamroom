import type { AgentConfig } from "../agent-config/agent-config.js";
import { parseAddress } from "../mail-dispatcher/address.js";

export interface ListDefinition {
  name: string;
  /** Bus event types whose publish triggers a fanout to this list. */
  triggers: string[];
}

/**
 * In-memory registry of mailing lists and their subscribers.
 *
 * Lists are defined in `lists.yaml` (loaded via `./loader.ts`); subscribers
 * are declared in each agent's `agent.yaml` as `subscriptions: [list:<name>]`.
 * The registry builds a forward (`list → subscribers`) and reverse
 * (`event → lists`) index at boot. All subscription entries are validated —
 * unknown lists or non-`list:*` subscription values fail fast, so a typo in
 * an agent.yaml surfaces at daemon start, not at runtime fanout.
 */
export class MailingListRegistry {
  private readonly defs = new Map<string, ListDefinition>();
  private readonly byList = new Map<string, Set<string>>();
  private readonly byEvent = new Map<string, Set<string>>();

  constructor(lists: ListDefinition[], agentConfigs: AgentConfig[]) {
    for (const ld of lists) {
      if (this.defs.has(ld.name)) {
        throw new Error(`duplicate list definition: ${ld.name}`);
      }
      this.defs.set(ld.name, ld);
      this.byList.set(ld.name, new Set());
      for (const ev of ld.triggers) {
        if (!this.byEvent.has(ev)) this.byEvent.set(ev, new Set());
        this.byEvent.get(ev)!.add(ld.name);
      }
    }

    for (const cfg of agentConfigs) {
      for (const sub of cfg.subscriptions ?? []) {
        let parsed;
        try {
          parsed = parseAddress(sub);
        } catch {
          throw new Error(
            `agent.yaml '${cfg.name}': invalid subscription '${sub}' (expected list:<name>)`,
          );
        }
        if (parsed.kind !== "list") {
          throw new Error(
            `agent.yaml '${cfg.name}': only list: subscriptions are allowed in M4 (got '${sub}')`,
          );
        }
        if (!this.defs.has(parsed.name)) {
          throw new Error(`unknown list: ${parsed.name} (subscribed by ${cfg.name})`);
        }
        this.byList.get(parsed.name)!.add(cfg.name);
      }
    }
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  subscribers(name: string): string[] {
    const set = this.byList.get(name);
    return set ? [...set] : [];
  }

  triggersFor(name: string): string[] {
    return this.defs.get(name)?.triggers ?? [];
  }

  listsTriggeredBy(eventType: string): string[] {
    const set = this.byEvent.get(eventType);
    return set ? [...set] : [];
  }

  allTriggers(): string[] {
    return [...this.byEvent.keys()];
  }
}
