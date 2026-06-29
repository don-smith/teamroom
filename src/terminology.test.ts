import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...tsFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("process terminology", () => {
  test("source uses Team Room daemon process-boundary terminology", () => {
    const offenders: string[] = [];
    for (const file of tsFiles("src")) {
      const lower = "me" + "ta";
      const title = "Me" + "ta";
      const upper = "ME" + "TA";
      const source = readFileSync(file, "utf8")
        .replaceAll(`import.${lower}`, "import_metadata_syntax");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if ([lower, title, upper].some((word) => new RegExp(`\\b${word}\\b`).test(line))) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
