import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
  RunningContainer,
} from "./container-runner.js";
import type { DockerRunSpec } from "./docker-command.js";

export interface Script {
  events: ContainerStdoutEvent[];
  exitCode: number;
  stderr: string;
  timedOut?: boolean;
}

/**
 * Test-friendly in-memory container runner.
 *
 * The one-shot `run(req)` replays a scripted list of events and returns.
 * The streaming `start(spec)` returns a `FakeRunningContainer` — tests
 * can inspect the envelopes the daemon wrote, push events onto the
 * event-listener chain, and simulate exits manually. This gives M4
 * integration tests a way to exercise the session-driven wake loop
 * without spinning up Docker.
 */
export class FakeRunner implements ContainerRunner {
  private counter = 0;
  /** Sessions started via `start`. Tests drive them by index / by container id. */
  public readonly sessions: FakeRunningContainer[] = [];

  constructor(private readonly resolver: (req: ContainerRunRequest) => Script = () => ({ events: [], exitCode: 0, stderr: "" })) {}

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const script = this.resolver(req);
    for (const evt of script.events) req.onEvent(evt);
    this.counter += 1;
    return {
      exitCode: script.exitCode,
      containerId: `fake-${this.counter}`,
      stderr: script.stderr,
      timedOut: script.timedOut ?? false,
    };
  }

  start(spec: DockerRunSpec): FakeRunningContainer {
    this.counter += 1;
    const rc = new FakeRunningContainer(`fake-${this.counter}`, spec);
    this.sessions.push(rc);
    return rc;
  }
}

/**
 * RunningContainer whose behavior is driven by the test rather than by
 * a child process. Tests read envelopes the daemon pushed in, emit
 * scripted events, and simulate the exit when they're done.
 */
export class FakeRunningContainer implements RunningContainer {
  public readonly envelopes: unknown[] = [];
  private envelopeWaiters: Array<(e: unknown) => void> = [];
  private stdinClosed = false;
  private stdinClosedWaiters: Array<() => void> = [];
  private readonly eventHandlers: Array<(e: ContainerStdoutEvent) => void> = [];
  private readonly exitHandlers: Array<(r: ContainerRunResult) => void> = [];
  private exited = false;

  constructor(
    public readonly containerId: string,
    public readonly spec: DockerRunSpec,
  ) {}

  writeEnvelope(envelope: unknown): void {
    if (this.stdinClosed) throw new Error(`writeEnvelope after closeStdin (${this.containerId})`);
    this.envelopes.push(envelope);
    const waiters = this.envelopeWaiters;
    this.envelopeWaiters = [];
    for (const w of waiters) w(envelope);
  }

  closeStdin(): void {
    this.stdinClosed = true;
    const waiters = this.stdinClosedWaiters;
    this.stdinClosedWaiters = [];
    for (const w of waiters) w();
  }

  onEvent(handler: (event: ContainerStdoutEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onExit(handler: (result: ContainerRunResult) => void): void {
    this.exitHandlers.push(handler);
  }

  async kill(): Promise<void> {
    this.simulateExit({ exitCode: 137, containerId: this.containerId, stderr: "", timedOut: false });
  }

  // ---- test-only helpers ----

  /** Emit a stdout event as if the container had produced it. */
  simulateEvent(event: ContainerStdoutEvent): void {
    for (const h of this.eventHandlers) h(event);
  }

  /** Simulate container exit + fire exit handlers. Idempotent. */
  simulateExit(result: Partial<ContainerRunResult> = {}): void {
    if (this.exited) return;
    this.exited = true;
    const full: ContainerRunResult = {
      exitCode: result.exitCode ?? 0,
      containerId: this.containerId,
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
    };
    for (const h of this.exitHandlers) h(full);
  }

  /** Resolve when the next envelope is written. */
  waitForEnvelope(): Promise<unknown> {
    return new Promise((ok) => {
      this.envelopeWaiters.push(ok);
    });
  }

  /** Resolve when closeStdin is called. */
  waitForStdinClosed(): Promise<void> {
    if (this.stdinClosed) return Promise.resolve();
    return new Promise((ok) => {
      this.stdinClosedWaiters.push(ok);
    });
  }

  /** True after closeStdin has been invoked. */
  isStdinClosed(): boolean {
    return this.stdinClosed;
  }
}
