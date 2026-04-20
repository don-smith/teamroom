import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadListsYaml } from "./loader.js";

function write(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "teamroom-lists-"));
  const p = join(dir, "lists.yaml");
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("loadListsYaml", () => {
  it("parses a well-formed file", () => {
    const p = write(`lists:
  - name: harness-activity
    triggers: [turn.started, turn.completed]
  - name: silence
    triggers: []
`);
    try {
      const defs = loadListsYaml(p);
      expect(defs).toEqual([
        { name: "harness-activity", triggers: ["turn.started", "turn.completed"] },
        { name: "silence", triggers: [] },
      ]);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("returns [] for an empty file or missing 'lists' key", () => {
    const p = write("");
    try {
      expect(loadListsYaml(p)).toEqual([]);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("rejects a list missing a name", () => {
    const p = write(`lists:
  - triggers: [a]
`);
    try {
      expect(() => loadListsYaml(p)).toThrow(/missing 'name'/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("rejects non-string trigger entries", () => {
    const p = write(`lists:
  - name: x
    triggers: [42]
`);
    try {
      expect(() => loadListsYaml(p)).toThrow(/trigger entries must be strings/);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it("defaults missing triggers to []", () => {
    const p = write(`lists:
  - name: x
`);
    try {
      expect(loadListsYaml(p)).toEqual([{ name: "x", triggers: [] }]);
    } finally {
      rmSync(p, { force: true });
    }
  });
});
