import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { startRepoDaemon } from "../daemon/repo-daemon.js";
import { loadEnvFile } from "../env/env-file.js";
import {
  loadReposYaml,
  repoDataDir,
  repoStoresDir,
  AGENTS_DIR,
  TEAMROOM_DIR,
} from "../daemon/repo-config.js";

export async function serveRepo(repoName: string): Promise<void> {
  const yaml = loadReposYaml();
  const entry = yaml.repos[repoName];
  if (!entry) {
    throw new Error(`unknown repo: ${repoName}. Run \`teamroom repo init\` first.`);
  }

  const codebasePath = resolve(entry.codebasePath);
  if (!existsSync(codebasePath)) {
    throw new Error(`codebase path does not exist: ${codebasePath}`);
  }

  // Auto-discover the Team Room daemon WebSocket URL from its port file.
  // Falls back to the TEAMROOM_DAEMON_WS_URL env var if set (e.g. when
  // spawned by the Team Room daemon itself).
  const teamRoomWsUrl =
    process.env.TEAMROOM_DAEMON_WS_URL ??
    (() => {
      const portFile = join(TEAMROOM_DIR, "teamroom", "data", "ports", "daemon-ws.port");
      if (existsSync(portFile)) {
        return `ws://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`;
      }
      return undefined;
    })();
  if (teamRoomWsUrl) {
    process.env.TEAMROOM_DAEMON_WS_URL = teamRoomWsUrl;
  }

  const dataDir = repoDataDir(repoName);
  const storeBasePath = repoStoresDir(repoName);

  loadEnvFile(dataDir);

  const openrouterToken = process.env.OPENROUTER_API_KEY;
  if (!openrouterToken) {
    throw new Error("OPENROUTER_API_KEY missing from .env");
  }

  const modelBaseUrl =
    process.env.TEAMROOM_MODEL_BASE_URL ??
    (() => {
      const portFile = join(TEAMROOM_DIR, "teamroom", "data", "ports", "model-proxy.port");
      if (existsSync(portFile)) {
        return `http://host.docker.internal:${readFileSync(portFile, "utf8").trim()}`;
      }
      return `http://host.docker.internal:${process.env.TEAMROOM_MODEL_PROXY_PORT ?? "9876"}`;
    })();

  const mintToken = (): string => {
    return randomUUID();
  };

  // Agents live at ~/.teamroom/agents/ — the developer's team, independent
  // of any codebase. Falls back to the repo's local agents/ for dev convenience.
  const agentsDir = existsSync(AGENTS_DIR) ? AGENTS_DIR : join(codebasePath, "agents");

  const daemon = await startRepoDaemon({
    repoName,
    dataDir,
    agentsDir,
    storeBasePath,
    codebasePath,
    modelBaseUrl,
    mintToken: (entry) => randomUUID(),
  });

  const shutdown = async () => { await daemon.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}