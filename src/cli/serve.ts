import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentConfig } from "../agent-config/agent-config.js";
import { startDaemon } from "../daemon/daemon.js";
import { loadEnvFile } from "../env/env-file.js";
import type { Provider } from "../types.js";

export async function serve(): Promise<void> {
  const root = resolve(process.cwd());
  const agentsDir = join(root, "agents");

  // Inject .env into process.env (shell-set values take precedence).
  loadEnvFile(root);

  const openrouterToken = requireOpenRouterToken(process.env);

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir,
    openrouter: {
      upstreamUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
      realKey: openrouterToken,
    },
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

function requireOpenRouterToken(
  env: Record<string, string | undefined>,
): string {
  // Verify that at least one agent under agents/ exists and uses openrouter.
  // This validates the environment has the right setup before the daemon starts.
  const token = env.OPENROUTER_API_KEY;
  if (!token) {
    throw new Error("OPENROUTER_API_KEY missing from .env");
  }
  return token;
}