import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./daemon.js";

describe("daemon shutdown", () => {
  let root: string;
  let dataDir: string;
  let agentsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "teamroom-daemon-"));
    dataDir = join(root, "data");
    agentsDir = join(root, "agents");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("unlinks the PID file on clean stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });
    const pidFile = join(dataDir, "teamroom.pid");
    expect(existsSync(pidFile)).toBe(true);
    await daemon.stop();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stop() is idempotent", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("stop() succeeds even if PID file was removed externally", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });
    unlinkSync(join(dataDir, "teamroom.pid"));
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});
