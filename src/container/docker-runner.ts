import { spawn, type ChildProcess } from "node:child_process";
import { buildDockerRunArgs, type DockerRunSpec } from "./docker-command.js";
import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
  RunningContainer,
} from "./container-runner.js";

export class DockerRunner implements ContainerRunner {
  constructor(private readonly dockerBinary: string = "docker") {}

  /**
   * One-shot: spawn, write a single envelope, close stdin, await exit.
   * Built on top of `start()` so both paths share the same parse + exit
   * plumbing.
   */
  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const rc = this.start(req.spec);
    rc.onEvent(req.onEvent);

    const timeout = setTimeout(() => {
      void rc.kill();
    }, req.timeoutMs);
    let timedOut = false;
    const origKill = rc.kill.bind(rc);
    (rc as Mutable<RunningContainer>).kill = async () => {
      timedOut = true;
      await origKill();
    };

    rc.writeEnvelope(JSON.parse(req.stdinJson));
    rc.closeStdin();

    const result = await new Promise<ContainerRunResult>((ok) => {
      rc.onExit((r) => ok(r));
    });
    clearTimeout(timeout);
    return { ...result, timedOut };
  }

  start(spec: DockerRunSpec): RunningContainer {
    const args = buildDockerRunArgs(spec);
    const child = spawn(this.dockerBinary, args, { stdio: ["pipe", "pipe", "pipe"] });
    return attachHandlers(child, spec);
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function attachHandlers(child: ChildProcess, spec: DockerRunSpec): RunningContainer {
  const eventHandlers: Array<(e: ContainerStdoutEvent) => void> = [];
  const exitHandlers: Array<(r: ContainerRunResult) => void> = [];
  const stderrChunks: string[] = [];
  let stdoutBuffer = "";

  child.stderr?.on("data", (buf: Buffer) => stderrChunks.push(buf.toString("utf8")));

  child.stdout?.on("data", (buf: Buffer) => {
    stdoutBuffer += buf.toString("utf8");
    let nl = stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.length > 0) {
        const evt = parseEvent(line);
        for (const h of eventHandlers) h(evt);
      }
      nl = stdoutBuffer.indexOf("\n");
    }
  });

  child.on("close", (code) => {
    if (stdoutBuffer.length > 0) {
      const evt = parseEvent(stdoutBuffer);
      for (const h of eventHandlers) h(evt);
      stdoutBuffer = "";
    }
    const result: ContainerRunResult = {
      exitCode: code ?? -1,
      containerId: `docker-${child.pid ?? "unknown"}`,
      stderr: stderrChunks.join(""),
      timedOut: false,
    };
    for (const h of exitHandlers) h(result);
  });

  return {
    containerId: `docker-${child.pid ?? "unknown"}`,
    writeEnvelope: (env) => {
      const stdin = child.stdin;
      if (!stdin || !stdin.writable) throw new Error("stdin closed");
      stdin.write(JSON.stringify(env) + "\n");
    },
    closeStdin: () => {
      child.stdin?.end();
    },
    onEvent: (h) => {
      eventHandlers.push(h);
    },
    onExit: (h) => {
      exitHandlers.push(h);
    },
    kill: async () => {
      child.kill("SIGKILL");
    },
  };
}

export function parseEvent(line: string): ContainerStdoutEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = obj.type;
    if (type === "reply" && typeof obj.body === "string") {
      return {
        type: "reply",
        body: obj.body,
        messageId: typeof obj.messageId === "string" ? obj.messageId : undefined,
      };
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
