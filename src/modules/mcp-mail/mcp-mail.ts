import { MailDispatcher } from "../../mail-dispatcher/mail-dispatcher.js";
import { MailingListRegistry, type ListDefinition } from "../../mailing-lists/registry.js";
import { MailingListTriggerListener } from "../../mailing-lists/trigger-listener.js";
import { MailMcpTools } from "../../mail-mcp/tools.js";
import type { Storage } from "../storage/storage.js";
import type { Messaging } from "../messaging/messaging.js";
import type { Logger } from "../../logger/logger.js";
import type { Clock } from "../../clock/clock.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";

export interface McpMail {
  dispatcher: MailDispatcher;
  mailingListRegistry: MailingListRegistry;
  mcpTools: MailMcpTools;
}

export interface McpMailDeps {
  storage: Storage;
  messaging: Messaging;
  logger: Logger;
  clock: Clock;
  genId: () => string;
  agentConfigs: Map<string, AgentConfig>;
  lists: ListDefinition[];
  maxMailsPerThread: number;
}

export function composeMcpMail(deps: McpMailDeps): McpMail {
  const mailingListRegistry = new MailingListRegistry(
    deps.lists,
    [...deps.agentConfigs.values()],
  );
  deps.logger.info("mailing-list registry built", {
    lists: deps.lists.length,
    triggers: mailingListRegistry.allTriggers(),
  });

  const dispatcher = new MailDispatcher({
    messageRepo: deps.storage.messageRepo,
    bus: deps.messaging.eventBus,
    clock: deps.clock,
    genId: deps.genId,
    knownAgents: (n) => deps.agentConfigs.has(n),
    knownLists: (n) => mailingListRegistry.has(n),
    listSubscribers: (n) => mailingListRegistry.subscribers(n),
    maxMailsPerThread: deps.maxMailsPerThread,
  });

  // Self-registers via constructor (subscribes to the bus). Reference held
  // to make the side effect explicit — the side effect IS the value we
  // want from this object; the reference itself is just to make it visible
  // to anyone tracing what's wired.
  const triggerListener = new MailingListTriggerListener({
    bus: deps.messaging.eventBus,
    registry: mailingListRegistry,
    dispatcher,
    formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
  });
  // Reference kept locally so the side-effect construction is explicit;
  // not exported because consumers have no need to call into it.
  void triggerListener;

  const mcpTools = new MailMcpTools({
    messageRepo: deps.storage.messageRepo,
    dispatcher,
    bus: deps.messaging.eventBus,
    clock: deps.clock,
  });

  return { dispatcher, mailingListRegistry, mcpTools };
}
