import type { AgentConfig } from "../agent-config/agent-config.js";
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { ContainerRunner } from "../container/container-runner.js";
import type { Logger } from "../logger/logger.js";
import type { MessageRepo } from "../db/message-repo.js";
import type { TurnRepo } from "../db/turn-repo.js";
import type { ModelProxy } from "../model-proxy/model-proxy.js";
import { processTurn } from "./turn-processor.js";

export interface OrchestratorDeps {
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  runner: ContainerRunner;
  agentConfigs: Map<string, AgentConfig>;
  modelProxy: ModelProxy;
  /** Container-side URL pointing at the proxy, e.g. http://host.docker.internal:<proxy-port>. */
  modelBaseUrl: string;
  /** Whether an Anthropic adapter was registered. Task 18 uses this to refuse `provider:anthropic` turns when false. */
  anthropicAdapterPresent: boolean;
  turnTimeoutMs: number;
  pollIntervalMs: number;
  genId: () => string;
  codebasePath: string | null;
}

export class Orchestrator {
  private stopping = false;
  constructor(private readonly deps: OrchestratorDeps) {}

  async tickOnce(): Promise<void> {
    const pending = this.deps.messageRepo.findPendingInbound();
    for (const message of pending) {
      const cfg = this.deps.agentConfigs.get(message.agentId);
      if (!cfg) {
        this.deps.logger.error("no agent config for pending message", {
          agentId: message.agentId,
          messageId: message.id,
        });
        continue;
      }
      try {
        await processTurn({
          inbound: message,
          agentConfig: cfg,
          messageRepo: this.deps.messageRepo,
          turnRepo: this.deps.turnRepo,
          runner: this.deps.runner,
          bus: this.deps.bus,
          logger: this.deps.logger,
          clock: this.deps.clock,
          modelProxy: this.deps.modelProxy,
          modelBaseUrl: this.deps.modelBaseUrl,
          anthropicAdapterPresent: this.deps.anthropicAdapterPresent,
          timeoutMs: this.deps.turnTimeoutMs,
          genId: this.deps.genId,
          codebasePath: this.deps.codebasePath,
        });
      } catch (err) {
        // Safety net — processTurn should not throw, but if it does, don't crash the loop.
        this.deps.logger.error("processTurn threw — continuing", {
          messageId: message.id,
          error: String(err),
        });
      }
    }
  }

  async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.tickOnce();
      await new Promise<void>((resolve) => setTimeout(resolve, this.deps.pollIntervalMs));
    }
  }

  stop(): void {
    this.stopping = true;
  }
}
