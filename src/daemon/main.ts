import { join, resolve } from "node:path";
import { startDaemon } from "./daemon.js";
import { readEnvFile } from "../env/env-file.js";

const DEFAULT_CONTAINER_BASE_URL = "http://host.docker.internal:1234/v1";

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const env = readEnvFile(root, ["LM_STUDIO_API_TOKEN", "LM_STUDIO_BASE_URL"]);
  const token = env.LM_STUDIO_API_TOKEN;
  if (!token) {
    process.stderr.write("LM_STUDIO_API_TOKEN missing from .env\n");
    process.exit(1);
  }

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    modelBaseUrl: env.LM_STUDIO_BASE_URL ?? DEFAULT_CONTAINER_BASE_URL,
    modelApiToken: token,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // keep alive
  await new Promise(() => {});
}

void main();
