import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTelegramYaml } from "./telegram-config.js";

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "teamroom-telegram-"));
  const p = join(dir, "telegram.yaml");
  writeFileSync(p, contents, "utf8");
  return p;
}

const ORIG_ENV = { ...process.env };

describe("loadTelegramYaml", () => {
  beforeEach(() => {
    process.env.TELEGRAM_TOKEN_DOC = "123:abc";
    process.env.TELEGRAM_TOKEN_LIBBY = "456:def";
  });

  afterEach(() => {
    // Restore original env (delete keys we added)
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIG_ENV)) {
        delete process.env[key];
      }
    }
  });

  it("parses a valid yaml file with one bot", () => {
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
    repo: my-repo
`);
    try {
      const cfg = loadTelegramYaml(p);
      expect(cfg).toEqual({ bots: [{ agent: "doc", tokenEnvVar: "TELEGRAM_TOKEN_DOC", repo: "my-repo" }] });
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("parses a valid yaml file with multiple bots", () => {
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
    repo: my-repo
  - agent: libby
    tokenEnvVar: TELEGRAM_TOKEN_LIBBY
    repo: other-repo
`);
    try {
      const cfg = loadTelegramYaml(p);
      expect(cfg).toEqual({
        bots: [
          { agent: "doc", tokenEnvVar: "TELEGRAM_TOKEN_DOC", repo: "my-repo" },
          { agent: "libby", tokenEnvVar: "TELEGRAM_TOKEN_LIBBY", repo: "other-repo" },
        ],
      });
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on empty bots array", () => {
    const p = write(`bots: []
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/expected non-empty 'bots' array/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on missing 'bots' key", () => {
    const p = write(`other: true
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/expected non-empty 'bots' array/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on null content", () => {
    const p = write("null");
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/expected non-empty 'bots' array/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on bot entry missing 'agent'", () => {
    const p = write(`bots:
  - tokenEnvVar: TELEGRAM_TOKEN_DOC
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/missing 'agent'/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on bot entry missing 'tokenEnvVar'", () => {
    const p = write(`bots:
  - agent: doc
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/missing 'tokenEnvVar'/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on empty agent string", () => {
    const p = write(`bots:
  - agent: ""
    tokenEnvVar: TELEGRAM_TOKEN_DOC
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/missing 'agent'/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on non-object entry in bots array", () => {
    const p = write(`bots:
  - "string"
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/expected object in bots array/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on missing env var", () => {
    delete process.env.TELEGRAM_TOKEN_DOC;
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/env var 'TELEGRAM_TOKEN_DOC' is not set/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on empty env var", () => {
    process.env.TELEGRAM_TOKEN_DOC = "";
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/env var 'TELEGRAM_TOKEN_DOC' is not set/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on bot entry missing 'repo'", () => {
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/missing 'repo'/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("throws on empty repo string", () => {
    const p = write(`bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
    repo: ""
`);
    try {
      expect(() => loadTelegramYaml(p)).toThrow(/missing 'repo'/);
    } finally {
      rmSync(p, { force: true });
    }
  });
});