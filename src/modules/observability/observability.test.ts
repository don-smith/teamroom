import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeObservability } from "./observability.js";

describe("composeObservability", () => {
  it("returns a clock, root logger, and log file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-"));
    try {
      const obs = composeObservability({ dataDir: dir });
      expect(obs.clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(obs.rootLogger).toBeDefined();
      expect(obs.logFilePath).toMatch(/teamroom-\d{4}-\d{2}-\d{2}\.jsonl$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends log lines to the log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-"));
    try {
      const obs = composeObservability({ dataDir: dir });
      obs.rootLogger.info("hello", { k: 1 });
      const contents = readFileSync(obs.logFilePath, "utf8");
      expect(contents).toContain('"hello"');
      expect(contents).toContain('"k":1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
