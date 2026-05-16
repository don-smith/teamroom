#!/usr/bin/env bun
// Install the `teamroom` CLI as a symlink into a user-supplied directory.
// Usage: bun scripts/install-cli.ts <target-dir> [--force]
// The caller is responsible for having <target-dir> on their PATH.

import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(repoRoot, "src/cli/main.ts");
const linkName = "teamroom";

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((arg) => !arg.startsWith("--"));

if (positional.length !== 1) {
  console.error("usage: bun scripts/install-cli.ts <target-dir> [--force]");
  console.error("example: bun scripts/install-cli.ts ~/bin");
  process.exit(2);
}

const requestedDir = positional[0];
const homeDir = process.env.HOME ?? "~";
const targetDir = resolve(requestedDir.replace(/^~(?=\/|$)/, homeDir));
mkdirSync(targetDir, { recursive: true });

try {
  chmodSync(cliEntry, 0o755);
} catch (err) {
  console.error(`error: could not chmod +x ${cliEntry}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const linkPath = resolve(targetDir, linkName);

try {
  const existing = lstatSync(linkPath);
  if (existing.isSymbolicLink()) {
    const currentTarget = readlinkSync(linkPath);
    if (!force) {
      console.error(`error: ${linkPath} already exists as a symlink pointing at ${currentTarget}`);
      console.error("re-run with --force to overwrite:");
      console.error(`  bun scripts/install-cli.ts ${requestedDir} --force`);
      process.exit(1);
    }
  } else if (!force) {
    console.error(`error: ${linkPath} already exists and is not a symlink`);
    console.error("remove or rename it manually, or choose a different target directory");
    process.exit(1);
  }

  rmSync(linkPath, { force: true, recursive: existing.isDirectory() });
} catch (err) {
  if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
    throw err;
  }
}

symlinkSync(cliEntry, linkPath);

console.log(`teamroom installed at ${linkPath}`);
console.log(`  → ${cliEntry}`);
console.log();
console.log(`ensure ${targetDir} is in your PATH, then run:`);
console.log("  teamroom status");
