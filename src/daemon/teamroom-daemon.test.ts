import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTeamRoomDaemon, type StartedTeamRoomDaemon } from "./teamroom-daemon.js";

const openrouter = {
  upstreamUrl: "https://openrouter.example.test/api",
  realKey: "test-openrouter-key",
};

async function expectStartRejects(
  opts: Parameters<typeof startTeamRoomDaemon>[0],
  expected: RegExp,
): Promise<void> {
  let started: StartedTeamRoomDaemon | null = null;
  try {
    started = await startTeamRoomDaemon(opts);
  } catch (err) {
    expect(err instanceof Error ? err.message : String(err)).toMatch(expected);
    return;
  } finally {
    if (started) await started.stop();
  }
  throw new Error("expected startTeamRoomDaemon to reject");
}

function expectNoRuntimePorts(dataDir: string): void {
  const portsDir = join(dataDir, "ports");
  expect(existsSync(join(portsDir, "model-proxy.port"))).toBe(false);
  expect(existsSync(join(portsDir, "daemon-ws.port"))).toBe(false);
  expect(existsSync(join(portsDir, "chat.port"))).toBe(false);
}

describe("startTeamRoomDaemon Telegram config", () => {
  test("fails loudly before startup when explicit telegram.yaml is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamroom-teamroom-daemon-"));
    const dataDir = join(root, "data");
    try {
      await expectStartRejects(
        {
          dataDir,
          telegramYamlPath: join(root, "telegram.yaml"),
          openrouter,
        },
        /telegram\.yaml required for Team Room daemon/,
      );
      expectNoRuntimePorts(dataDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails loudly before startup when explicit telegram.yaml is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamroom-teamroom-daemon-"));
    const dataDir = join(root, "data");
    const telegramYamlPath = join(root, "telegram.yaml");
    const previousToken = process.env.TELEGRAM_TOKEN_DOC;
    process.env.TELEGRAM_TOKEN_DOC = "123:abc";
    writeFileSync(
      telegramYamlPath,
      `bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
`,
      "utf8",
    );

    try {
      await expectStartRejects(
        {
          dataDir,
          telegramYamlPath,
          openrouter,
        },
        /missing 'repo'/,
      );
      expectNoRuntimePorts(dataDir);
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_TOKEN_DOC;
      else process.env.TELEGRAM_TOKEN_DOC = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails loudly before startup when telegram.yaml names an unknown repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamroom-teamroom-daemon-"));
    const dataDir = join(root, "data");
    const telegramYamlPath = join(root, "telegram.yaml");
    const previousHome = process.env.HOME;
    const previousToken = process.env.TELEGRAM_TOKEN_DOC;
    process.env.HOME = root;
    process.env.TELEGRAM_TOKEN_DOC = "123:abc";
    mkdirSync(join(root, ".teamroom"), { recursive: true });
    writeFileSync(
      join(root, ".teamroom", "repos.yaml"),
      `repos:
  other:
    codebasePath: /tmp/other
`,
      "utf8",
    );
    writeFileSync(
      telegramYamlPath,
      `bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
    repo: missing
`,
      "utf8",
    );

    try {
      await expectStartRejects(
        {
          dataDir,
          telegramYamlPath,
          openrouter,
        },
        /unknown repo 'missing'/,
      );
      expectNoRuntimePorts(dataDir);
    } finally {
      process.env.HOME = previousHome;
      if (previousToken === undefined) delete process.env.TELEGRAM_TOKEN_DOC;
      else process.env.TELEGRAM_TOKEN_DOC = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
