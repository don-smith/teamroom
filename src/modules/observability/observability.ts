import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { SystemClock, type Clock } from "../../clock/clock.js";
import { JsonLinesLogger, type Logger } from "../../logger/logger.js";

export interface Observability {
  clock: Clock;
  rootLogger: Logger;
  logFilePath: string;
}

export interface ObservabilityDeps {
  dataDir: string;
}

export function composeObservability(deps: ObservabilityDeps): Observability {
  mkdirSync(join(deps.dataDir, "logs"), { recursive: true });
  const clock = new SystemClock();
  const dateStr = clock.nowIso().slice(0, 10);
  const logFilePath = join(deps.dataDir, "logs", `teamroom-${dateStr}.jsonl`);
  const logSink = (line: string) => {
    process.stdout.write(line + "\n");
    appendFileSync(logFilePath, line + "\n");
  };
  const rootLogger = new JsonLinesLogger(clock, logSink, { component: "daemon" });
  return { clock, rootLogger, logFilePath };
}
