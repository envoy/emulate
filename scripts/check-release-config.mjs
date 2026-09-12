#!/usr/bin/env node

/**
 * Guards the Release Please setup. This replaces the old sync-versions check:
 * Release Please now writes every package version, so the job here is to prove
 * that it knows about every package, and that nothing has drifted since the
 * last release.
 *
 * Checks:
 *   1. Both Release Please JSON files parse.
 *   2. The manifest tracks exactly the repository root.
 *   3. Every publishable package appears in the root package's extra-files.
 *   4. Every extra-files entry points at a file that exists.
 *   5. Every publishable package shares the manifest version.
 *   6. Every publishable package is scoped to @envoy and targets GitHub Packages.
 *
 * Usage:
 *   node scripts/check-release-config.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { publishablePackages, rootVersion, repoRoot } from "./release-packages.mjs";

const REGISTRY = "https://npm.pkg.github.com";
const problems = [];

function readJson(relativePath) {
  const absolute = join(repoRoot, relativePath);
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    problems.push(`${relativePath} does not parse: ${error.message}`);
    return null;
  }
}

const config = readJson("release-please-config.json");
const manifest = readJson(".release-please-manifest.json");

if (config && manifest) {
  const manifestPaths = Object.keys(manifest);
  if (manifestPaths.length !== 1 || manifestPaths[0] !== ".") {
    problems.push(`.release-please-manifest.json must track exactly ".", found ${manifestPaths.join(", ")}`);
  }

  const version = manifest["."];
  const root = config.packages?.["."];

  if (!root) {
    problems.push('release-please-config.json must configure the "." package');
  } else {
    if (rootVersion() !== version) {
      problems.push(`package.json is ${rootVersion()}, manifest says ${version}`);
    }

    const extraFiles = root["extra-files"] ?? [];
    const declared = new Set(extraFiles.map((entry) => entry.path));

    for (const entry of extraFiles) {
      if (entry.type !== "json" || entry.jsonpath !== "$.version") {
        problems.push(`extra-files entry ${entry.path} must be a json updater on $.version`);
      }
      if (!existsSync(join(repoRoot, entry.path))) {
        problems.push(`extra-files entry ${entry.path} does not exist`);
      }
    }

    for (const pkg of publishablePackages()) {
      const manifestPath = `${pkg.dir}/package.json`;
      if (!declared.has(manifestPath)) {
        problems.push(`${pkg.name} is publishable but ${manifestPath} is missing from extra-files`);
      }
      if (pkg.version !== version) {
        problems.push(`${pkg.name} is ${pkg.version}, expected ${version}`);
      }
      if (!pkg.name.startsWith("@envoy/")) {
        problems.push(`${pkg.name} must be scoped to @envoy to publish to GitHub Packages`);
      }
      const registry = readJson(manifestPath)?.publishConfig?.registry;
      if (registry !== REGISTRY) {
        problems.push(`${pkg.name} must set publishConfig.registry to ${REGISTRY}, found ${registry ?? "nothing"}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("Release configuration problems:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const count = publishablePackages().length;
console.log(`Release Please covers all ${count} publishable packages at ${manifest["."]}`);
