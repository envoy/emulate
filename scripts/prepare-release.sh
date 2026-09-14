#!/usr/bin/env bash
set -euo pipefail

# Both PR CI and the publisher use this exact preparation and verification path.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?Usage: bash scripts/prepare-release.sh <artifact-directory>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
if [ -n "$(ls -A "$OUT")" ]; then
  echo "Artifact directory must be empty: $OUT" >&2
  exit 1
fi
TASK_RELEASE_PARENT="$(mktemp -d)"
trap 'rm -rf "$TASK_RELEASE_PARENT"' EXIT
STAGE="$TASK_RELEASE_PARENT/source"
node "$ROOT/scripts/check-release-config.mjs"
node "$ROOT/scripts/stage-release.mjs" "$STAGE"
(
  cd "$STAGE"
  pnpm install --frozen-lockfile
  # A staged tree has no Git metadata. Build only the published workspaces;
  # the normal source CI separately builds the documentation and examples.
  pnpm --filter './packages/**' build
  pnpm --filter './packages/**' type-check
  pnpm --filter './packages/**' test
)
: > "$OUT/manifest.tsv"
while IFS=$'\t' read -r dir name version; do
  TARBALL="$(cd "$STAGE/$dir" && pnpm pack --pack-destination "$OUT" | tail -1)"
  test -f "$TARBALL"
  printf '%s\t%s\n' "$name" "$TARBALL" >> "$OUT/manifest.tsv"
done < <(node "$ROOT/scripts/release-packages.mjs" --list "$STAGE")
node "$ROOT/scripts/verify-release.mjs" "$OUT"
