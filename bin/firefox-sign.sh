#!/bin/sh
# firefox-sign.sh: sign the Firefox extension via AMO using web-ext

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

# Load API credentials from .env if present.
# Expected variables:
#   JWT_ISSUER: AMO API key (JWT issuer)
#   JWT_SECRET: AMO API secret
if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

: "${JWT_ISSUER:?Missing JWT_ISSUER (AMO API Key) in environment or .env}"
: "${JWT_SECRET:?Missing JWT_SECRET (AMO API Secret) in environment or .env}"

CHANNEL=${WEB_EXT_CHANNEL:-unlisted}
TIMEOUT_MS=${WEB_EXT_TIMEOUT_MS:-900000}

# Build the Firefox bundle in ./build (manifest differs per browser)
make firefox-zip

# Prefer global web-ext if installed; otherwise fallback to npx.
if command -v web-ext >/dev/null 2>&1; then
  WEB_EXT=web-ext
else
  WEB_EXT="npx web-ext"
fi

# Sign the build/ directory and write the signed .xpi into dist/
# Note: web-ext will upload to AMO and return a signed artifact.
$WEB_EXT sign \
  --source-dir build \
  --artifacts-dir dist \
  --channel "$CHANNEL" \
  --api-key "$JWT_ISSUER" \
  --api-secret "$JWT_SECRET" \
  --timeout "$TIMEOUT_MS"
