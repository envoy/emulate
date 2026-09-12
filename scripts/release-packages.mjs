#!/usr/bin/env node

/**
 * Single source of truth for the set of packages this repository publishes to
 * GitHub Packages.
 *
 * A workspace package is publishable when it lives under `packages/`, is not
 * marked private, and carries a version. The order matters to the publisher:
 * `@envoy/emulators-core` goes first because every other emulator depends on
 * it, and the CLI goes last because it bundles all of them.
 *
 * Usage:
 *   node scripts/release-packages.mjs --list   # "<dir>\t<name>\t<version>" lines
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const CORE = "@envoy/emulators-core";
const CLI = "@envoy/emulate";

function readManifest(dir) {
  const path = join(repoRoot, dir, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function candidateDirs() {
  const dirs = ["packages/emulate"];
  for (const entry of readdirSync(join(repoRoot, "packages/@emulators")).sort()) {
    dirs.push(`packages/@emulators/${entry}`);
  }
  return dirs;
}

export function publishablePackages() {
  const found = [];
  for (const dir of candidateDirs()) {
    const pkg = readManifest(dir);
    if (!pkg || pkg.private || !pkg.version) continue;
    found.push({ dir, name: pkg.name, version: pkg.version });
  }
  return found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function rank(name) {
  if (name === CORE) return 0;
  if (name === CLI) return 2;
  return 1;
}

export function rootVersion() {
  return readManifest(".").version;
}

if (process.argv.includes("--list")) {
  for (const pkg of publishablePackages()) {
    process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
  }
}
