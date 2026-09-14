#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const registry = "https://npm.pkg.github.com";

export function publishedName(name) {
  if (name === "emulate") return "@envoy/emulate";
  if (/^@emulators\/[a-z0-9-]+$/.test(name)) return name.replace("@emulators/", "@envoy/emulators-");
  throw new Error(`No release name mapping for ${name}`);
}

export function publishablePackages(root = repoRoot) {
  const dirs = ["packages/emulate"];
  for (const entry of readdirSync(join(root, "packages/@emulators")).sort()) {
    dirs.push(`packages/@emulators/${entry}`);
  }
  const found = [];
  for (const dir of dirs) {
    const path = join(root, dir, "package.json");
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (pkg.private || !pkg.version) continue;
    found.push({ dir, name: pkg.name, version: pkg.version });
  }
  function rank(name) {
    if (["@emulators/core", "@envoy/emulators-core"].includes(name)) return 0;
    if (["emulate", "@envoy/emulate"].includes(name)) return 2;
    return 1;
  }
  return found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function rootVersion(root = repoRoot) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--list") throw new Error("Usage: node scripts/release-packages.mjs --list [root]");
  for (const pkg of publishablePackages(process.argv[3])) {
    process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
  }
}
