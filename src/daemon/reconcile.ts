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

// Pending turns that have been sitting for longer than this without a
// container assigned almost certainly belong to a daemon that crashed
// mid-spawn. We mark them errored so they don't linger forever.
const PENDING_AGE_MS = 60_000;

export async function reconcile(deps: ReconcileDeps): Promise<void> {
  // Sweep aged pending turns first: a pending row with no container_id older
  // than PENDING_AGE_MS means we crashed before markRunning had a chance to
  // record the container. Without this sweep the row would never resolve.
  const cutoff = new Date(Date.parse(deps.clock.nowIso()) - PENDING_AGE_MS).toISOString();
  const agedPending = deps.turnRepo.findAgedPending(cutoff);
  for (const turn of agedPending) {
    const now = deps.clock.nowIso();
    deps.turnRepo.markError(turn.id, "daemon_restart_during_pending", now);
    await deps.bus.publish({
      id: deps.genId(),
      type: "turn.errored",
      ts: now,
      agentId: turn.agentId,
      turnId: turn.id,
      traceId: turn.traceId,
      error: "daemon_restart_during_pending",
    });
    deps.logger.warn("reconcile: marked aged pending errored", { turnId: turn.id });
  }

  const orphans = deps.turnRepo.findByStatus("running");
  if (orphans.length === 0) {
    if (agedPending.length === 0) {
      deps.logger.info("reconcile: no orphan turns");
    }
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
