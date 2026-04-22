import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "./env-file.js";

const TEST_KEYS = [
  "TR_TEST_A",
  "TR_TEST_B",
  "TR_TEST_C",
  "TR_TEST_TOKEN",
  "TR_TEST_URL",
  "TR_TEST_PLAIN",
  "TR_TEST_VALID",
  "TR_TEST_ANOTHER",
  "TR_TEST_OVERRIDE",
] as const;

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-env-"));
    // Clean up any leftover state so each test gets a clean process.env.
    for (const k of TEST_KEYS) delete process.env[k];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of TEST_KEYS) delete process.env[k];
  });

  it("is a no-op when .env is absent", () => {
    loadEnvFile(dir);
    for (const k of TEST_KEYS) {
      expect(process.env[k]).toBeUndefined();
    }
  });

  it("injects every well-formed KEY=value into process.env", () => {
    writeFileSync(join(dir, ".env"), "TR_TEST_A=1\nTR_TEST_B=2\nTR_TEST_C=3\n");
    loadEnvFile(dir);
    expect(process.env.TR_TEST_A).toBe("1");
    expect(process.env.TR_TEST_B).toBe("2");
    expect(process.env.TR_TEST_C).toBe("3");
  });

  it("strips surrounding quotes and ignores comments and blank lines", () => {
    writeFileSync(
      join(dir, ".env"),
      `# a comment\n\nTR_TEST_TOKEN="abc-xyz"\nTR_TEST_URL='http://x:1/v1'\nTR_TEST_PLAIN=value\n`,
    );
    loadEnvFile(dir);
    expect(process.env.TR_TEST_TOKEN).toBe("abc-xyz");
    expect(process.env.TR_TEST_URL).toBe("http://x:1/v1");
    expect(process.env.TR_TEST_PLAIN).toBe("value");
  });

  it("skips malformed lines (no equals sign)", () => {
    writeFileSync(join(dir, ".env"), "TR_TEST_VALID=ok\nnotakey\nTR_TEST_ANOTHER=yes\n");
    loadEnvFile(dir);
    expect(process.env.TR_TEST_VALID).toBe("ok");
    expect(process.env.TR_TEST_ANOTHER).toBe("yes");
  });

  it("does NOT override values already set on process.env (shell wins)", () => {
    process.env.TR_TEST_OVERRIDE = "from-shell";
    writeFileSync(join(dir, ".env"), "TR_TEST_OVERRIDE=from-dotenv\n");
    loadEnvFile(dir);
    expect(process.env.TR_TEST_OVERRIDE).toBe("from-shell");
  });
});
