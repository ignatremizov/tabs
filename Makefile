# Makefile: a very basic, uh, Makefile ... pretty self-explanatory
# Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

.DEFAULT_GOAL := all

.PHONY: all help firefox-zip firefox-zip-current chrome-zip \
	chrome-zip-current chrome-dir chrome-dir-current firefox-sign firefox-sign-current tag test test-node todo \
	coverage test-firefox-context test-firefox-recovery test-firefox-restart test-firefox-presentation test-firefox-convergence test-release release-current bump-version v

ifneq ($(filter v,$(MAKECMDGOALS)),)
VERBOSE=1
MAKECMDGOALS := $(filter-out v,$(MAKECMDGOALS))
endif

v:
	@:

ARTIFACTS_DIR ?= $(CURDIR)/dist
export ARTIFACTS_DIR
CHROMIUM_DIR ?= $(ARTIFACTS_DIR)/chromium

# Signing owns its bump/build sequence. Do not race it with another version
# selection in a multi-goal (possibly parallel) make invocation.
ifneq ($(filter firefox-sign,$(MAKECMDGOALS)),)
ifneq ($(filter all firefox-zip chrome-zip chrome-dir bump-version firefox-sign-current,$(MAKECMDGOALS)),)
$(error Run firefox-sign separately; it increments, builds, and signs once)
endif
endif

all: bump-version
	./make-zip.sh firefox
	./make-zip.sh chromium

# One shared prerequisite means a paired/parallel browser build increments once.
bump-version:
	./bin/update-version.sh

release-current:
	python3 -B bin/release.py build --browser firefox --output "$(ARTIFACTS_DIR)"
	python3 -B bin/release.py build --browser chromium --output "$(ARTIFACTS_DIR)"

test-release:
	PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -p test_release.py -v

help:
	@echo "Available targets:"
	@echo "  all          - Increment once and build both browser ZIPs (default)"
	@echo "  firefox-zip  - Increment the build number and build Firefox"
	@echo "  firefox-zip-current - Build Firefox zip with current manifest version"
	@echo "  chrome-zip   - Increment the build number and build Chromium"
	@echo "  chrome-zip-current - Build Chromium zip with current manifest version"
	@echo "  chrome-dir   - Increment, build, and extract into a NEW CHROMIUM_DIR"
	@echo "  chrome-dir-current - Extract current version without incrementing"
	@echo "  firefox-sign - Increment once, build, and sign the new Firefox version"
	@echo "  firefox-sign-current - Sign a prebuilt current version without incrementing"
	@echo "  SIGN_ARGS=--verify-only - Collect an existing submission without uploading"
	@echo "  bump-version - Explicitly increment the build counter in both manifests"
	@echo "  release-current - Build clean committed source without version changes"
	@echo "  test-release - Synthetic signing and packaging safety tests (no AMO)"
	@echo "  tag          - Bump version tag (default: patch) or set a tag"
	@echo "  test         - Open unit tests in browser"
	@echo "  test-node    - Run node-based tests only"
	@echo "  test-firefox-context - Native container/group tests in a disposable Firefox profile"
	@echo "  test-firefox-recovery - Corrupt-startup warning and lossless raw export test"
	@echo "  test-firefox-restart - Two Firefox processes using the same NEW test profile"
	@echo "  test-firefox-convergence - Two real views, lost/delayed updates, and failed-write retry"
	@echo "  test-firefox-presentation - Firefox DOM and archive-rendering cost checks"
	@echo "  todo         - List TODO/FIXME comments in source files"
	@echo "  coverage     - Run node-based tests with V8 coverage"
	@echo "  help         - Show this help message"

# make a zip file suitable for loading into
# about:debugging#/runtime/this-firefox -> Load Temporary Add-On
firefox-zip: bump-version
	./make-zip.sh firefox

firefox-zip-current:
	./make-zip.sh firefox

chrome-zip: bump-version
	./make-zip.sh chromium

chrome-zip-current:
	./make-zip.sh chromium

chrome-dir: chrome-zip
	@version=$$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])'); \
	python3 -B bin/release.py unpack --unsigned "$(ARTIFACTS_DIR)/ignatremizov-tabs-$$version-chromium.zip" --output "$(CHROMIUM_DIR)"

