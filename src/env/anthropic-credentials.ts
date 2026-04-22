import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { AnthropicCreds } from "../daemon/daemon.js";

export interface DiscoverDeps {
  /** Returns the raw value of a generic-password keychain entry, or undefined if absent. */
  readMacKeychain?: (service: string) => string | undefined;
  /** Returns the contents of `~/.claude/.credentials.json` on Linux/Windows, or undefined if absent. */
  readCredentialsFile?: () => string | undefined;
  /** Override the platform detection (test-only). Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_PREFIX = "sk-ant-oat01-";

/**
 * Resolves Anthropic credentials in this order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (loaded from .env or shell)
 *   2. macOS Keychain entry "Claude Code-credentials" (darwin only)
 *   3. ~/.claude/.credentials.json (Linux/Windows file fallback)
 *   4. ANTHROPIC_API_KEY env var (loaded from .env or shell)
 *   5. null — daemon will refuse provider:anthropic agents with `missing_credential`.
 *
 * Steps 2 and 3 may store the token either as a raw `sk-ant-oat01-...` string OR as a JSON
 * blob with one of the fields `oauth_token` / `access_token` / `token`. Both shapes are
 * accepted (the keychain blob format is undocumented and may evolve with Claude Code updates).
 *
 * `env` defaults to `process.env`. Tests pass an explicit env dict to avoid polluting
 * the global process state.
 */
export function discoverAnthropic(
  env: Record<string, string | undefined> = process.env,
  deps: DiscoverDeps = {},
): AnthropicCreds | null {
  const oauthFromEnv = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthFromEnv) return { mode: "oauth", oauthToken: oauthFromEnv };

  const plat = deps.platform ?? platform();
  if (plat === "darwin") {
    const readKc = deps.readMacKeychain ?? defaultReadMacKeychain;
    const raw = readKc(KEYCHAIN_SERVICE);
    if (raw) {
      const tok = extractToken(raw);
      if (tok) return { mode: "oauth", oauthToken: tok };
    }
  }

  const readFile = deps.readCredentialsFile ?? defaultReadCredentialsFile;
  const fileContents = readFile();
  if (fileContents) {
    const tok = extractToken(fileContents);
    if (tok) return { mode: "oauth", oauthToken: tok };
  }

  if (env.ANTHROPIC_API_KEY) {
    return { mode: "api-key", apiKey: env.ANTHROPIC_API_KEY };
  }
  return null;
}

/**
 * Pulls a token out of an opaque string. Tries JSON parse first (Claude Code's stored format
 * on Linux/Windows and possibly macOS Keychain); falls back to treating the whole string as
 * the token if it has the `sk-ant-oat01-` prefix.
 */
function extractToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const fromJson =
      (typeof parsed.oauth_token === "string" && parsed.oauth_token) ||
      (typeof parsed.access_token === "string" && parsed.access_token) ||
      (typeof parsed.token === "string" && parsed.token);
    if (fromJson) return fromJson;
    // Some Claude Code versions nest under `claudeAiOauth`/`oauth`/`credentials`.
    for (const key of ["claudeAiOauth", "oauth", "credentials"]) {
      const nested = parsed[key];
      if (nested && typeof nested === "object") {
        const innerToken =
          (typeof (nested as Record<string, unknown>).accessToken === "string" && (nested as Record<string, unknown>).accessToken) ||
          (typeof (nested as Record<string, unknown>).access_token === "string" && (nested as Record<string, unknown>).access_token) ||
          (typeof (nested as Record<string, unknown>).oauth_token === "string" && (nested as Record<string, unknown>).oauth_token);
        if (innerToken && typeof innerToken === "string") return innerToken;
      }
    }
    return undefined;
  } catch {
    // Not JSON — accept if it looks like a raw OAuth token.
    if (trimmed.startsWith(TOKEN_PREFIX)) return trimmed;
    return undefined;
  }
}

function defaultReadMacKeychain(service: string): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out;
  } catch {
    return undefined;
  }
}

function defaultReadCredentialsFile(): string | undefined {
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credsPath)) return undefined;
  try {
    return readFileSync(credsPath, "utf8");
  } catch {
    return undefined;
  }
}
