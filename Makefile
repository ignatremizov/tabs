# Makefile: a very basic, uh, Makefile ... pretty self-explanatory
# Copyright (C) 2025 Selene ToyKeeper
# SPDX-License-Identifier: AGPL-3.0-or-later

all: firefox-zip chrome-zip

help:
	@echo "Available targets:"
	@echo "  all          - Build both Firefox and Chrome zip files"
	@echo "  firefox-zip  - Build Firefox extension zip file"
	@echo "  chrome-zip   - Build Chrome/Chromium extension zip file"
	@echo "  firefox-sign - Sign Firefox extension via AMO (requires .env JWT_ISSUER/JWT_SECRET)"
	@echo "  todo         - List TODO/FIXME comments in source files"
	@echo "  help         - Show this help message"

# make a zip file suitable for loading into
# about:debugging#/runtime/this-firefox -> Load Temporary Add-On
firefox-zip:
	./make-zip.sh firefox

chrome-zip:
	./make-zip.sh chromium

firefox-sign:
	./bin/sign-firefox.sh

todo:
	grep -1 -n -E 'TODO|FIXME' *.js */*.js */*.html */*.css | less -S

