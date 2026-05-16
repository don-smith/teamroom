import { describe, it, expect } from "vitest";
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
  it("uses TEAMROOM_RUNTIME when present", async () => {
    await withEnv({ TEAMROOM_RUNTIME: "bogus", TEAMROOM_PROVIDER: "anthropic" }, async () => {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_RUNTIME/);
    });
  });

  it("falls back to TEAMROOM_PROVIDER for old containers", async () => {
    await withEnv({ TEAMROOM_RUNTIME: undefined, TEAMROOM_PROVIDER: "bogus" }, async () => {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    });
  });

  it("throws if neither TEAMROOM_RUNTIME nor TEAMROOM_PROVIDER is set", async () => {
    await withEnv({ TEAMROOM_RUNTIME: undefined, TEAMROOM_PROVIDER: undefined }, async () => {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    });
  });
});
