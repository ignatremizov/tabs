#!/bin/sh
# webdriver.sh: manage and query a local Firefox WebDriver session
# Copyright (C) 2026 Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GIT_DIR=$(git -C "$ROOT_DIR" rev-parse --absolute-git-dir)
STATE_FILE=${WEBDRIVER_STATE_FILE:-"$GIT_DIR/webdriver-session.json"}
URL_OVERRIDE=${WEBDRIVER_URL:-}
DEFAULT_URL=http://127.0.0.1:4444

usage() {
  cat <<'EOF'
Usage:
  bin/webdriver.sh start [CAPABILITIES_JSON|-]
  bin/webdriver.sh use SESSION_ID [URL]
  bin/webdriver.sh stop
  bin/webdriver.sh METHOD ENDPOINT [JSON|-]

The active URL and session ID are kept in .git/webdriver-session.json.  Use
"-" as a JSON argument to read the request body from stdin.

Environment:
  WEBDRIVER_URL         Server URL for start/use, or an override
  WEBDRIVER_SESSION_ID  Session override
  WEBDRIVER_STATE_FILE  Alternate state file

Examples:
  geckodriver --port 4444
  bin/webdriver.sh start
  bin/webdriver.sh GET window
  bin/webdriver.sh POST execute/sync \
    '{"script":"return location.href;","args":[]}'
  jq -n --arg script "$script" '{script:$script,args:[]}' |
    bin/webdriver.sh POST execute/async -
  bin/webdriver.sh stop
EOF
}

read_body() {
  DEFAULT_BODY=$1
  GIVEN_BODY=${2:-$DEFAULT_BODY}
  if [ "$GIVEN_BODY" = "-" ]; then
    cat
  else
    printf '%s' "$GIVEN_BODY"
  fi
}

save_state() {
  SAVED_URL=$1
  SAVED_SESSION_ID=$2
  jq -n \
    --arg url "$SAVED_URL" \
    --arg sessionId "$SAVED_SESSION_ID" \
    '{url:$url, sessionId:$sessionId}' > "$STATE_FILE"
}

load_state() {
  WEBDRIVER_URL=${URL_OVERRIDE:-}
  SESSION_ID=${WEBDRIVER_SESSION_ID:-}
  if [ -z "$SESSION_ID" ] && [ -f "$STATE_FILE" ]; then
    SESSION_ID=$(jq -er '.sessionId' "$STATE_FILE")
    if [ -z "$WEBDRIVER_URL" ]; then
      WEBDRIVER_URL=$(jq -er '.url' "$STATE_FILE")
    fi
  fi
  WEBDRIVER_URL=${WEBDRIVER_URL:-$DEFAULT_URL}
  WEBDRIVER_URL=${WEBDRIVER_URL%/}
  if [ -z "$SESSION_ID" ]; then
    echo "No WebDriver session configured." >&2
    echo "Run 'bin/webdriver.sh start' or 'bin/webdriver.sh use SESSION_ID'." >&2
    exit 1
  fi
}

COMMAND=${1:-}
case "$COMMAND" in
  -h|--help|'')
    usage
    exit 0
    ;;
  start)
    WEBDRIVER_URL=${URL_OVERRIDE:-$DEFAULT_URL}
    WEBDRIVER_URL=${WEBDRIVER_URL%/}
    DEFAULT_CAPABILITIES='{"capabilities":{"alwaysMatch":{"browserName":"firefox","moz:firefoxOptions":{"args":["-headless","-remote-allow-system-access"]}}}}'
    BODY=$(read_body "$DEFAULT_CAPABILITIES" "${2:-}")
    RESPONSE=$(curl -fsS -X POST \
      -H 'Content-Type: application/json' \
      --data-binary "$BODY" \
      "$WEBDRIVER_URL/session")
    SESSION_ID=$(printf '%s' "$RESPONSE" | jq -er '.value.sessionId')
    save_state "$WEBDRIVER_URL" "$SESSION_ID"
    printf '%s\n' "$RESPONSE"
    exit 0
    ;;
  use)
    if [ "$#" -lt 2 ]; then
      echo "Usage: bin/webdriver.sh use SESSION_ID [URL]" >&2
      exit 2
    fi
    SESSION_ID=$2
    WEBDRIVER_URL=${3:-${URL_OVERRIDE:-$DEFAULT_URL}}
    WEBDRIVER_URL=${WEBDRIVER_URL%/}
    save_state "$WEBDRIVER_URL" "$SESSION_ID"
    printf '%s\n' "$STATE_FILE"
    exit 0
    ;;
  stop)
    load_state
    curl -fsS -X DELETE \
      "$WEBDRIVER_URL/session/$SESSION_ID"
    rm -f "$STATE_FILE"
    exit 0
    ;;
esac

if [ "$#" -lt 2 ]; then
  usage >&2
  exit 2
fi

METHOD=$(printf '%s' "$COMMAND" | tr '[:lower:]' '[:upper:]')
ENDPOINT=${2#/}
load_state

case "$METHOD" in
  GET|POST|PUT|DELETE) ;;
  *)
    echo "Unsupported method: $METHOD" >&2
    exit 2
    ;;
esac

URL="$WEBDRIVER_URL/session/$SESSION_ID"
if [ -n "$ENDPOINT" ]; then
  URL="$URL/$ENDPOINT"
fi

case "$METHOD" in
  GET|DELETE)
    curl -fsS -X "$METHOD" "$URL"
    ;;
  POST|PUT)
    BODY=$(read_body '{}' "${3:-}")
    curl -fsS -X "$METHOD" \
      -H 'Content-Type: application/json' \
      --data-binary "$BODY" \
      "$URL"
    ;;
esac
