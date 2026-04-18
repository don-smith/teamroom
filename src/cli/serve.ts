import { join, resolve } from "node:path";
import { startDaemon } from "../daemon/daemon.js";
import { readEnvFile } from "../env/env-file.js";
import { discoverAnthropic } from "../env/anthropic-credentials.js";

export async function serve(): Promise<void> {
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
      upstreamUrl: env.LM_STUDIO_BASE_URL ?? "http://host.docker.internal:1234",
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

  await new Promise(() => {});
}
