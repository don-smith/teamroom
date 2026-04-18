import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerStdoutEvent,
} from "./container-runner.js";

export interface Script {
  events: ContainerStdoutEvent[];
  exitCode: number;
  stderr: string;
  timedOut?: boolean;
}

export class FakeRunner implements ContainerRunner {
  private counter = 0;
  constructor(private readonly resolver: (req: ContainerRunRequest) => Script) {}

  async run(req: ContainerRunRequest): Promise<ContainerRunResult> {
    const script = this.resolver(req);
    for (const evt of script.events) {
      req.onEvent(evt);
    }
    this.counter += 1;
    return {
      exitCode: script.exitCode,
      containerId: `fake-${this.counter}`,
      stderr: script.stderr,
      timedOut: script.timedOut ?? false,
    };
  }
}
