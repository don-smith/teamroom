import type { AgentConfig } from "../agent-config/agent-config.js";
import type { NotifyBus } from "../bus/notify-bus.js";
import type { Clock } from "../clock/clock.js";
import type { ContainerRunner } from "../container/container-runner.js";
import type { DockerRunSpec, Mount } from "../container/docker-command.js";
import type { Logger } from "../logger/logger.js";
import type { MessageRepo } from "../db/message-repo.js";
import type { TurnRepo } from "../db/turn-repo.js";
import type { ModelProxy } from "../model-proxy/model-proxy.js";
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
  modelProxy: ModelProxy;
  modelBaseUrl: string;
  /** True when an Anthropic adapter is configured. Turns whose agent declares
   *  `provider: anthropic` are refused with `missing_credential` when false. */
  anthropicAdapterPresent: boolean;
  timeoutMs: number;
  genId: () => string;
}

export async function processTurn(deps: ProcessTurnDeps): Promise<void> {
  const {
    inbound, agentConfig, messageRepo, turnRepo, runner, bus, logger, clock,
    modelProxy, modelBaseUrl, anthropicAdapterPresent, timeoutMs, genId,
  } = deps;

  const turnId = genId();
  const now = clock.nowIso();
  const turnLogger = logger.child({
    component: "turn-processor",
    turnId,
    traceId: inbound.traceId,
    agentName: agentConfig.name,
  });

  // 1. Create the turn row, attach it to the inbound message, then mark
  //    running with a placeholder container_id so the reconciler can see
  //    that we got past intake even before the runner returns the real id
  //    (closes M1 debt #1 part 1: pending → running before runner.run).
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
    conversationId: null,
  });
  messageRepo.attachTurn(inbound.id, turnId);
  turnRepo.markRunning(turnId, "pending-spawn", clock.nowIso());

  // 2. Refuse provider:anthropic agents when no Anthropic adapter is wired.
  //    Fail fast with a structured error before minting a token or spawning.
  if (agentConfig.provider === "anthropic" && !anthropicAdapterPresent) {
    turnRepo.markError(turnId, "missing_credential", clock.nowIso());
    await bus.publish({
      id: genId(),
      type: "turn.errored",
      ts: clock.nowIso(),
      agentId: inbound.agentId,
      turnId,
      traceId: inbound.traceId,
      error: "missing_credential",
    });
    turnLogger.warn("turn errored: missing anthropic credential");
    return;
  }

  // 3. Mint a per-turn routing token + emit turn.started.
  const token = modelProxy.mint({
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
    provider: agentConfig.provider,
    model: agentConfig.model,
  });
  await bus.publish({
    id: genId(),
    type: "turn.started",
    ts: clock.nowIso(),
    agentId: inbound.agentId,
    turnId,
    traceId: inbound.traceId,
  });
  turnLogger.info("turn.started");

  try {
    const mounts: Mount[] = [
      // M2 contract: AGENTS.md is read-write so agents may evolve their own
      // operating doc across turns. See spec §2.
      { hostPath: agentConfig.agentsMdPath, containerPath: "/AGENTS.md", readOnly: false },
      { hostPath: agentConfig.storePath, containerPath: "/store", readOnly: false },
    ];
    // Container name encodes agent + turn so `docker ps` / `docker logs` are
    // meaningful while a turn is in flight. The 8-char turnId suffix keeps
    // names unique across concurrent turns of the same agent.
    const containerName = `teamroom-${agentConfig.name}-${turnId.slice(0, 8)}`;
    // Env shape per provider:
    //  - lm-studio: container's OpenAI-compat client uses TEAMROOM_MODEL_BASE_URL
    //    + TEAMROOM_MODEL_API_TOKEN.
    //  - anthropic: container's claude-agent-sdk subprocess (Claude Code CLI)
    //    honors ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN — those names are
    //    fixed by Anthropic, not us. We populate both blocks unconditionally
    //    so a future agent that switches providers Just Works without
    //    re-spawning.
    const spec: DockerRunSpec = {
      imageTag: agentConfig.imageTag,
      name: containerName,
      mounts,
      env: {
        TEAMROOM_TRACE_ID: inbound.traceId,
        TEAMROOM_TURN_ID: turnId,
        TEAMROOM_AGENT_NAME: agentConfig.name,
        TEAMROOM_PROVIDER: agentConfig.provider,
        TEAMROOM_MODEL: agentConfig.model,
        // OpenAI-compat slot (LM Studio + future OpenAI-shaped providers).
        TEAMROOM_MODEL_BASE_URL: modelBaseUrl,
        TEAMROOM_MODEL_API_TOKEN: token,
        // Claude Code CLI / claude-agent-sdk slot.
        ANTHROPIC_BASE_URL: modelBaseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
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
              topic: "",
              fromAgentId: null,
              conversationId: null,
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

    // Update the turn row with the real container id (was "pending-spawn").
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
      // Surface the actual stderr in the daemon log so failures are debuggable
      // without having to query the DB. Capped to 2KB by `snippet`.
      turnLogger.warn("turn errored", {
        exitCode: result.exitCode,
        stderrTail: snippet.length > 0 ? snippet : "(empty)",
      });
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
  } finally {
    // Always evict — keeps the registry from leaking entries on any path.
    modelProxy.evict(token);
  }
}
