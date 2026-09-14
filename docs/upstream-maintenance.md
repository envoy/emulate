# Maintaining the Envoy distribution

`envoy/emulate` is both the distribution repository and a GitHub fork of
`vercel-labs/emulate`. A second fork is unnecessary. Keep upstream feature work
on clean branches and keep packaging differences in release preparation.

## Package identities and versions

Maintained code imports `emulate` and `@emulators/*`. Source package versions and
metadata follow upstream. The root version and `.release-please-manifest.json`
track the independent Envoy release, with its history in `CHANGELOG.md`.

`bash scripts/prepare-release.sh /tmp/emulate-artifacts` requires an empty output
directory. It copies tracked source into a new temporary directory, rewrites
imports, workspace dependencies and bundler configuration, and applies the Envoy
version and GitHub Packages metadata. Paths such as `packages/@emulators/core`
and the `emulate` executable name stay unchanged. It installs the transformed
lockfile with `--frozen-lockfile`, builds, typechecks, tests, and packs the staged
packages. An isolated consumer installs all tarballs and checks their manifests,
imports, TypeScript declarations, CLI version/help, and a binary S3 roundtrip.
Stage new files with Git before running this locally; untracked files are excluded.

Published names remain `@envoy/emulate` and `@envoy/emulators-*`. Consumer install
examples therefore continue to use `npx @envoy/emulate`. Only the release workflow
publishes, after verifying and attesting the exact tarballs. Never publish the
upstream-named source workspaces directly.

## Syncing upstream

Check weekly and when an important upstream fix lands:

```bash
git fetch origin main
git fetch --no-tags upstream main
git switch -c codex/sync-upstream origin/main
git merge --no-ff upstream/main
```

Keep upstream tags out of the local release namespace: both projects use `vX.Y.Z`
for independent releases. Fetch upstream commits with `--no-tags` and push only
the intended branch, without `--tags` or `--follow-tags`.

Resolve conflicts by comparing behavior and tests. When upstream reimplements a
contribution, retain its implementation and reconcile any remaining local
behavior. Do not replay already-landed changes solely because their commit IDs
differ. Keep the Envoy root release version and release workflows. Regenerate the
lockfile with pnpm only when dependency reconciliation requires it.

Run `pnpm build`, `pnpm format:check`, `pnpm type-check`, `pnpm lint`, `pnpm test`,
`pnpm test:release`, and the artifact preparation command above. Open a sync PR
against this repository's `main`. **Land with a merge commit, never squash or
rebase:** upstream commits must remain ancestors of `main` for subsequent merges.
Verify with `git merge-base --is-ancestor <synced-upstream-sha> origin/main` after
fetching the merged result.

## Contributing features

Start each contribution from current `upstream/main`, using another worktree
when the distribution branch has work in progress. Push the topic branch to
`envoy/emulate`, then target `vercel-labs/emulate:main`. Topic branches do not need
to descend from the Envoy default branch.

Prefer one feature per PR with tests, documentation and generic examples. Exclude
GPR configuration, release automation, Envoy names, unrelated fixes, and internal
integration details. Bring feature commits into the distribution while upstream
review is pending; later merge upstream and reconcile differences.

The initial backlog includes:

| Feature | Starting evidence | Contribution approach |
| --- | --- | --- |
| SendGrid mail and optional Gmail inspection | Pre-rename commit `18a5b82`, closed upstream PR #226 | Refresh against upstream; exclude the unrelated HTTP HEAD fix |
| STS AssumeRoleWithWebIdentity | Pre-rename commit `69bb09a` | Extract STS behavior, tests and docs into its own PR |
| KMS Encrypt/Decrypt | Pre-rename commit `69bb09a` | Extract the JSON protocol and KMS behavior into its own PR |
| Calendar synchronization and Directory resources | Commit `8161850` | Separate from the Calendar discovery endpoint already upstream |

S3 binary support is upstream through #241 and #245. The integration retains
upstream's legacy-snapshot compatibility. The first sync baseline is upstream
`8141145f5694a07a46c86cf96bcd5055a44488a1` (v0.11.2).
