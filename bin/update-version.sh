#!/bin/sh
# update-version.sh: Update version in manifests with SemVer + build counter
# Copyright (C) 2025 Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT_DIR/bin/version-utils.sh"
ensure_git_repo

# Cross-browser version format (Chrome + Firefox):
#   MAJOR.MINOR.PATCH.BUILD
# - 4 numeric parts, each <= 65535 (Chrome limit)
# - no leading zeros in non-zero parts
# - BUILD increments on each release build for fast deploys
BUILD_FILE="$ROOT_DIR/VERSION_BUILD"

BASE_VERSION=$(get_tag_version required)
if ! validate_version "$BASE_VERSION"; then
  echo "Invalid tag format, expected MAJOR.MINOR.PATCH in git tag" >&2
  exit 1
fi

IFS=' ' read -r MAJOR MINOR PATCH <<EOF
$(split_version "$BASE_VERSION")
EOF

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
