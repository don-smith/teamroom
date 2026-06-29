import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Regression coverage for CLI → Team Room daemon composition wiring.
 *
 * The Team Room daemon owns Telegram in the split-daemon architecture, so the CLI
 * startup path must pass the canonical ~/.teamroom/telegram.yaml path into
 * startTeamRoomDaemon. Otherwise Telegram is silently skipped even when the config
 * exists.
 */
describe("serveTeamRoom wiring", () => {
  test("passes ~/.teamroom/telegram.yaml to startTeamRoomDaemon", () => {
    const source = readFileSync("src/cli/serve-teamroom.ts", "utf8");

    expect(source).toContain("telegramYamlPath");
    expect(source).toContain('join(TEAMROOM_DIR, "telegram.yaml")');
  });
});