chrome-dir-current: chrome-zip-current
	@version=$$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])'); \
	python3 -B bin/release.py unpack --unsigned "$(ARTIFACTS_DIR)/ignatremizov-tabs-$$version-chromium.zip" --output "$(CHROMIUM_DIR)"

firefox-sign:
	./bin/firefox-sign.sh $(SIGN_ARGS)

firefox-sign-current:
	./bin/firefox-sign.sh --current $(SIGN_ARGS)

tag:
	./bin/tag-version.sh $(TAG_ARGS)

# Allow: make tag [major|minor|patch] [vX.Y.Z]
ifeq (tag,$(firstword $(MAKECMDGOALS)))
  TAG_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  $(foreach arg,$(TAG_ARGS),$(eval $(arg):;@:))
endif

# Open unit tests in browser
NODE_TEST_CMD = TKTSTO_TEST_VERBOSE=$(if $(filter 1 true yes,$(VERBOSE) $(V)),1,) node --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./tests/node/loader.mjs", pathToFileURL("./"));' ./tests/node/run-tests.mjs

test-node:
	@echo "Running node-based tests..."
	@$(NODE_TEST_CMD)

test-firefox-context:
	@python3 tests/firefox-native-context.py

# Explicit output path keeps recovery diagnostics in a disposable directory.
test-firefox-recovery:
	@PYTHONDONTWRITEBYTECODE=1 python3 -B tests/firefox-recovery.py --output "$$(mktemp -d /tmp/tabs-recovery-results-XXXXXX)"

test-firefox-restart:
	@PYTHONDONTWRITEBYTECODE=1 python3 -B tests/firefox-restart.py --output "$$(mktemp -d /tmp/tabs-restart-results-XXXXXX)"

test-firefox-presentation:
	@PYTHONDONTWRITEBYTECODE=1 python3 -B tests/firefox-presentation.py --output "$$(mktemp -d /tmp/tabs-presentation-results-XXXXXX)"

test-firefox-convergence:
	@PYTHONDONTWRITEBYTECODE=1 python3 -B tests/firefox-convergence.py --output "$$(mktemp -d /tmp/tabs-convergence-results-XXXXXX)"

test:
	@echo "Running node-based tests..."
	@$(NODE_TEST_CMD)
	@echo "Starting local test server at http://127.0.0.1:8765 ..."
	@python3 -m http.server 8765 --directory . >/dev/null 2>&1 & echo $$! > /tmp/tktsto-test-server.pid
	@sleep 0.5
	@echo "Opening tests in browser..."
	@open http://127.0.0.1:8765/tests/dom-safety.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/dom-safety.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/dom-safety.test.html manually"
	@open http://127.0.0.1:8765/tests/tree-node.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/tree-node.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/tree-node.test.html manually"
	@open http://127.0.0.1:8765/tests/client-id-flow.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/client-id-flow.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/client-id-flow.test.html manually"
	@open http://127.0.0.1:8765/tests/merge-open-windows.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/merge-open-windows.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/merge-open-windows.test.html manually"
	@open http://127.0.0.1:8765/tests/treeview-actions.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/treeview-actions.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/treeview-actions.test.html manually"
	@echo "Firefox-specific run: http://127.0.0.1:8765/tests/tree-node.test.html?env=firefox"
	@echo "Chrome-specific run: http://127.0.0.1:8765/tests/tree-node.test.html?env=chrome"
	@echo "Merge test (firefox): http://127.0.0.1:8765/tests/merge-open-windows.test.html?env=firefox"
	@echo "Merge test (chrome): http://127.0.0.1:8765/tests/merge-open-windows.test.html?env=chrome"
	@echo "TreeView action tests (firefox): http://127.0.0.1:8765/tests/treeview-actions.test.html?env=firefox"
	@echo "TreeView action tests (chrome): http://127.0.0.1:8765/tests/treeview-actions.test.html?env=chrome"

coverage:
	@COVERAGE_BADGE_PATH=readme.md node tests/node/coverage.mjs
	@echo "Stop server with: kill $$(cat /tmp/tktsto-test-server.pid)"

todo:
	grep -1 -n -E 'TODO|FIXME' *.js */*.js */*.html */*.css | less -S
