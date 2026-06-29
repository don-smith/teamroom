import { join } from "node:path";
import { loadEnvFile } from "../env/env-file.js";
import { startMetaDaemon } from "../daemon/meta-daemon.js";
import { TEAMROOM_DIR } from "../daemon/repo-config.js";

export async function serveMeta(): Promise<void> {
  loadEnvFile(TEAMROOM_DIR);

  const openrouterToken = process.env.OPENROUTER_API_KEY;
  if (!openrouterToken) {
    throw new Error(
      "OPENROUTER_API_KEY missing from .env — create " +
        join(TEAMROOM_DIR, ".env") +
        " and add OPENROUTER_API_KEY=<your-key>",
    );
  }

  const dataDir = join(TEAMROOM_DIR, "meta", "data");

  const meta = await startMetaDaemon({
    dataDir,
    telegramYamlPath: join(TEAMROOM_DIR, "telegram.yaml"),
    openrouter: {
      upstreamUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
      realKey: openrouterToken,
    },
  });

  console.log(`Meta-process started`);
  console.log(`  Model proxy:   http://127.0.0.1:${meta.modelProxy.port}`);
  console.log(`  Daemon WS:     ws://127.0.0.1:${meta.daemonWsPort}`);
  console.log(`  Chat WS:       ws://127.0.0.1:${meta.chatPort}`);
  console.log(`  Route table:   ${meta.routeTable.size} repo(s)`);

  const shutdown = async () => {
    console.log("\nShutting down...");
    await meta.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}