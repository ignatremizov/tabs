#!/bin/sh
# make-zip.sh: make the extension .zip file for browsers to load
# Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

BROWSER=${1:-chromium}
PROGRAM="ignatremizov-tabs"

# Load optional build overrides from .env.
if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

# get version from the appropriate manifest file
if [ 'firefox' = "$BROWSER" ]; then
  VERSION=$(grep '"version"' manifest-ff.json | sed -rn 's/.*: "(.*)".*/\1/p')
else
  VERSION=$(grep '"version"' manifest.json | sed -rn 's/.*: "(.*)".*/\1/p')
fi

# clean the build area
mkdir -p build
rm -rf build/*

# copy root-level files
for f in LICENSE LICENSE.* Makefile *.js *.md *.html ; do
  [ -e "$f" ] && cp -v "$f" build
done

# manifest differs per browser
if [ 'firefox' = "$BROWSER" ]; then
  cp -v manifest-ff.json build/manifest.json
else
  cp -v manifest.json build/manifest.json
fi

# Apply optional overrides to the build manifest.
if [ -n "${EXT_NAME:-}" ]; then
  if sed --version >/dev/null 2>&1; then
    sed -i "s/\"name\": \"[^\"]*\"/\"name\": \"$EXT_NAME\"/" build/manifest.json
  else
    sed -i '' "s/\"name\": \"[^\"]*\"/\"name\": \"$EXT_NAME\"/" build/manifest.json
  fi
fi

if [ 'firefox' = "$BROWSER" ] && [ -n "${FF_EXT_ID:-}" ]; then
  if sed --version >/dev/null 2>&1; then
    sed -i "s/\"id\": \"[^\"]*\"/\"id\": \"$FF_EXT_ID\"/" build/manifest.json
  else
    sed -i '' "s/\"id\": \"[^\"]*\"/\"id\": \"$FF_EXT_ID\"/" build/manifest.json
  fi
fi

# copy subdirs
SUBDIRS="bkgd common docs img options themes view"
for d in $SUBDIRS ; do
  mkdir -p "build/$d"
  for ext in js html css md png ; do
    for f in "$d"/*.$ext ; do
      [ -e "$f" ] && cp "$f" "build/$d"
    done
  done
done

mkdir -p dist
cd build
ZIPFILE=../dist/"$PROGRAM"-"$VERSION"-"$BROWSER".zip
rm -f "$ZIPFILE"
zip -r "$ZIPFILE" *
