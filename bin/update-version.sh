#!/bin/sh
# update-version.sh: Update version in manifests with SemVer + build counter

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Cross-browser version format (Chrome + Firefox):
#   MAJOR.MINOR.PATCH.BUILD
# - 4 numeric parts, each <= 65535 (Chrome limit)
# - no leading zeros in non-zero parts
# - BUILD increments on each release build for fast deploys
BUILD_FILE="$ROOT_DIR/VERSION_BUILD"

BASE_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
if [ -z "$BASE_VERSION" ]; then
  BASE_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || true)
fi

if [ -z "$BASE_VERSION" ]; then
  echo "No git tag found. Create a tag like v0.0.2 for the base version." >&2
  exit 1
fi

BASE_VERSION=$(echo "$BASE_VERSION" | sed 's/^v//')
IFS='.' read -r MAJOR MINOR PATCH <<EOF
$BASE_VERSION
EOF

if [ -z "${MAJOR:-}" ] || [ -z "${MINOR:-}" ] || [ -z "${PATCH:-}" ]; then
  echo "Invalid tag format, expected MAJOR.MINOR.PATCH in git tag" >&2
  exit 1
fi

for part in "$MAJOR" "$MINOR" "$PATCH"; do
  if [ "$part" -gt 65535 ] 2>/dev/null; then
    echo "Version part exceeds Chrome limit (65535): $part" >&2
    exit 1
  fi
done

BUILD=0
BUILD_BASE=''
if [ -f "$BUILD_FILE" ]; then
  read -r BUILD_BASE BUILD <<EOF
$(cat "$BUILD_FILE")
EOF
  BUILD=${BUILD:-0}
fi

if [ "$BUILD_BASE" != "$BASE_VERSION" ]; then
  BUILD=0
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

echo "$BASE_VERSION $BUILD" > "$BUILD_FILE"

echo "Version updated in: $MANIFESTS"
