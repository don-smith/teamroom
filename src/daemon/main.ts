import { join, resolve } from "node:path";
import { startDaemon } from "./daemon.js";
import { readEnvFile } from "../env/env-file.js";
import { discoverAnthropic } from "../env/anthropic-credentials.js";

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const env = readEnvFile(root, [
    "LM_STUDIO_API_TOKEN",
    "LM_STUDIO_BASE_URL",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);

  const lmStudioToken = env.LM_STUDIO_API_TOKEN;
  if (!lmStudioToken) {
    process.stderr.write("LM_STUDIO_API_TOKEN missing from .env\n");
    process.exit(1);
  }

  const anthropic = discoverAnthropic(env);

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    lmStudio: {
      // The proxy runs on the host, so it reaches LM Studio at localhost.
      // (host.docker.internal only resolves *inside* containers — that hostname
      // is what the container uses to reach the proxy, not the other way round.)
      upstreamUrl: env.LM_STUDIO_BASE_URL ?? "http://localhost:1234",
      realKey: lmStudioToken,
    },
    anthropic,
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
