import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "./env-file.js";

describe("readEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teamroom-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty when .env is absent", () => {
    expect(readEnvFile(dir, ["X"])).toEqual({});
  });

  it("returns only the requested keys", () => {
    writeFileSync(join(dir, ".env"), "A=1\nB=2\nC=3\n");
    expect(readEnvFile(dir, ["A", "C"])).toEqual({ A: "1", C: "3" });
  });

  it("strips surrounding quotes and ignores comments and blank lines", () => {
    writeFileSync(
      join(dir, ".env"),
      `# a comment\n\nTOKEN="abc-xyz"\nURL='http://x:1/v1'\nPLAIN=value\n`,
    );
    expect(readEnvFile(dir, ["TOKEN", "URL", "PLAIN"])).toEqual({
      TOKEN: "abc-xyz",
      URL: "http://x:1/v1",
      PLAIN: "value",
    });
  });

  it("skips malformed lines (no equals sign)", () => {
    writeFileSync(join(dir, ".env"), "VALID=ok\nnotakey\nANOTHER=yes\n");
    expect(readEnvFile(dir, ["VALID", "ANOTHER"])).toEqual({
      VALID: "ok",
      ANOTHER: "yes",
    });
  });

  it("does not pollute process.env", () => {
    writeFileSync(join(dir, ".env"), "MY_SECRET_XYZ=hunter2\n");
    expect(process.env.MY_SECRET_XYZ).toBeUndefined();
    readEnvFile(dir, ["MY_SECRET_XYZ"]);
    expect(process.env.MY_SECRET_XYZ).toBeUndefined();
  });
});
