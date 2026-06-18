import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentConfig } from "../agent-config/agent-config.js";
import { startDaemon } from "../daemon/daemon.js";
import { loadEnvFile } from "../env/env-file.js";
import { discoverAnthropic } from "../env/anthropic-credentials.js";
import type { Provider } from "../types.js";

export async function serve(): Promise<void> {
  const root = resolve(process.cwd());
  const agentsDir = join(root, "agents");

  // Inject .env into process.env (shell-set values take precedence).
  // Every TEAMROOM_* / LM_STUDIO_* / ANTHROPIC_* / CLAUDE_CODE_* var the
  // daemon reads is now sourced uniformly from process.env, whether it
  // came from .env or the shell.
  loadEnvFile(root);

  const providers = discoverConfiguredProviders(agentsDir);
  const { lmStudioToken, openaiToken, openrouterToken } = resolveServeProviderTokens(providers, process.env);

  const anthropic = discoverAnthropic();

  const daemon = await startDaemon({
    dataDir: join(root, "data"),
    agentsDir,
    lmStudio: {
      // The proxy runs on the host, so it reaches LM Studio at localhost.
      // (host.docker.internal only resolves *inside* containers — that hostname
      // is what the container uses to reach the proxy, not the other way round.)
      upstreamUrl: process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234",
      realKey: lmStudioToken ?? "",
    },
    ollama: {
      // Same host-side reasoning as LM Studio above — proxy runs on host, so
      // Ollama is reached at localhost. Ollama has no auth by default.
      upstreamUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    },
    openai: {
      upstreamUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
      realKey: openaiToken ?? "",
    },
    openrouter: {
      upstreamUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
      realKey: openrouterToken ?? "",
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

export function resolveServeProviderTokens(
  providers: readonly Provider[],
  env: Record<string, string | undefined>,
): { lmStudioToken: string | null; openaiToken: string | null; openrouterToken: string | null } {
  const needsLmStudio = providers.includes("lm-studio");
  const lmStudioToken = env.LM_STUDIO_API_TOKEN ?? null;
  if (needsLmStudio && !lmStudioToken) {
    throw new Error("LM_STUDIO_API_TOKEN missing from .env");
  }

  const needsOpenAi = providers.includes("openai");
  const openaiToken = env.OPENAI_TOKEN ?? null;
  if (needsOpenAi && !openaiToken) {
    throw new Error("OPENAI_TOKEN missing from .env");
  }

  const needsOpenRouter = providers.includes("openrouter");
  const openrouterToken = env.OPENROUTER_API_KEY ?? null;
  if (needsOpenRouter && !openrouterToken) {
    throw new Error("OPENROUTER_API_KEY missing from .env");
  }

  return { lmStudioToken, openaiToken, openrouterToken };
}

function discoverConfiguredProviders(agentsDir: string): Provider[] {
  if (!existsSync(agentsDir)) return [];
  const providers = new Set<Provider>();
  for (const entry of readdirSync(agentsDir)) {
    const full = join(agentsDir, entry);
    if (!statSync(full).isDirectory()) continue;
    providers.add(loadAgentConfig(full).provider);
  }
  return [...providers];
}
