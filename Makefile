# Makefile: a very basic, uh, Makefile ... pretty self-explanatory
# Copyright (C) 2025 Selene ToyKeeper
# SPDX-License-Identifier: AGPL-3.0-or-later

.PHONY: all help firefox-zip chrome-zip firefox-sign test todo coverage

all: firefox-zip chrome-zip

help:
	@echo "Available targets:"
	@echo "  all          - Build both Firefox and Chrome zip files"
	@echo "  firefox-zip  - Build Firefox extension zip file"
	@echo "  chrome-zip   - Build Chrome/Chromium extension zip file"
	@echo "  firefox-sign - Sign Firefox extension via AMO (requires .env JWT_ISSUER/JWT_SECRET)"
	@echo "  test         - Open unit tests in browser"
	@echo "  todo         - List TODO/FIXME comments in source files"
	@echo "  coverage     - Run node-based tests with V8 coverage"
	@echo "  help         - Show this help message"

# make a zip file suitable for loading into
# about:debugging#/runtime/this-firefox -> Load Temporary Add-On
firefox-zip:
	./bin/update-version.sh
	./make-zip.sh firefox

chrome-zip:
	./make-zip.sh chromium

firefox-sign:
	./bin/update-version.sh
	./bin/sign-firefox.sh

# Open unit tests in browser
test:
	@echo "Starting local test server at http://127.0.0.1:8765 ..."
	@python3 -m http.server 8765 --directory . >/dev/null 2>&1 & echo $$! > /tmp/tktsto-test-server.pid
	@sleep 0.5
	@echo "Opening tests in browser..."
	@open http://127.0.0.1:8765/tests/dom-safety.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/dom-safety.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/dom-safety.test.html manually"
	@open http://127.0.0.1:8765/tests/tree-node.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/tree-node.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/tree-node.test.html manually"
	@open http://127.0.0.1:8765/tests/merge-open-windows.test.html 2>/dev/null || xdg-open http://127.0.0.1:8765/tests/merge-open-windows.test.html 2>/dev/null || echo "Please open http://127.0.0.1:8765/tests/merge-open-windows.test.html manually"
	@echo "Firefox-specific run: http://127.0.0.1:8765/tests/tree-node.test.html?env=firefox"
	@echo "Chrome-specific run: http://127.0.0.1:8765/tests/tree-node.test.html?env=chrome"
	@echo "Merge test (firefox): http://127.0.0.1:8765/tests/merge-open-windows.test.html?env=firefox"
	@echo "Merge test (chrome): http://127.0.0.1:8765/tests/merge-open-windows.test.html?env=chrome"

coverage:
	@COVERAGE_BADGE_PATH=readme.md node tests/node/coverage.mjs
	@echo "Stop server with: kill $$(cat /tmp/tktsto-test-server.pid)"

todo:
	grep -1 -n -E 'TODO|FIXME' *.js */*.js */*.html */*.css | less -S
