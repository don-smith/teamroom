import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("exposes a subscriptionIndex reflecting agent subscriptions", async () => {
    const agentDir = join(agentsDir, "sub-agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# sub-agent");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: sub-agent\nmodel: m\nimage_tag: t\nprovider: lm-studio\nsubscriptions:\n  - sub-agent\n  - team-wide\n",
    );

    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });

    expect(daemon.subscriptionIndex.lookup("dm", "sub-agent")).toEqual(["sub-agent"]);
    expect(daemon.subscriptionIndex.lookup("dm", "team-wide")).toEqual(["sub-agent"]);
    expect(daemon.subscriptionIndex.lookup("dm", "nobody")).toEqual([]);

    await daemon.stop();
  });
});
