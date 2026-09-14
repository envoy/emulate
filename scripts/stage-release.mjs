#!/usr/bin/env node

// Rename a fresh copy before building so JavaScript, declarations, and package
// dependencies all agree. The maintained source keeps upstream identities.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, lstatSync, copyFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, extname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, publishedName, publishablePackages, rootVersion, registry } from "./release-packages.mjs";

export function rewriteReferences(text, names) {
  for (const [source, target] of names) {
    const escaped = RegExp.escape(source);
    // Do not rename repository paths such as packages/@emulators/core.
    if (source !== "emulate") {
      text = text.replace(new RegExp(`(?<![\\w@/.-])${escaped}(?![\\w-])`, "g"), target);
    } else {
      text = text.replace(
        /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'])emulate(?=[/"'])/g,
        `$1$2${target}`,
      );
    }
  }
  // tsup's regexes contain escaped slashes, unlike import specifiers.
  return text.replaceAll("@emulators\\/", "@envoy\\/emulators-");
}

export function stageRelease(destination, root = repoRoot) {
  root = realpathSync(root);
  destination = resolve(destination);
  // Require an existing parent and a new directory, including through symlinks.
  destination = join(realpathSync(dirname(destination)), basename(destination));
  const rel = relative(root, destination);
  if (!rel || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error("Release staging must be outside the source checkout");
  }
  const packages = publishablePackages(root);
  const names = new Map(packages.map((pkg) => [pkg.name, publishedName(pkg.name)]));
  const version = rootVersion(root);
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error("The release version must be a stable semantic version");
  }
  const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
  mkdirSync(destination);
  for (const file of new Set(files)) {
    const source = join(root, file);
    if (!lstatSync(source).isFile()) throw new Error(`Release source must be a regular file: ${file}`);
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    if ([".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".md", ".mdx"].includes(extname(file))) {
      // Manifest dependency keys are handled by the package-name rewrite; the
      // CLI bin name remains emulate because the executable has not changed.
      let text = rewriteReferences(readFileSync(target, "utf8"), names);
      if (file.endsWith("package.json")) {
        const pkg = JSON.parse(text);
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          if (pkg[field]?.emulate) {
            pkg[field]["@envoy/emulate"] = pkg[field].emulate;
            delete pkg[field].emulate;
          }
        }
        text = JSON.stringify(pkg, null, 2) + "\n";
      }
      writeFileSync(target, text);
    }
  }
  for (const pkg of packages) {
    const path = join(destination, pkg.dir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.name = names.get(pkg.name);
    manifest.version = version;
    manifest.repository = { type: "git", url: "https://github.com/envoy/emulate.git", directory: pkg.dir };
    manifest.bugs = { url: "https://github.com/envoy/emulate/issues" };
    manifest.publishConfig = { registry };
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  }
  return { destination, version, packages: packages.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/stage-release.mjs <new-directory>");
  console.log(JSON.stringify(stageRelease(process.argv[2])));
}
