#!/bin/sh
# update-version.sh: Update version in manifests with SemVer + build counter

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Cross-browser version format (Chrome + Firefox):
#   MAJOR.MINOR.PATCH.BUILD
# - 4 numeric parts, each <= 65535 (Chrome limit)
# - no leading zeros in non-zero parts
# - BUILD increments on each release build for fast deploys
VERSION_FILE="$ROOT_DIR/VERSION"
BUILD_FILE="$ROOT_DIR/VERSION_BUILD"

BASE_VERSION=$(cat "$VERSION_FILE")
IFS='.' read -r MAJOR MINOR PATCH <<EOF
$BASE_VERSION
EOF

if [ -z "${MAJOR:-}" ] || [ -z "${MINOR:-}" ] || [ -z "${PATCH:-}" ]; then
  echo "Invalid VERSION format, expected MAJOR.MINOR.PATCH in $VERSION_FILE" >&2
  exit 1
fi

BUILD=0
if [ -f "$BUILD_FILE" ]; then
  BUILD=$(cat "$BUILD_FILE")
fi

BUILD=$((BUILD + 1))

if [ "$BUILD" -gt 65535 ]; then
  echo "BUILD overflow (>65535). Reset BUILD or bump VERSION." >&2
  exit 1
fi

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}.${BUILD}"

echo "Updating version to: $NEW_VERSION"

MANIFESTS="$ROOT_DIR/manifest.json $ROOT_DIR/manifest-ff.json"

# Update version in manifests using sed (GNU/BSD compatible)
if sed --version >/dev/null 2>&1; then
  for manifest in $MANIFESTS; do
    sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$manifest"
  done
else
  for manifest in $MANIFESTS; do
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$manifest"
  done
fi

echo "$BUILD" > "$BUILD_FILE"

echo "Version updated in: $MANIFESTS"
