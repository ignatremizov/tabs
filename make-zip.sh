#!/bin/sh
# Package exactly the current version. Development builds still require staged
# package files; existing different archives are never overwritten.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BROWSER=${1:-chromium}
exec python3 -B "$ROOT_DIR/bin/release.py" build --source "$ROOT_DIR" \
  --browser "$BROWSER" --output "${ARTIFACTS_DIR:-$ROOT_DIR/dist}" --allow-dirty
