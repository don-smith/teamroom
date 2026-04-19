import { spawn } from "node:child_process";
import { buildDockerRunArgs } from "./docker-command.js";
import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
} from "./container-runner.js";

export class DockerRunner implements ContainerRunner {
  constructor(private readonly dockerBinary: string = "docker") {}

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const args = buildDockerRunArgs(req.spec);
    const child = spawn(this.dockerBinary, args, { stdio: ["pipe", "pipe", "pipe"] });

    const stderrChunks: string[] = [];
    let stdoutBuffer = "";
    let timedOut = false;

    child.stderr.on("data", (buf: Buffer) => stderrChunks.push(buf.toString("utf8")));

    child.stdout.on("data", (buf: Buffer) => {
      stdoutBuffer += buf.toString("utf8");
      let nl = stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.length > 0) req.onEvent(parseEvent(line));
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    child.stdin.write(req.stdinJson + "\n");
    child.stdin.end();

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, req.timeoutMs);

    const exitCode: number = await new Promise((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        resolve(code ?? -1);
      });
    });

    if (stdoutBuffer.length > 0) {
      // flush a trailing line with no newline
      req.onEvent(parseEvent(stdoutBuffer));
      stdoutBuffer = "";
    }

    return {
      exitCode,
      containerId: `docker-${child.pid ?? "unknown"}`,
      stderr: stderrChunks.join(""),
      timedOut,
    };
  }
}

export function parseEvent(line: string): ContainerStdoutEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = obj.type;
    if (type === "reply" && typeof obj.body === "string") {
      return { type: "reply", body: obj.body, messageId: typeof obj.messageId === "string" ? obj.messageId : undefined };
    }
    if (type === "dm" && typeof obj.to === "string" && typeof obj.body === "string") {
      return { type: "dm", to: obj.to, body: obj.body };
    }
    if (type === "status" && typeof obj.phase === "string") {
      return { ...obj, type: "status", phase: obj.phase };
    }
    if (type === "log" && typeof obj.level === "string" && typeof obj.msg === "string") {
      return { ...obj, type: "log", level: obj.level, msg: obj.msg };
    }
    return { type: "unknown", raw: line };
  } catch {
    return { type: "unknown", raw: line };
  }
}
