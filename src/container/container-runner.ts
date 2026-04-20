import type { DockerRunSpec } from "./docker-command.js";

export type ContainerStdoutEvent =
  | { type: "reply"; body: string; messageId?: string }
  | { type: "dm"; to: string; body: string }
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

/**
 * Long-lived container handle returned by `ContainerRunner.start`. The
 * daemon pushes JSON envelopes via `writeEnvelope`; the runtime reads them
 * from stdin as a stream. Closing stdin (via `closeStdin`) signals EOF so
 * the runtime exits cleanly. `onEvent` / `onExit` fan out stdout parse
 * results + the final exit code.
 */
export interface RunningContainer {
  containerId: string;
  writeEnvelope(envelope: unknown): void;
  closeStdin(): void;
  onEvent(handler: (event: ContainerStdoutEvent) => void): void;
  onExit(handler: (result: ContainerRunResult) => void): void;
  kill(): Promise<void>;
}

export interface ContainerRunner {
  /**
   * One-shot invocation — writes a single envelope, closes stdin, awaits
   * the container's exit. Retained for M3-era callers; M4 code prefers
   * `start` so the session can persist across multiple wakes.
   */
  run(req: ContainerRunRequest): Promise<ContainerRunResult>;

  /**
   * Persistent session. Returns a handle the daemon can write multiple
   * envelopes to. Call `closeStdin()` to request a clean exit.
   */
  start(spec: DockerRunSpec): RunningContainer;
}
