import { createDatabase, type Db } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migrator.js";
import { AgentRepo } from "../../src/db/agent-repo.js";
import { MessageRepo } from "../../src/db/message-repo.js";
import { EventBus } from "../../src/bus/event-bus.js";
import { ControllableClock } from "../../src/clock/clock.js";
import { MailDispatcher } from "../../src/mail-dispatcher/mail-dispatcher.js";
import { MailingListRegistry, type ListDefinition } from "../../src/mailing-lists/registry.js";
import { MailingListTriggerListener } from "../../src/mailing-lists/trigger-listener.js";
import { CliChannelAdapter } from "../../src/channels/cli.js";
import { MailMcpTools, type ToolContext } from "../../src/mail-mcp/tools.js";
import { SessionTimerManager, type TimerFactory, type TimerHandle } from "../../src/session-manager/session-manager.js";
import { FakeRunner } from "../../src/container/fake-runner.js";
import type { AgentConfig } from "../../src/agent-config/agent-config.js";

/**
 * Scripted behavior for a FakeRunner-backed agent inside the harness.
 *
 * The harness surfaces an `AgentTools` object that mirrors the MCP tool
 * surface but calls the MailMcpTools in-process (no HTTP). When the
 * session manager pushes a wake envelope, the harness invokes the
 * registered onWake handler with the tools scoped to that agent's id.
 */
export interface AgentTools {
  mailList: MailMcpTools["list"] extends (ctx: ToolContext, input: infer I) => infer R ? (input: I) => R : never;
  mailGet: MailMcpTools["get"] extends (ctx: ToolContext, input: infer I) => infer R ? (input: I) => R : never;
  mailSend: MailMcpTools["send"] extends (ctx: ToolContext, input: infer I) => infer R ? (input: I) => R : never;
  mailReply: MailMcpTools["reply"] extends (ctx: ToolContext, input: infer I) => infer R ? (input: I) => R : never;
  mailMarkRead: (input: { id: string }) => void;
  mailArchive: (input: { id: string }) => void;
  mailDelete: (input: { id: string }) => void;
}

export type AgentScript = (tools: AgentTools, wake: unknown) => void | Promise<void>;

export interface HarnessOpts {
  agents: string[];
  lists?: ListDefinition[];
  agentSubscriptions?: Record<string, string[]>;
  agentScripts?: Record<string, AgentScript>;
  maxMailsPerThread?: number;
  sessionIdleMinutes?: number;
}

export interface ManualTimers extends TimerFactory {
  advance(ms: number): void;
  pending(): number;
}

export function manualTimers(): ManualTimers {
  const entries: { fire: () => void; when: number; cancelled: boolean }[] = [];
  let now = 0;
  return {
    schedule(ms, fn): TimerHandle {
      const entry = { fire: fn, when: now + ms, cancelled: false };
      entries.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
    advance(ms) {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const e of entries) {
          if (e.cancelled) continue;
          if (e.when <= now) {
            e.cancelled = true;
            e.fire();
            fired = true;
          }
        }
      }
    },
    pending() {
      return entries.filter((e) => !e.cancelled).length;
    },
  };
}

export interface IntegrationHarness {
  db: Db;
  messageRepo: MessageRepo;
  bus: EventBus;
  dispatcher: MailDispatcher;
  mailingListRegistry: MailingListRegistry;
  cliAdapter: CliChannelAdapter;
  mcpTools: MailMcpTools;
  sessionManager: SessionTimerManager;
  timerFactory: ManualTimers;
  runner: FakeRunner;
  cli: {
    send(input: { user: string; target: string; body: string; threadId?: string | null }): { threadId: string };
  };
  /** Wait for a CLI outbound row whose body matches the regex. */
  waitForCliOut(opts: { bodyMatch: RegExp; timeoutMs?: number }): Promise<string>;
  /** Wait until the target agent has received at least N inbox rows. */
  waitForInbox(opts: { agent: string; minCount: number; timeoutMs?: number }): Promise<void>;
  /** Wait until the session for the given agent is gone. */
  waitForSessionGone(agentId: string, opts?: { timeoutMs?: number }): Promise<void>;
  shutdown(): Promise<void>;
}

