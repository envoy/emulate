#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishedName, publishablePackages, rootVersion, repoRoot } from "./release-packages.mjs";

const config = JSON.parse(readFileSync(join(repoRoot, "release-please-config.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repoRoot, ".release-please-manifest.json"), "utf8"));
function tracksRootOnly(value) {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === ".";
}
if (!tracksRootOnly(manifest) || !tracksRootOnly(config.packages)) {
  throw new Error("Release Please must track exactly the repository root");
}
if (rootVersion() !== manifest["."]) throw new Error("Root and Release Please versions differ");
if (config.packages["."]["extra-files"]?.length) {
  throw new Error("Source package versions follow upstream; apply the Envoy version only in release staging");
}
const names = new Set();
for (const pkg of publishablePackages()) {
  const name = publishedName(pkg.name);
  if (names.has(name)) throw new Error(`Duplicate release name: ${name}`);
  names.add(name);
}
console.log(`Release Please tracks Envoy ${manifest["."]}; staging maps ${names.size} upstream packages`);
