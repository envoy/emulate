#!/usr/bin/env node

// Exercise tarballs from a standalone consumer. Local overrides make every
// workspace dependency resolve to the artifact under test, never the registry.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot, publishablePackages, publishedName, rootVersion, registry } from "./release-packages.mjs";

const artifacts = resolve(process.argv[2] ?? "dist-release");
const expected = new Set(publishablePackages().map((pkg) => publishedName(pkg.name)));
const version = rootVersion();
const temp = mkdtempSync(join(tmpdir(), "emulate-release-consumer-"));
const dependencies = {};
try {
  for (const file of readdirSync(artifacts).filter((file) => file.endsWith(".tgz"))) {
    const tarball = join(artifacts, file);
    const pkg = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
    if (!expected.delete(pkg.name)) throw new Error(`Unexpected or duplicate artifact: ${pkg.name}`);
    if (pkg.version !== version || pkg.publishConfig?.registry !== registry) {
      throw new Error(`Incorrect release identity: ${pkg.name}@${pkg.version}`);
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (name === "emulate" || name.startsWith("@emulators/") || range.startsWith("workspace:")) {
          throw new Error(`Unmapped dependency in ${pkg.name}: ${name}@${range}`);
        }
        if (name.startsWith("@envoy/emulators-") && range !== version) {
          throw new Error(`Release dependency version mismatch: ${name}@${range}`);
        }
      }
    }
    const unpacked = join(temp, pkg.name.replaceAll("/", "-"));
    mkdirSync(unpacked);
    execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
    for (const path of readdirSync(join(unpacked, "package/dist"), { recursive: true })) {
      if (!/\.(?:js|mjs|cjs|ts)$/.test(path)) continue;
      const content = readFileSync(join(unpacked, "package/dist", path), "utf8");
      if (/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:@emulators\/|emulate(?:["'/]))/.test(content)) {
        throw new Error(`Unmapped import in ${pkg.name}/dist/${path}`);
      }
    }
    dependencies[pkg.name] = `file:${tarball}`;
  }
  if (expected.size) throw new Error(`Missing artifacts: ${[...expected].join(", ")}`);
  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      devDependencies: {
        "@types/node": JSON.parse(readFileSync(join(repoRoot, "node_modules/@types/node/package.json"), "utf8"))
          .version,
      },
    }),
  );
  writeFileSync(join(consumer, "pnpm-workspace.yaml"), `overrides: ${JSON.stringify(dependencies)}\n`);
  execFileSync("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], {
    cwd: consumer,
    stdio: "inherit",
  });
  const names = Object.keys(dependencies);
  writeFileSync(join(consumer, "imports.mjs"), `for (const name of ${JSON.stringify(names)}) await import(name);`);
  execFileSync(process.execPath, ["imports.mjs"], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import assert from 'node:assert/strict';
const { createEmulator } = await import('@envoy/emulate');
const { createServer } = await import('node:net');
const probe = createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const emulator = await createEmulator({ service: 'aws', port, baseUrl: 'http://127.0.0.1:' + port });
try {
  const body = new Uint8Array([0, 255, 128, 42]);
  const headers = { Authorization: 'AWS4-HMAC-SHA256 Credential=test/20250101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=test' };
  const put = await fetch(emulator.url + '/emulate-default/release.bin', { method: 'PUT', headers, body });
  assert.equal(put.status, 200);
  const get = await fetch(emulator.url + '/emulate-default/release.bin', { headers });
  assert.equal(get.status, 200);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), body);
} finally { await emulator.close(); }
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: consumer, stdio: "inherit" });
  const cliVersion = execFileSync(process.execPath, ["node_modules/@envoy/emulate/dist/index.js", "--version"], {
    cwd: consumer,
    encoding: "utf8",
  }).trim();
  if (cliVersion !== version) throw new Error(`CLI version is ${cliVersion}, expected ${version}`);
  execFileSync(process.execPath, ["node_modules/@envoy/emulate/dist/index.js", "--help"], {
    cwd: consumer,
    stdio: "pipe",
  });
  writeFileSync(
    join(consumer, "consumer.mts"),
    names.map((name, index) => `import * as package${index} from '${name}';\nvoid package${index};`).join("\n"),
  );
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "consumer.mts",
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const cliConsumer = join(temp, "cli-only");
  mkdirSync(cliConsumer);
  writeFileSync(
    join(cliConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@envoy/emulate": dependencies["@envoy/emulate"] },
    }),
  );
  execFileSync("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], {
    cwd: cliConsumer,
    stdio: "inherit",
  });
  writeFileSync(join(cliConsumer, "smoke.mjs"), readFileSync(join(consumer, "smoke.mjs")));
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: cliConsumer, stdio: "inherit" });
  execFileSync(process.execPath, ["node_modules/@envoy/emulate/dist/index.js", "--help"], {
    cwd: cliConsumer,
    stdio: "pipe",
  });
  console.log(
    `Verified ${names.length} tarballs: manifests, imports, declarations, CLI ${version}, CLI-only install, and binary S3 roundtrips`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
