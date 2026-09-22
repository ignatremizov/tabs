#!/bin/sh
# Normal signing increments once, then builds and signs that exact iteration.
# --current / --verify-only explicitly retain an existing build number.
# SPDX-License-Identifier: AGPL-3.0-or-later
set +x
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
# release.py parses the limited signing assignments in .env as data, never as
# shell code. Credentials stay in the child environment, not argv or output.
OUTPUT=${ARTIFACTS_DIR:-"$ROOT_DIR/dist"}
case "${1:-}" in
  --current) shift ;;
  --verify-only) ;; # Recovery is never a new build or external submission.
  '')
    if [ -n "${FIREFOX_ARCHIVE:-}" ]; then
      echo 'Use firefox-sign-current (or --current) to sign FIREFOX_ARCHIVE without another bump.' >&2
      exit 1
    fi
    exec python3 -B "$ROOT_DIR/bin/release.py" sign-next --source "$ROOT_DIR" --output "$OUTPUT"
    ;;
  -h|--help)
    echo 'Usage: firefox-sign.sh [--current] [--verify-only]'
    echo 'Default: increment once, build, and sign. Current/verification modes never increment.'
    exit 0
    ;;
  *) echo 'Usage: firefox-sign.sh [--current] [--verify-only]' >&2; exit 1 ;;
esac
VERSION=$(python3 -c 'import json; print(json.load(open("manifest-ff.json"))["version"])')
ARCHIVE=${FIREFOX_ARCHIVE:-"$OUTPUT/ignatremizov-tabs-$VERSION-firefox.zip"}
exec python3 -B "$ROOT_DIR/bin/release.py" sign --source "$ROOT_DIR" \
  --unsigned "$ARCHIVE" --output "$OUTPUT" --allow-version-bump "$@"
