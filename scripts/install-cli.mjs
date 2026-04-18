#!/usr/bin/env node
// Install the `teamroom` CLI as a symlink into a user-supplied directory.
// Usage: npm run install-cli -- <target-dir> [--force]
// The caller is responsible for having <target-dir> on their PATH.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = resolve(repoRoot, "dist/cli/main.js");
const linkName = "teamroom";

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length !== 1) {
  console.error("usage: npm run install-cli -- <target-dir> [--force]");
  console.error("example: npm run install-cli -- ~/bin");
  process.exit(2);
}

const targetDir = resolve(positional[0].replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));

try {
  const stat = statSync(targetDir);
  if (!stat.isDirectory()) {
    console.error(`error: ${targetDir} is not a directory`);
    process.exit(1);
  }
} catch {
  console.error(`error: target directory does not exist: ${targetDir}`);
  console.error("create it first (e.g. mkdir -p ~/bin) then re-run this command");
  process.exit(1);
}

try {
  accessSync(targetDir, constants.W_OK);
} catch {
  console.error(`error: target directory is not writable: ${targetDir}`);
  process.exit(1);
}

try {
  statSync(distEntry);
} catch {
  console.log("dist/cli/main.js not found — running npm run build...");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("error: build failed; see output above");
    process.exit(result.status ?? 1);
  }
  try {
    statSync(distEntry);
  } catch {
    console.error(`error: build completed but ${distEntry} is still missing`);
    process.exit(1);
  }
}

try {
  chmodSync(distEntry, 0o755);
} catch (err) {
  console.error(`error: could not chmod +x ${distEntry}: ${err.message}`);
  process.exit(1);
}

const linkPath = resolve(targetDir, linkName);

let existing = null;
try {
  existing = lstatSync(linkPath);
} catch {
  // no existing entry
}

if (existing) {
  if (existing.isSymbolicLink()) {
    const currentTarget = readlinkSync(linkPath);
    if (resolve(targetDir, currentTarget) === distEntry) {
      console.log(`teamroom is already installed at ${linkPath} (points at ${distEntry}). nothing to do.`);
      process.exit(0);
    }
    if (!force) {
      console.error(`error: ${linkPath} already exists as a symlink pointing at ${currentTarget}`);
      console.error("re-run with --force to overwrite:");
      console.error(`  npm run install-cli -- ${positional[0]} --force`);
      process.exit(1);
    }
    unlinkSync(linkPath);
  } else {
    console.error(`error: ${linkPath} already exists and is not a symlink`);
    console.error("remove or rename it manually, or choose a different target directory");
    process.exit(1);
  }
}

symlinkSync(distEntry, linkPath);

console.log(`teamroom installed at ${linkPath}`);
console.log(`  → ${distEntry}`);
console.log();
console.log(`ensure ${targetDir} is in your PATH, then run:`);
console.log(`  teamroom status`);
