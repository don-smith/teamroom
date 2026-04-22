import { createInterface } from "node:readline";
import { buildWorker } from "./worker.js";
import type { WakeEnvelope } from "./worker.js";

async function main(): Promise<void> {
  const worker = await buildWorker();

  // Wake loop. Each stdin line is a `{type:"wake", events: [...]}` envelope.
  // EOF (daemon closed stdin) ends the session.
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let envelope: WakeEnvelope;
    try {
      envelope = JSON.parse(trimmed) as WakeEnvelope;
    } catch (err) {
      process.stderr.write(`agent-runtime: invalid wake envelope: ${String(err)}\n`);
      continue;
    }
    try {
      await worker.handleWake(envelope);
    } catch (err) {
      process.stderr.write(
        `agent-runtime: handleWake failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    }
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-runtime fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
