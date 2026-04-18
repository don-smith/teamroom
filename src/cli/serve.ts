import { join, resolve } from "node:path";
import { startDaemon } from "../daemon/daemon.js";

export async function serve(): Promise<void> {
  const root = resolve(process.cwd());
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("ANTHROPIC_API_KEY is required\n");
    process.exit(1);
  }

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    anthropicApiKey: apiKey,
  });

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
