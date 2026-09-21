#!/bin/sh
# Sign a prebuilt exact-version Firefox archive; never bump or rebuild here.
# SPDX-License-Identifier: AGPL-3.0-or-later
set +x
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
# release.py parses the limited signing assignments in .env as data, never as
# shell code. Credentials stay in the child environment, not argv or output.
VERSION=$(python3 -c 'import json; print(json.load(open("manifest-ff.json"))["version"])')
ARCHIVE=${FIREFOX_ARCHIVE:-"$ROOT_DIR/dist/ignatremizov-tabs-$VERSION-firefox.zip"}
exec python3 -B "$ROOT_DIR/bin/release.py" sign --source "$ROOT_DIR" \
  --unsigned "$ARCHIVE" --output "${ARTIFACTS_DIR:-$ROOT_DIR/dist}" "$@"
