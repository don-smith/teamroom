import {
  SessionTimerManager,
  type TimerFactory,
} from "../../session-manager/session-manager.js";
import type { ContainerRunner } from "../../container/container-runner.js";
import type { DockerRunSpec } from "../../container/docker-command.js";
import type { Messaging } from "../messaging/messaging.js";
import type { Logger } from "../../logger/logger.js";

export interface SessionManagement {
  sessionManager: SessionTimerManager;
  stop: () => Promise<void>;
}

export interface SessionManagementDeps {
  messaging: Messaging;
  logger: Logger;
  runner: ContainerRunner;
  idleMinutes: number;
  timerFactory: TimerFactory;
  spec: (agentId: string, mcpToken: string) => DockerRunSpec;
  genToken: () => string;
}

export function composeSessionManagement(deps: SessionManagementDeps): SessionManagement {
  const sessionManager = new SessionTimerManager({
    runner: deps.runner,
    idleMinutes: deps.idleMinutes,
    timerFactory: deps.timerFactory,
    spec: deps.spec,
    genToken: deps.genToken,
    logger: deps.logger,
  });

  // The three bus subscriptions that make M4 actually flow.
  // (Mirrors what daemon.ts currently does inline; will be removed from
  //  daemon.ts in Plan Task 16.)
  deps.messaging.eventBus.subscribe<{ to: string }>("mail.delivered", (p) => {
    sessionManager.onMailDelivered(p.to);
  });
  deps.messaging.eventBus.subscribe<{ from: string }>("mail.sent", (p) => {
    sessionManager.onAgentActivity(p.from);
  });
  deps.messaging.eventBus.subscribe<{ agentId: string; tool: string }>("tool.call", (p) => {
    sessionManager.onAgentActivity(p.agentId);
  });

  return {
    sessionManager,
    stop: () => sessionManager.killAll(),
  };
}
