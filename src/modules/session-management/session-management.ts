import {
  SessionTimerManager,
  type TimerFactory,
} from "../../session-manager/session-manager.js";
import type { ContainerRunner } from "../../container/container-runner.js";
import type { DockerRunSpec } from "../../container/docker-command.js";
import type { Messaging } from "../messaging/messaging.js";
import type { Logger } from "../../logger/logger.js";
import type { AgentConfig } from "../../agent-config/agent-config.js";
import type { MailDeliveredEvent } from "../../types.js";

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
  /**
   * Agent configurations keyed by agent id. Used at init to spawn any
   * persistent-lifecycle agents and to provide `lifecycleFor` lookups to
   * the session-manager.
   */
  agentConfigs: Map<string, AgentConfig>;
}

export function composeSessionManagement(deps: SessionManagementDeps): SessionManagement {
  const lifecycleFor = (agentId: string): "session" | "persistent" => {
    return deps.agentConfigs.get(agentId)?.lifecycle ?? "session";
  };

  const sessionManager = new SessionTimerManager({
    runner: deps.runner,
    idleMinutes: deps.idleMinutes,
    timerFactory: deps.timerFactory,
    spec: deps.spec,
    genToken: deps.genToken,
    logger: deps.logger,
    lifecycleFor,
  });

  // The three bus subscriptions that make M4 actually flow.
  // (Mirrors what daemon.ts currently does inline; will be removed from
  //  daemon.ts in Plan Task 16.)
  deps.messaging.eventBus.subscribe<MailDeliveredEvent>("mail.delivered", (p) => {
    sessionManager.onMailDelivered(p);
  });
  deps.messaging.eventBus.subscribe<{ from: string }>("mail.sent", (p) => {
    sessionManager.onAgentActivity(p.from);
  });
  deps.messaging.eventBus.subscribe<{ agentId: string; tool: string }>("tool.call", (p) => {
    sessionManager.onAgentActivity(p.agentId);
  });

  // Boot-time: bring persistent agents up immediately so they are ready
  // to receive mail and so Docker's "container is running" observability
  // reflects the declared team composition.
  for (const [agentId, cfg] of deps.agentConfigs) {
    if (cfg.lifecycle === "persistent") {
      try {
        deps.logger.info("session.persistent_boot_spawn", { agentId });
        sessionManager.spawnIfAbsent(agentId);
      } catch (err) {
        deps.logger.error("session.persistent_boot_spawn.failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        // continue to next persistent agent — don't let one bad spec kill boot
      }
    }
  }

  return {
    sessionManager,
    stop: () => sessionManager.killAll(),
  };
}
