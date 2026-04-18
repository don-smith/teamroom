import type { AgentConfig } from "../agent-config/agent-config.js";
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { ContainerRunner } from "../container/container-runner.js";
import type { DockerRunSpec, Mount } from "../container/docker-command.js";
import type { Logger } from "../logger/logger.js";
import type { MessageRepo } from "../db/message-repo.js";
import type { TurnRepo } from "../db/turn-repo.js";
import type { Message } from "../types.js";

export interface ProcessTurnDeps {
  inbound: Message;
  agentConfig: AgentConfig;
  messageRepo: MessageRepo;
  turnRepo: TurnRepo;
  runner: ContainerRunner;
  bus: NotifyBus;
  logger: Logger;
  clock: Clock;
  modelBaseUrl: string;
  modelApiToken: string;
  timeoutMs: number;
  genId: () => string;
}

export async function processTurn(deps: ProcessTurnDeps): Promise<void> {
  const {
    inbound, agentConfig, messageRepo, turnRepo, runner, bus, logger, clock,
    modelBaseUrl, modelApiToken, timeoutMs, genId,
  } = deps;

  const turnId = genId();
  const now = clock.nowIso();
  const turnLogger = logger.child({
    component: "turn-processor",
    turnId,
    traceId: inbound.traceId,
    agentName: agentConfig.name,
  });

  // 1. Create the turn row
  turnRepo.create({
    id: turnId,
    agentId: inbound.agentId,
    inboundMessageId: inbound.id,
    status: "pending",
    containerId: null,
    error: null,
    traceId: inbound.traceId,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
  });
  messageRepo.attachTurn(inbound.id, turnId);
  turnLogger.info("turn created");

  // 2. Mark running (container id set after we get it back from the runner)
  // We mark running before spawning with a placeholder id, then update.
  // Simpler: emit turn.started now, call runner, then UPDATE on completion.

  await bus.publish({
    id: genId(),
    type: "turn.started",
    ts: clock.nowIso(),
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
  });

  const mounts: Mount[] = [
    { hostPath: agentConfig.agentsMdPath, containerPath: "/AGENTS.md", readOnly: true },
    { hostPath: agentConfig.storePath, containerPath: "/store", readOnly: false },
  ];
  const spec: DockerRunSpec = {
    imageTag: agentConfig.imageTag,
    mounts,
    env: {
      TEAMROOM_TRACE_ID: inbound.traceId,
      TEAMROOM_TURN_ID: turnId,
      TEAMROOM_AGENT_NAME: agentConfig.name,
      TEAMROOM_MODEL: agentConfig.model,
      TEAMROOM_MODEL_BASE_URL: modelBaseUrl,
      TEAMROOM_MODEL_API_TOKEN: modelApiToken,
    },
  };

  const stdinEnvelope = JSON.stringify({
    prompt: inbound.body,
    messageId: inbound.id,
    turnId,
    traceId: inbound.traceId,
  });

  let replyCount = 0;

  const result = await runner.run({
    spec,
    stdinJson: stdinEnvelope,
    timeoutMs,
    onEvent: (evt) => {
      try {
        if (evt.type === "reply") {
          const outId = genId();
          messageRepo.create({
            id: outId,
            agentId: inbound.agentId,
            channel: inbound.channel,
            direction: "out",
            body: evt.body,
            turnId,
            traceId: inbound.traceId,
            createdAt: clock.nowIso(),
          });
          replyCount += 1;
          void bus.publish({
            id: genId(),
            type: "message.outbound",
            ts: clock.nowIso(),
            agentId: inbound.agentId,
            messageId: outId,
            turnId,
            traceId: inbound.traceId,
          });
        } else if (evt.type === "status") {
          turnLogger.info("status", { phase: evt.phase });
        } else if (evt.type === "log") {
          turnLogger.info("agent-log", { level: evt.level, msg: evt.msg });
        } else {
          turnLogger.warn("unknown stdout event", { raw: (evt as { raw?: string }).raw });
        }
      } catch (err) {
        turnLogger.error("error handling stdout event", { error: String(err) });
      }
    },
  });

  // Attach containerId we got back (started_at is now set too)
  turnRepo.markRunning(turnId, result.containerId, clock.nowIso());

  if (result.timedOut) {
    turnRepo.markError(turnId, "timeout", clock.nowIso());
    await bus.publish({
      id: genId(),
      type: "turn.errored",
      ts: clock.nowIso(),
      agentId: inbound.agentId,
      turnId,
      traceId: inbound.traceId,
      error: "timeout",
    });
    turnLogger.warn("turn timed out");
    return;
  }

  if (result.exitCode !== 0) {
    const snippet = result.stderr.slice(-2048);
    const errorText = `exit=${result.exitCode}; stderr=${snippet}`;
    turnRepo.markError(turnId, errorText, clock.nowIso());
    await bus.publish({
      id: genId(),
      type: "turn.errored",
      ts: clock.nowIso(),
      agentId: inbound.agentId,
      turnId,
      traceId: inbound.traceId,
      error: errorText,
    });
    turnLogger.warn("turn errored", { exitCode: result.exitCode });
    return;
  }

  turnRepo.markDone(turnId, clock.nowIso());
  await bus.publish({
    id: genId(),
    type: "turn.completed",
    ts: clock.nowIso(),
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
  });
  turnLogger.info("turn done", { replyCount });
}
