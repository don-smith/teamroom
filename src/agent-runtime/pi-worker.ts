import type { AgentWorker, WakeEnvelope } from "./worker.js";

export class PiAgentWorker implements AgentWorker {
  static async create(): Promise<PiAgentWorker> {
    throw new Error("PiAgentWorker not implemented yet");
  }

  async handleWake(_wake: WakeEnvelope): Promise<void> {
    // Implemented in the Pi worker task.
  }
}
