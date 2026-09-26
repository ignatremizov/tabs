#!/usr/bin/env python3
"""Run production-DOM fixtures and rendering-cost checks in isolated Firefox."""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import functools
import http.server
import json
from pathlib import Path
import shutil
import threading
import urllib.parse

from firefox_driver import FirefoxSession, new_workspace

ROOT = Path(__file__).resolve().parents[1]


class FixtureServer(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if any(part.startswith(".") for part in path.split("/")) or Path(path).suffix not in (
            ".js", ".mjs", ".html", ".css", ".png", ".svg"
        ):
            self.send_error(404)
            return
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    work = new_workspace(args.geckodriver)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(FixtureServer, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = {}
    try:
        with FirefoxSession(args.geckodriver, work, args.output) as browser:
            for page in ("native-context-view", "render-cost", "deletion-storage", "deletion-view"):
                browser.navigate(f"http://127.0.0.1:{server.server_port}/tests/{page}.test.html")
                browser.wait("return window.__TEST_DONE__;", timeout=45)
                result = browser.script("return window.__TEST_RESULTS__;")
                results[page] = result
                browser.screenshot(f"{page}.png")
                if page == "render-cost":
                    results["renderMetrics"] = browser.script("return window.__RENDER_METRICS__;")
                print(f"{page}: {result['passCount']} passed, {result['failCount']} failed", flush=True)
            (args.output / "results.json").write_text(json.dumps(results, indent=2))
            assert all(results[page]["failCount"] == 0 for page in ("native-context-view", "render-cost", "deletion-storage", "deletion-view")), results
            print(json.dumps(results["renderMetrics"], indent=2))
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
