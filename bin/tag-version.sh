#!/bin/sh
# tag-version.sh: bump or set SemVer tag and reset build counter
# Copyright (C) 2025 Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
. "$ROOT_DIR/bin/version-utils.sh"
ensure_git_repo

MODE=${1:-patch}
TAG_ARG=${2:-}

if [ -n "$TAG_ARG" ]; then
  INPUT_TAG="$TAG_ARG"
elif echo "$MODE" | grep -Eq '^[vV]?[0-9]+\.[0-9]+\.[0-9]+$'; then
  INPUT_TAG="$MODE"
  MODE=''
else
  INPUT_TAG=''
fi

if [ -n "$INPUT_TAG" ]; then
  if is_build_tag "$INPUT_TAG"; then
    echo "Invalid tag format: use vMAJOR.MINOR.PATCH (not vMAJOR.MINOR.PATCH.BUILD)." >&2
    exit 1
  fi
  VERSION=$(strip_v_prefix "$INPUT_TAG")
else
  BASE_VERSION=$(get_tag_version optional)
  if [ -z "$BASE_VERSION" ]; then
    BASE_VERSION="0.0.0"
  fi

  if ! validate_version "$BASE_VERSION"; then
    echo "Invalid tag format, expected MAJOR.MINOR.PATCH in git tag" >&2
    exit 1
  fi

  IFS=' ' read -r MAJOR MINOR PATCH <<EOF
$(split_version "$BASE_VERSION")
EOF

  case "$MODE" in
    major)
      MAJOR=$((MAJOR + 1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      MINOR=$((MINOR + 1))
      PATCH=0
      ;;
    patch|'')
      PATCH=$((PATCH + 1))
      ;;
    *)
      echo "Unknown mode: $MODE (use major|minor|patch or vX.Y.Z)" >&2
      exit 1
      ;;
  esac

  VERSION="${MAJOR}.${MINOR}.${PATCH}"
fi

if ! validate_version "$VERSION"; then
  echo "Invalid version part: $VERSION" >&2
  exit 1
fi

NEW_TAG="v${VERSION}"

if git rev-parse "$NEW_TAG" >/dev/null 2>&1; then
  echo "Tag already exists: $NEW_TAG" >&2
  exit 1
fi

git tag "$NEW_TAG"
echo "$VERSION 0" > "$ROOT_DIR/VERSION_BUILD"

echo "Created tag: $NEW_TAG"
