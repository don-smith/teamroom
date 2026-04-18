import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { startDaemon, type AnthropicCreds } from "../daemon/daemon.js";
import { readEnvFile } from "../env/env-file.js";

function discoverAnthropic(envFromDotenv: Record<string, string>): AnthropicCreds | null {
  const oauthFromEnv = envFromDotenv.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthFromEnv) return { mode: "oauth", oauthToken: oauthFromEnv };

  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, unknown>;
      const tok =
        (typeof parsed.oauth_token === "string" && parsed.oauth_token) ||
        (typeof parsed.access_token === "string" && parsed.access_token) ||
        (typeof parsed.token === "string" && parsed.token);
      if (tok) return { mode: "oauth", oauthToken: tok };
    } catch {
      // unrecognized format — fall through to API-key fallback
    }
  }

  if (envFromDotenv.ANTHROPIC_API_KEY) {
    return { mode: "api-key", apiKey: envFromDotenv.ANTHROPIC_API_KEY };
  }
  return null;
}

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
