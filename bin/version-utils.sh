#!/bin/sh
# version-utils.sh: shared helpers for version/tag scripts
# Copyright (C) 2025 Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not a git repository." >&2
    exit 1
  fi
}

strip_v_prefix() {
  local value="$1"
  value="${value#v}"
  value="${value#V}"
  echo "$value"
}

get_tag_version() {
  local required="${1:-optional}"
  local version
  version=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
  if [ -z "$version" ]; then
    version=$(git describe --tags --abbrev=0 2>/dev/null || true)
  fi
  version=$(strip_v_prefix "$version")

  if [ -z "$version" ] && [ "$required" = "required" ]; then
    echo "No git tag found. Create a tag like v0.0.2 for the base version." >&2
    exit 1
  fi

  echo "$version"
}

validate_part() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$1" -gt 65535 ] 2>/dev/null; then
    return 1
  fi
  if [ "$1" != "0" ] && [ "${1#0}" != "$1" ]; then
    return 1
  fi
  return 0
}

split_version() {
  local version="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<EOF
$version
EOF
  echo "$major $minor $patch"
}

validate_version() {
  local version="$1"
  local major minor patch
  IFS=' ' read -r major minor patch <<EOF
$(split_version "$version")
EOF
  if [ -z "${major:-}" ] || [ -z "${minor:-}" ] || [ -z "${patch:-}" ]; then
    return 1
  fi
  for part in "$major" "$minor" "$patch"; do
    if ! validate_part "$part"; then
      return 1
    fi
  done
  return 0
}
