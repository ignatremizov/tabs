#!/bin/sh
# bump-version.sh: Bump SemVer patch and create a git tag
# Copyright (C) 2025 Selene ToyKeeper
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repository." >&2
  exit 1
fi

BASE_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
if [ -z "$BASE_VERSION" ]; then
  BASE_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || true)
fi

if [ -z "$BASE_VERSION" ]; then
  BASE_VERSION="0.0.0"
else
  BASE_VERSION=$(echo "$BASE_VERSION" | sed 's/^v//')
fi

IFS='.' read -r MAJOR MINOR PATCH <<EOF
$BASE_VERSION
EOF

if [ -z "${MAJOR:-}" ] || [ -z "${MINOR:-}" ] || [ -z "${PATCH:-}" ]; then
  echo "Invalid tag format, expected MAJOR.MINOR.PATCH in git tag" >&2
  exit 1
fi

NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"
NEW_TAG="v${NEW_VERSION}"

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $NEW_TAG" >&2
  exit 1
fi

git tag "$NEW_TAG"
echo "$NEW_VERSION 0" > "$ROOT_DIR/VERSION_BUILD"

echo "Created tag: $NEW_TAG"
