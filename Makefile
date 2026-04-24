# Makefile: a very basic, uh, Makefile ... pretty self-explanatory
# Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

.PHONY: all help firefox-zip firefox-zip-current chrome-zip chrome-dir firefox-sign tag test test-node todo coverage v

ifneq ($(filter v,$(MAKECMDGOALS)),)
VERBOSE=1
MAKECMDGOALS := $(filter-out v,$(MAKECMDGOALS))
endif

v:
	@:

all: firefox-zip chrome-zip

help:
	@echo "Available targets:"
	@echo "  all          - Build both Firefox and Chrome zip files"
	@echo "  firefox-zip  - Build Firefox extension zip file"
	@echo "  firefox-zip-current - Build Firefox zip with current manifest version"
	@echo "  chrome-zip   - Build Chrome/Chromium extension zip file"
	@echo "  chrome-dir   - Create dist/chromium for Load Unpacked"
	@echo "  firefox-sign - Sign Firefox extension via AMO (requires .env JWT_ISSUER/JWT_SECRET)"
	@echo "  tag          - Bump version tag (default: patch) or set a tag"
	@echo "  test         - Open unit tests in browser"
	@echo "  test-node    - Run node-based tests only"
	@echo "  todo         - List TODO/FIXME comments in source files"
	@echo "  coverage     - Run node-based tests with V8 coverage"
	@echo "  help         - Show this help message"

# make a zip file suitable for loading into
# about:debugging#/runtime/this-firefox -> Load Temporary Add-On
firefox-zip:
	./bin/update-version.sh
	./make-zip.sh firefox

firefox-zip-current:
	./make-zip.sh firefox

chrome-zip:
	./bin/update-version.sh
	./make-zip.sh chromium

chrome-dir: chrome-zip
	rm -rf dist/chromium
	mkdir -p dist
	mv build dist/chromium

firefox-sign:
	./bin/firefox-sign.sh

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
