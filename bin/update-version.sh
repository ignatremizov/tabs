#!/bin/sh
# update-version.sh: Update version in manifest-ff.json with unique timestamp+hash

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MANIFEST="$ROOT_DIR/manifest-ff.json"

# Create a unique, monotonically increasing build number: YYMMHHMMS
# Firefox allows max 4 version parts, each up to 9 digits
# Format: 0.0.1.YYMMHHMMS where S = seconds/10 (10-second resolution)
# This is always increasing and readable: 2601143025 = Jan 2026, 14:30:2X

# Get date/time components
YY=$(date +%y)
MM=$(date +%m)
HH=$(date +%H)
MIN=$(date +%M)
SS=$(date +%S | sed 's/^0*//')
SS=${SS:-0}  # Handle empty string if SS was "00"

# Seconds divided by 10 (0-9 for each 10-second window)
S=$((SS / 10))

NEW_VERSION="0.0.1.${YY}${MM}${HH}${MIN}${S}"

echo "Updating version to: $NEW_VERSION"

# Update version in manifest-ff.json using sed
# Works on both macOS and Linux
if sed --version >/dev/null 2>&1; then
  # GNU sed
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"
else
  # BSD sed (macOS)
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"
fi

echo "Version updated in manifest-ff.json"
