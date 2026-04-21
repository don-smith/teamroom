import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("exposes a mailing-list registry reflecting agent subscriptions", async () => {
    // lists.yaml at repoRoot so the agent's subscription resolves.
    writeFileSync(
      join(root, "lists.yaml"),
      "lists:\n  - name: team-wide\n    triggers: []\n",
    );
    const agentDir = join(agentsDir, "sub-agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# sub-agent");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: sub-agent\nmodel: m\nimage_tag: t\nprovider: lm-studio\nsubscriptions:\n  - list:team-wide\n",
    );

    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });

    try {
      expect(daemon.mailingListRegistry.subscribers("team-wide")).toEqual(["sub-agent"]);
      expect(daemon.mailingListRegistry.subscribers("other")).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("writes the mail-server port to data/ports/mail-mcp.port and clears it on stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      lmStudio: { upstreamUrl: "http://example.invalid", realKey: "x" },
      anthropic: null,
    });
    const portFile = join(dataDir, "ports", "mail-mcp.port");
    expect(existsSync(portFile)).toBe(true);
    const port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
    expect(port).toBeGreaterThan(0);
    await daemon.stop();
    expect(existsSync(portFile)).toBe(false);
  });
});
