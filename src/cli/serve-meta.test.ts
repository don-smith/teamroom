import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Regression coverage for CLI → meta-process composition wiring.
 *
 * The meta-process owns Telegram in the split-daemon architecture, so the CLI
 * startup path must pass the canonical ~/.teamroom/telegram.yaml path into
 * startMetaDaemon. Otherwise Telegram is silently skipped even when the config
 * exists.
 */
describe("serveMeta wiring", () => {
  test("passes ~/.teamroom/telegram.yaml to startMetaDaemon", () => {
    const source = readFileSync("src/cli/serve-meta.ts", "utf8");

    expect(source).toContain("telegramYamlPath");
    expect(source).toContain('join(TEAMROOM_DIR, "telegram.yaml")');
  });
});
