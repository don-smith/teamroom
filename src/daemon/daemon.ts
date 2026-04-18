import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, type Db } from "../db/database.js";
import { runMigrations } from "../db/migrator.js";
import { AgentRepo } from "../db/agent-repo.js";
import { MessageRepo } from "../db/message-repo.js";
import { TurnRepo } from "../db/turn-repo.js";
import { FileNotifyBus } from "../bus/file-notify-bus.js";
import { DockerRunner } from "../container/docker-runner.js";
import { SystemClock } from "../clock/clock.js";
import { JsonLinesLogger } from "../logger/logger.js";
import { loadAgentConfig, type AgentConfig } from "../agent-config/agent-config.js";
import { installSafetyNets } from "./safety-nets.js";
import { reconcile } from "./reconcile.js";
import { Orchestrator } from "./orchestrator.js";

export interface DaemonOptions {
  dataDir: string;          // e.g. <repo>/data
  agentsDir: string;        // e.g. <repo>/agents
  modelBaseUrl: string;     // container-side URL, e.g. http://host.docker.internal:1234/v1
  modelApiToken: string;    // bearer token for the model endpoint
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StartedDaemon {
  db: Db;
  stop: () => Promise<void>;
  orchestrator: Orchestrator;
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  mkdirSync(opts.dataDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "bus"), { recursive: true });
  mkdirSync(join(opts.dataDir, "logs"), { recursive: true });

  const clock = new SystemClock();
  const dateStr = clock.nowIso().slice(0, 10);
  const logFile = join(opts.dataDir, "logs", `teamroom-${dateStr}.jsonl`);
  const logSink = (line: string) => {
    process.stdout.write(line + "\n");
    appendFileSync(logFile, line + "\n");
  };
  const rootLogger = new JsonLinesLogger(clock, logSink, { component: "daemon" });
  installSafetyNets(rootLogger);

  // PID file
  writeFileSync(join(opts.dataDir, "teamroom.pid"), String(process.pid));

  const db = createDatabase(join(opts.dataDir, "teamroom.db"));
  runMigrations(db);

  const agentRepo = new AgentRepo(db);
  const messageRepo = new MessageRepo(db);
  const turnRepo = new TurnRepo(db);
  const bus = new FileNotifyBus(join(opts.dataDir, "bus"));

  // Discover and register each agent folder under agentsDir.
  const agentConfigs = new Map<string, AgentConfig>();
  if (existsSync(opts.agentsDir)) {
    const { readdirSync, statSync } = await import("node:fs");
    for (const entry of readdirSync(opts.agentsDir)) {
      const full = join(opts.agentsDir, entry);
      if (!statSync(full).isDirectory()) continue;
      const cfg = loadAgentConfig(full);
      agentConfigs.set(cfg.name, cfg);
      if (!agentRepo.findById(cfg.name)) {
        agentRepo.create({ id: cfg.name, configPath: cfg.configPath, createdAt: clock.nowIso() });
      }
      rootLogger.info("agent registered", { agentName: cfg.name });
    }
  }

  const genId = () => randomUUID();

  await reconcile({ turnRepo, bus, logger: rootLogger, clock, genId });

  const runner = new DockerRunner();
  const orchestrator = new Orchestrator({
    messageRepo, turnRepo, bus, logger: rootLogger, clock, runner,
    agentConfigs,
    modelBaseUrl: opts.modelBaseUrl,
    modelApiToken: opts.modelApiToken,
    turnTimeoutMs: opts.turnTimeoutMs ?? 5 * 60 * 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    genId,
  });

  // Fire-and-forget loop. Errors inside the loop are logged; the loop itself never throws.
  const loopPromise = orchestrator.runLoop().catch((err) => {
    rootLogger.fatal("orchestrator loop exited abnormally (daemon does not exit)", { error: String(err) });
  });

  const stop = async () => {
    orchestrator.stop();
    await loopPromise;
    await bus.close();
    db.close();
  };

  return { db, stop, orchestrator };
}
