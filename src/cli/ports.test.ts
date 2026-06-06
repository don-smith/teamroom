import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePortFile, readPortFile, deletePortFile, portsDir } from "./ports.js";

describe("ports", () => {
  it("writes and reads a port file under <dataDir>/ports/<name>.port", () => {
    const dir = mkdtempSync(join(tmpdir(), "ports-"));
    try {
      writePortFile(dir, "mail-mcp", 12345);
      expect(readPortFile(dir, "mail-mcp")).toBe(12345);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the port file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ports-"));
    try {
      expect(readPortFile(dir, "missing")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletePortFile is best-effort (no throw if absent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ports-"));
    try {
      expect(() => deletePortFile(dir, "missing")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("portsDir returns <dataDir>/ports", () => {
    expect(portsDir("/data")).toBe("/data/ports");
  });
});
