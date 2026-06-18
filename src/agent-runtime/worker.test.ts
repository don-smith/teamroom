import { describe, it, expect } from "bun:test";
import { buildWorker } from "./worker.js";

async function withEnv(
  env: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    prev.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("buildWorker", () => {
  it("requires TEAMROOM_RUNTIME", async () => {
    await withEnv({ TEAMROOM_RUNTIME: undefined }, async () => {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_RUNTIME/);
    });
  });

  it("rejects unknown runtime values", async () => {
    await withEnv({ TEAMROOM_RUNTIME: "bogus" }, async () => {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_RUNTIME/);
    });
  });

  it("throws for deepagents runtime (implemented by shim.py)", async () => {
    await withEnv({ TEAMROOM_RUNTIME: "deepagents" }, async () => {
      await expect(buildWorker()).rejects.toThrow(/shim\.py/);
    });
  });
});