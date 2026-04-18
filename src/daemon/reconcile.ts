import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { Logger } from "../logger/logger.js";
import type { TurnRepo } from "../db/turn-repo.js";

export interface ReconcileDeps {
  turnRepo: TurnRepo;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  genId: () => string;
}

export async function reconcile(deps: ReconcileDeps): Promise<void> {
  const orphans = deps.turnRepo.findByStatus("running");
  if (orphans.length === 0) {
    deps.logger.info("reconcile: no orphan turns");
    return;
  }
  deps.logger.warn("reconcile: found orphan running turns", { count: orphans.length });
  for (const turn of orphans) {
    const now = deps.clock.nowIso();
    deps.turnRepo.markError(turn.id, "daemon_restart", now);
    await deps.bus.publish({
      id: deps.genId(),
      type: "turn.errored",
      ts: now,
      agentId: turn.agentId,
      turnId: turn.id,
      traceId: turn.traceId,
      error: "daemon_restart",
    });
    deps.logger.warn("reconcile: marked orphan errored", { turnId: turn.id });
  }
}
