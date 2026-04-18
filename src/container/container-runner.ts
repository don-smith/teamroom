import type { DockerRunSpec } from "./docker-command.js";

export type ContainerStdoutEvent =
  | { type: "reply"; body: string; messageId?: string }
  | { type: "status"; phase: string; [k: string]: unknown }
  | { type: "log"; level: string; msg: string; [k: string]: unknown }
  | { type: "unknown"; raw: string };

export interface ContainerRunResult {
  exitCode: number;
  containerId: string;
  stderr: string;
  timedOut: boolean;
}

export interface ContainerRunRequest {
  spec: DockerRunSpec;
  stdinJson: string;            // a single JSON line
  timeoutMs: number;
  onEvent: (event: ContainerStdoutEvent) => void;
}

export interface ContainerRunner {
  run(req: ContainerRunRequest): Promise<ContainerRunResult>;
}
