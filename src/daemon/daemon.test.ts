import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./daemon.js";
import { FakeRunner } from "../container/fake-runner.js";
import type { DockerRunSpec } from "../container/docker-command.js";

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

  const baseDaemonOpts = {
    openrouter: { upstreamUrl: "http://example.invalid", realKey: "openrouter-test" },
  };

  it("unlinks the PID file on clean stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    const pidFile = join(dataDir, "teamroom.pid");
    expect(existsSync(pidFile)).toBe(true);
    await daemon.stop();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stop() is idempotent", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("stop() succeeds even if PID file was removed externally", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    unlinkSync(join(dataDir, "teamroom.pid"));
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("exposes a mailing-list registry reflecting agent subscriptions", async () => {
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
      "name: sub-agent\nmodel: m\nimage_tag: t\nprovider: openrouter\nruntime: pi\nsubscriptions:\n  - list:team-wide\n",
    );

    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });

    try {
      expect(daemon.mailingListRegistry.subscribers("team-wide")).toEqual(["sub-agent"]);
      expect(daemon.mailingListRegistry.subscribers("other")).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("requires a codebase mount for deepagents runtime agents", async () => {
    const agentDir = join(agentsDir, "archie");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# Archie");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: archie\nruntime: deepagents\nprovider: openrouter\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-archie:latest\nlifecycle: persistent\n",
    );

    await expect(startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    })).rejects.toThrow(/TEAMROOM_CODEBASE_PATH.*deepagents.*archie/);
  });

  it("writes the mail-server port to data/ports/mail-mcp.port and clears it on stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    const portFile = join(dataDir, "ports", "mail-mcp.port");
    expect(existsSync(portFile)).toBe(true);
    const port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
    expect(port).toBeGreaterThan(0);
    await daemon.stop();
    expect(existsSync(portFile)).toBe(false);
  });

  it("removes daemon bus logging subscribers on stop", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    const beforeMail = daemon.eventBus.subscriberCount("mail.delivered");
    expect(beforeMail).toBeGreaterThan(0);
    const beforeChOut = daemon.eventBus.subscriberCount("channel.out");
    expect(beforeChOut).toBeGreaterThan(0);
    await daemon.stop();
    const afterMail = daemon.eventBus.subscriberCount("mail.delivered");
    expect(afterMail).toBe(beforeMail - 1);
    const afterChOut = daemon.eventBus.subscriberCount("channel.out");
    // Bus logging subscriber is removed, plus any channel.out subscribers
    // cleaned by sessionMgmt.stop() — just verify it dropped.
    expect(afterChOut).toBeLessThan(beforeChOut);
  });

  it("registers a channel.out bus logging subscriber for observability when telegram.yaml is absent", async () => {
    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
    });
    try {
      expect(daemon.eventBus.subscriberCount("channel.out")).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  it("starts even when a persistent agent's boot-spawn fails", async () => {
    const agentDir = join(agentsDir, "archie");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, "store"), { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "# Archie");
    writeFileSync(
      join(agentDir, "agent.yaml"),
      "name: archie\nmodel: deepseek/deepseek-v4-flash\nimage_tag: teamroom-agent-archie:latest\nprovider: openrouter\nruntime: deepagents\nlifecycle: persistent\n",
    );
    mkdirSync(join(root, "codebase"), { recursive: true });

    const runner = new FakeRunner();
    runner.start = (_spec: DockerRunSpec) => {
      throw new Error("simulated boot-spawn failure");
    };

    const daemon = await startDaemon({
      dataDir, agentsDir,
      ...baseDaemonOpts,
      runner,
    });

    try {
      expect(daemon.sessionManager.hasSession("archie")).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});