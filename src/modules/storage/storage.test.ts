import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeStorage } from "./storage.js";

describe("composeStorage", () => {
  it("opens the DB, runs migrations, and exposes repos", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    try {
      const storage = composeStorage({ dataDir: dir });
      expect(storage.db).toBeDefined();
      expect(storage.agentRepo).toBeDefined();
      expect(storage.messageRepo).toBeDefined();
      const tables = storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain("messages");
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close() closes the DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    try {
      const storage = composeStorage({ dataDir: dir });
      storage.close();
      expect(() => storage.db.prepare("SELECT 1").get()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports :memory: dataDir for tests", () => {
    const storage = composeStorage({ dataDir: ":memory:" });
    expect(storage.db).toBeDefined();
    storage.close();
  });
});