export function composeIntegrationHarness(opts: HarnessOpts): IntegrationHarness {
  const db = createDatabase(":memory:");
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  const agentConfigs: AgentConfig[] = [];
  for (const name of opts.agents) {
    agentRepo.create({ id: name, configPath: `/agents/${name}`, createdAt: "2026-04-20T00:00:00.000Z" });
    agentConfigs.push({
      name,
      model: "claude-opus-4-7",
      imageTag: `teamroom-agent-${name}:latest`,
      provider: "anthropic",
      configPath: `/agents/${name}`,
      agentsMdPath: `/agents/${name}/AGENTS.md`,
      storePath: `/agents/${name}/store`,
      subscriptions: opts.agentSubscriptions?.[name] ?? [],
      allowedTools: [],
    });
  }

  const messageRepo = new MessageRepo(db);
  const bus = new EventBus();
  const clock = new ControllableClock("2026-04-20T10:00:00.000Z");
  let seq = 0;
  const genId = () => `id-${++seq}`;

  const mailingListRegistry = new MailingListRegistry(opts.lists ?? [], agentConfigs);

  const dispatcher = new MailDispatcher({
    messageRepo,
    bus,
    clock,
    genId,
    knownAgents: (n) => opts.agents.includes(n),
    knownLists: (n) => mailingListRegistry.has(n),
    listSubscribers: (n) => mailingListRegistry.subscribers(n),
    maxMailsPerThread: opts.maxMailsPerThread ?? 10,
  });

  new MailingListTriggerListener({
    bus,
    registry: mailingListRegistry,
    dispatcher,
    formatBody: (eventType, payload) => `${eventType}: ${JSON.stringify(payload)}`,
  });

  const cliAdapter = new CliChannelAdapter({ dispatcher });
  const mcpTools = new MailMcpTools({ messageRepo, dispatcher, bus, clock });

  const timerFactory = manualTimers();
  const runner = new FakeRunner();

  // Intercept at runner.start so scripts are wired BEFORE the session
  // manager writes its first wake envelope. Each envelope the daemon
  // pushes in triggers the registered onWake script on a microtask —
  // mirrors how the real runtime would process wakes sequentially off
  // stdin, but without actually running an LLM.
  const scripts = opts.agentScripts ?? {};
  const originalStart = runner.start.bind(runner);
  runner.start = (spec) => {
    const rc = originalStart(spec);
    const agentName = spec.env.TEAMROOM_AGENT_NAME ?? "";
    const script = scripts[agentName];
    if (script) {
      const originalWrite = rc.writeEnvelope.bind(rc);
      let chain = Promise.resolve();
      rc.writeEnvelope = (env) => {
        originalWrite(env);
        // Serialize script invocations per session so a slow wake doesn't
        // race a fast follow-up — matches single-threaded LLM-turn behavior.
        chain = chain.then(async () => {
          const tools = makeAgentTools(mcpTools, agentName);
          try {
            await script(tools, env);
          } catch (err) {
            rc.simulateExit({ exitCode: 1, stderr: String(err) });
          }
        });
      };
    }
    return rc;
  };

  const sessionManager = new SessionTimerManager({
    runner,
    idleMinutes: opts.sessionIdleMinutes ?? 30,
    timerFactory,
    spec: (agentId, mcpToken) => ({
      imageTag: `teamroom-agent-${agentId}:latest`,
      mounts: [],
      env: { TEAMROOM_AGENT_NAME: agentId, TEAMROOM_MCP_TOKEN: mcpToken },
      labels: { "teamroom-agent": "true", "teamroom-agent-id": agentId },
    }),
    genToken: () => `tok-${++seq}`,
  });

  // Wire bus → session manager.
  bus.subscribe<{ to: string }>("mail.delivered", (p) => {
    sessionManager.onMailDelivered(p.to);
  });
  bus.subscribe<{ from: string }>("mail.sent", (p) => {
    sessionManager.onAgentActivity(p.from);
  });
  bus.subscribe<{ agentId: string; tool: string }>("tool.call", (p) => {
    sessionManager.onAgentActivity(p.agentId);
  });

  const cli = {
    send(input: { user: string; target: string; body: string; threadId?: string | null }) {
      const { threadId } = cliAdapter.send({
        user: input.user,
        target: input.target,
        body: input.body,
        threadId: input.threadId ?? null,
      });
      return { threadId };
    },
  };

  async function waitForCliOut(opts2: { bodyMatch: RegExp; timeoutMs?: number }): Promise<string> {
    const deadline = Date.now() + (opts2.timeoutMs ?? 2000);
    while (Date.now() < deadline) {
      const cliRows = messageRepo.listCliOutbound();
      const hit = cliRows.find((r) => opts2.bodyMatch.test(r.body));
      if (hit) return hit.body;
      await sleep(10);
    }
    const rows = messageRepo.listCliOutbound();
    throw new Error(
      `waitForCliOut timeout: no row matched ${opts2.bodyMatch}; saw: ${rows.map((r) => r.body).join(" | ")}`,
    );
  }

  async function waitForInbox(opts2: { agent: string; minCount: number; timeoutMs?: number }): Promise<void> {
    const deadline = Date.now() + (opts2.timeoutMs ?? 2000);
    while (Date.now() < deadline) {
      if (messageRepo.listInbox(opts2.agent, { includeArchived: true }).length >= opts2.minCount) return;
      await sleep(10);
    }
    throw new Error(
      `waitForInbox timeout: ${opts2.agent} has ${messageRepo.listInbox(opts2.agent, { includeArchived: true }).length} / ${opts2.minCount} expected`,
    );
  }

  async function waitForSessionGone(agentId: string, opts2?: { timeoutMs?: number }): Promise<void> {
    const deadline = Date.now() + (opts2?.timeoutMs ?? 500);
    while (Date.now() < deadline) {
      if (!sessionManager.hasSession(agentId)) return;
      await sleep(5);
    }
    throw new Error(`waitForSessionGone timeout: ${agentId} still has a session`);
  }

  async function shutdown(): Promise<void> {
    await sessionManager.killAll();
    db.close();
  }

  return {
    db,
    messageRepo,
    bus,
    dispatcher,
    mailingListRegistry,
    cliAdapter,
    mcpTools,
    sessionManager,
    timerFactory,
    runner,
    cli,
    waitForCliOut,
    waitForInbox,
    waitForSessionGone,
    shutdown,
  };
}

function makeAgentTools(mcpTools: MailMcpTools, agentName: string): AgentTools {
  const ctx: ToolContext = { callerAgentId: agentName };
  return {
    mailList: (input) => mcpTools.list(ctx, input),
    mailGet: (input) => mcpTools.get(ctx, input),
    mailSend: (input) => mcpTools.send(ctx, input),
    mailReply: (input) => mcpTools.reply(ctx, input),
    mailMarkRead: (input) => mcpTools.markRead(ctx, input),
    mailArchive: (input) => mcpTools.archive(ctx, input),
    mailDelete: (input) => mcpTools.delete(ctx, input),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => setTimeout(ok, ms));
}
