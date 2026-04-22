import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load `.env` from the given directory and inject every well-formed
 * `KEY=value` pair into `process.env`. Values already present on
 * `process.env` (i.e. set by the shell) take precedence — `.env` only
 * fills in missing keys.
 *
 * Lines beginning with `#` and blank lines are ignored. Values may be
 * single- or double-quoted; the surrounding quotes are stripped.
 *
 * Silent if `.env` is absent — that's a normal state when a user runs
 * the harness without local config.
 */
export function loadEnvFile(dir: string): void {
  const envFile = join(dir, ".env");
  let content: string;
  try {
    content = readFileSync(envFile, "utf-8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
