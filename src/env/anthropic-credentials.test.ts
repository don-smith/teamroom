import { describe, it, expect } from "vitest";
import { discoverAnthropic } from "./anthropic-credentials.js";

const noKeychain = () => undefined;
const noFile = () => undefined;

describe("discoverAnthropic", () => {
  it("env CLAUDE_CODE_OAUTH_TOKEN wins over everything", () => {
    const creds = discoverAnthropic(
      { CLAUDE_CODE_OAUTH_TOKEN: "env-tok", ANTHROPIC_API_KEY: "sk-ant-real" },
      { readMacKeychain: () => "sk-ant-oat01-keychain", readCredentialsFile: () => '{"oauth_token":"file-tok"}', platform: "darwin" },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "env-tok" });
  });

  it("on macOS, Keychain raw token is used when env is missing", () => {
    const creds = discoverAnthropic(
      {},
      { readMacKeychain: () => "sk-ant-oat01-from-keychain\n", readCredentialsFile: noFile, platform: "darwin" },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "sk-ant-oat01-from-keychain" });
  });

  it("on macOS, Keychain JSON blob with oauth_token is used", () => {
    const creds = discoverAnthropic(
      {},
      {
        readMacKeychain: () => JSON.stringify({ oauth_token: "sk-ant-oat01-json", expires_at: 12345 }),
        readCredentialsFile: noFile,
        platform: "darwin",
      },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "sk-ant-oat01-json" });
  });

  it("on macOS, Keychain JSON nested under claudeAiOauth.accessToken is used", () => {
    const creds = discoverAnthropic(
      {},
      {
        readMacKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-nested" } }),
        readCredentialsFile: noFile,
        platform: "darwin",
      },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "sk-ant-oat01-nested" });
  });

  it("on Linux, Keychain is skipped and file is consulted", () => {
    const creds = discoverAnthropic(
      {},
      {
        readMacKeychain: () => "should-not-be-called",
        readCredentialsFile: () => '{"access_token":"sk-ant-oat01-from-file"}',
        platform: "linux",
      },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "sk-ant-oat01-from-file" });
  });

  it("file fallback works on macOS too if keychain is empty", () => {
    const creds = discoverAnthropic(
      {},
      { readMacKeychain: noKeychain, readCredentialsFile: () => '{"token":"sk-ant-oat01-via-file"}', platform: "darwin" },
    );
    expect(creds).toEqual({ mode: "oauth", oauthToken: "sk-ant-oat01-via-file" });
  });

  it("falls back to ANTHROPIC_API_KEY when no OAuth source available", () => {
    const creds = discoverAnthropic(
      { ANTHROPIC_API_KEY: "sk-ant-real" },
      { readMacKeychain: noKeychain, readCredentialsFile: noFile, platform: "darwin" },
    );
    expect(creds).toEqual({ mode: "api-key", apiKey: "sk-ant-real" });
  });

  it("returns null when nothing resolves", () => {
    const creds = discoverAnthropic(
      {},
      { readMacKeychain: noKeychain, readCredentialsFile: noFile, platform: "darwin" },
    );
    expect(creds).toBeNull();
  });

  it("ignores keychain JSON without a recognizable token field", () => {
    const creds = discoverAnthropic(
      { ANTHROPIC_API_KEY: "sk-ant-real" },
      {
        readMacKeychain: () => JSON.stringify({ unrelated: "field" }),
        readCredentialsFile: noFile,
        platform: "darwin",
      },
    );
    expect(creds).toEqual({ mode: "api-key", apiKey: "sk-ant-real" });
  });

  it("ignores keychain raw value that doesn't look like an OAuth token", () => {
    const creds = discoverAnthropic(
      { ANTHROPIC_API_KEY: "sk-ant-real" },
      {
        readMacKeychain: () => "garbage-not-a-token",
        readCredentialsFile: noFile,
        platform: "darwin",
      },
    );
    expect(creds).toEqual({ mode: "api-key", apiKey: "sk-ant-real" });
  });
});
