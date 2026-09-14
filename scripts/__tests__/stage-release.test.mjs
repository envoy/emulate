import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { stageRelease, rewriteReferences } from "../stage-release.mjs";

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), "emulate-stage-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  mkdirSync(root);
  const files = {
    "package.json": JSON.stringify({ name: "root", private: true, version: "1.2.3" }),
    "packages/emulate/package.json": JSON.stringify({
      name: "emulate",
      version: "0.11.2",
      bin: { emulate: "dist/index.js" },
      devDependencies: { "@emulators/core": "workspace:*" },
    }),
    "packages/@emulators/core/package.json": JSON.stringify({
      name: "@emulators/core",
      version: "0.11.2",
      publishConfig: { access: "public" },
    }),
    "packages/emulate/src/api.ts":
      'import { createServer } from "@emulators/core";\nexport { createEmulator } from "emulate";\nconst fonts = "../@emulators/core/src/fonts";\n',
    "pnpm-lock.yaml":
      "importers:\n  packages/emulate:\n    devDependencies:\n      '@emulators/core':\n        specifier: workspace:*\n        version: link:../@emulators/core\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["add", "."], { cwd: root });
  writeFileSync(join(root, "local-secret.txt"), "not a release input");
  return { parent, root, files };
}

test("stages mapped packages and imports without changing source, paths, or executable names", (t) => {
  const { parent, root, files } = fixture(t);
  const target = join(parent, "release");
  assert.deepEqual(stageRelease(target, root), {
    destination: join(realpathSync(parent), "release"),
    version: "1.2.3",
    packages: 2,
  });
  const cli = JSON.parse(readFileSync(join(target, "packages/emulate/package.json")));
  assert.equal(cli.name, "@envoy/emulate");
  assert.equal(cli.version, "1.2.3");
  assert.equal(cli.bin.emulate, "dist/index.js");
  assert.deepEqual(cli.devDependencies, { "@envoy/emulators-core": "workspace:*" });
  assert.deepEqual(cli.publishConfig, { registry: "https://npm.pkg.github.com" });
  assert.equal(cli.repository.directory, "packages/emulate");
  const api = readFileSync(join(target, "packages/emulate/src/api.ts"), "utf8");
  assert.match(api, /from "@envoy\/emulators-core"/);
  assert.match(api, /from "@envoy\/emulate"/);
  assert.match(api, /\.\.\/@emulators\/core\/src\/fonts/);
  assert.match(readFileSync(join(target, "pnpm-lock.yaml"), "utf8"), /version: link:\.\.\/@emulators\/core/);
  assert.equal(existsSync(join(target, "local-secret.txt")), false);
  for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(root, file), "utf8"), text);
  assert.throws(() => stageRelease(target, root), /EEXIST/);
});

test("rejects staging into the checkout, including through a symlink", (t) => {
  const { parent, root } = fixture(t);
  assert.throws(() => stageRelease(join(root, "release"), root), /outside/);
  symlinkSync(root, join(parent, "alias"));
  assert.throws(() => stageRelease(join(parent, "alias/release"), root), /outside/);
});

test("rewrites subpath imports and bundler regexes without rewriting similar package names", () => {
  const names = new Map([
    ["@emulators/core", "@envoy/emulators-core"],
    ["emulate", "@envoy/emulate"],
  ]);
  const input =
    'import "@emulators/core/package.json"; import("emulate/cli"); const x = /^@emulators\\//; import "@emulators/core-extra";';
  assert.equal(
    rewriteReferences(input, names),
    'import "@envoy/emulators-core/package.json"; import("@envoy/emulate/cli"); const x = /^@envoy\\/emulators-/; import "@emulators/core-extra";',
  );
});

test("fails before staging an unknown publishable package", (t) => {
  const { parent, root } = fixture(t);
  writeFileSync(
    join(root, "packages/@emulators/core/package.json"),
    JSON.stringify({ name: "unexpected", version: "1.0.0" }),
  );
  assert.throws(() => stageRelease(join(parent, "release"), root), /No release name mapping/);
  assert.equal(existsSync(join(parent, "release")), false);
});
