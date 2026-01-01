#!/bin/sh
# make-zip.sh: make the extension .zip file for browsers to load
# Copyright (C) 2025 Selene ToyKeeper
# SPDX-License-Identifier: AGPL-3.0-or-later

BROWSER=${1:-chromium}
PROGRAM="ignatremizov-tabs"

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
for f in LICENSE LICENSE.* Makefile *.js *.md *.html make-zip.sh ; do
  [ -e "$f" ] && cp -v "$f" build
done

# manifest differs per browser
if [ 'firefox' = "$BROWSER" ]; then
  cp -v manifest-ff.json build/manifest.json
else
  cp -v manifest.json build/manifest.json
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

