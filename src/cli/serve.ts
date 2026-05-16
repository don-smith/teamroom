import { join, resolve } from "node:path";
import { startDaemon } from "../daemon/daemon.js";
import { loadEnvFile } from "../env/env-file.js";
import { discoverAnthropic } from "../env/anthropic-credentials.js";

export async function serve(): Promise<void> {
  const root = resolve(process.cwd());

  // Inject .env into process.env (shell-set values take precedence).
  // Every TEAMROOM_* / LM_STUDIO_* / ANTHROPIC_* / CLAUDE_CODE_* var the
  // daemon reads is now sourced uniformly from process.env, whether it
  // came from .env or the shell.
  loadEnvFile(root);

  const lmStudioToken = process.env.LM_STUDIO_API_TOKEN;
  if (!lmStudioToken) {
    process.stderr.write("LM_STUDIO_API_TOKEN missing from .env\n");
    process.exit(1);
  }

  const openaiToken = process.env.OPENAI_TOKEN;
  if (!openaiToken) {
    process.stderr.write("OPENAI_TOKEN missing from .env\n");
    process.exit(1);
  }

  const anthropic = discoverAnthropic();

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir: join(root, "agents"),
    lmStudio: {
      // The proxy runs on the host, so it reaches LM Studio at localhost.
      // (host.docker.internal only resolves *inside* containers — that hostname
      // is what the container uses to reach the proxy, not the other way round.)
      upstreamUrl: process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234",
      realKey: lmStudioToken,
    },
    ollama: {
      // Same host-side reasoning as LM Studio above — proxy runs on host, so
      // Ollama is reached at localhost. Ollama has no auth by default.
      upstreamUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    },
    openai: {
      upstreamUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
      realKey: openaiToken,
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
