import { readFileSync } from "node:fs";
import YAML from "yaml";

export interface TelegramBotEntry {
  /** Agent name this bot is paired with (e.g. "doc") */
  agent: string;
  /** Name of the env var holding this bot's Telegram token (e.g. "TELEGRAM_TOKEN_DOC") */
  tokenEnvVar: string;
}

export interface TelegramConfig {
  bots: TelegramBotEntry[];
}

/**
 * Load telegram.yaml. Follows the lists.yaml pattern at
 * src/mailing-lists/loader.ts:1-38 — readFileSync + YAML.parse + per-entry validation.
 *
 * Expected format:
 * ```yaml
 * bots:
 *   - agent: doc
 *     tokenEnvVar: TELEGRAM_TOKEN_DOC
 *   - agent: libby
 *     tokenEnvVar: TELEGRAM_TOKEN_LIBBY
 * ```
 */
export function loadTelegramYaml(path: string): TelegramConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw) as { bots?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.bots) || parsed.bots.length === 0) {
    throw new Error(`telegram.yaml: expected non-empty 'bots' array`);
  }
  const bots: TelegramBotEntry[] = [];
  for (const entry of parsed.bots) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`telegram.yaml: expected object in bots array, got ${typeof entry}`);
    }
    const e = entry as Record<string, unknown>;
    const agent = e.agent;
    if (typeof agent !== "string" || agent.length === 0) {
      throw new Error(`telegram.yaml: bot entry missing 'agent'`);
    }
    const tokenEnvVar = e.tokenEnvVar;
    if (typeof tokenEnvVar !== "string" || tokenEnvVar.length === 0) {
      throw new Error(`telegram.yaml: bot entry missing 'tokenEnvVar' (agent=${agent})`);
    }
    if (!process.env[tokenEnvVar] || process.env[tokenEnvVar]!.trim() === "") {
      throw new Error(
        `telegram.yaml: env var '${tokenEnvVar}' is not set or empty (agent=${agent})`,
      );
    }
    bots.push({ agent, tokenEnvVar });
  }
  return { bots };
}