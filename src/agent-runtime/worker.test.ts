import { describe, it, expect } from "vitest";
import { buildWorker } from "./worker.js";

describe("buildWorker", () => {
  it("throws for an unknown TEAMROOM_PROVIDER", async () => {
    const prev = process.env.TEAMROOM_PROVIDER;
    process.env.TEAMROOM_PROVIDER = "bogus";
    try {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    } finally {
      if (prev === undefined) delete process.env.TEAMROOM_PROVIDER;
      else process.env.TEAMROOM_PROVIDER = prev;
    }
  });

  it("throws if TEAMROOM_PROVIDER is unset", async () => {
    const prev = process.env.TEAMROOM_PROVIDER;
    delete process.env.TEAMROOM_PROVIDER;
    try {
      await expect(buildWorker()).rejects.toThrow(/TEAMROOM_PROVIDER/);
    } finally {
      if (prev !== undefined) process.env.TEAMROOM_PROVIDER = prev;
    }
  });
});
