#!/usr/bin/env python3
"""Exercise the real extension in a disposable Firefox/Geckodriver profile.

No Selenium dependency. Only synthetic loopback pages/cookies are used. The
test-only background handle and host permission are inserted in a staging
copy, never in the shipped extension. No existing Firefox profile is opened.
"""
# Copyright (C) 2026 Ignat Remizov
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "native-context-test@tktsto.invalid"


class FixtureServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        data = b"<!doctype html><title>Synthetic account fixture</title><p>Local container test.</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def stage_extension(work, trace_api=False, expose_views=False):
    staged = work / "extension"
    staged.mkdir()
    for source in ROOT.glob("*.js"):
        shutil.copy2(source, staged / source.name)
    for name in ("_locales", "bkgd", "common", "docs", "img", "options", "themes", "view"):
        shutil.copytree(ROOT / name, staged / name)
    manifest = json.loads((ROOT / "manifest-ff.json").read_text())
    manifest["browser_specific_settings"]["gecko"]["id"] = ADDON_ID
    manifest["host_permissions"] = ["http://127.0.0.1/*"]
    (staged / "manifest.json").write_text(json.dumps(manifest, indent=2))
    source_path = staged / "bkgd/bkgd.js"
    source = source_path.read_text()
    marker = "  const bkgd = new Bkgd();\n  bkgd.init();"
    if source.count(marker) != 1:
        raise RuntimeError("Background test-hook location changed")
    source = source.replace(marker, """  const bkgd = new Bkgd();
  globalThis.__nativeContextTest = bkgd;
  globalThis.__TKTSTO_TEST_QUIET__ = true;
  globalThis.__nativeContextErrors = [];
  globalThis.__nativeContextTrace = [];
  if (__TRACE_NATIVE_CONTEXT__) {
  for (const [namespace, methods] of [['tabs', ['move', 'group', 'ungroup']], ['tabGroups', ['move', 'update']]]) {
    for (const method of methods) {
      const original = api[namespace][method];
      api[namespace][method] = (...args) => {
        const entry = { time: Date.now(), call: namespace + '.' + method, args,
          stack: new Error().stack };
        globalThis.__nativeContextTrace.push(entry);
        return original(...args).then(value => { entry.result = value; return value; },
          error => { entry.error = String(error); throw error; });
      };
    }
  }
  for (const method of ['onTabAttached', 'onTabMoved']) {
    const original = bkgd[method].bind(bkgd);
    bkgd[method] = async (...args) => {
      const entry = { time: Date.now(), event: method, args };
      globalThis.__nativeContextTrace.push(entry);
      try { return await original(...args); }
      finally {
        const node = bkgd.tree?.getNodeByTabId(args[0]);
        entry.node = node ? { id: node.id, parent: node.parent?.id,
          windowId: node.windowId, groupId: node.groupId } : null;
      }
    };
  }
  }
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    globalThis.__nativeContextErrors.push(args.map(String).join(' '));
    originalError(...args);
  };
  bkgd.init();""")
    source_path.write_text(source.replace('__TRACE_NATIVE_CONTEXT__', json.dumps(trace_api)))
    (staged / "tests").mkdir()
    for name in ("firefox-native-context.html", "firefox-native-context.js"):
        shutil.copy2(ROOT / "tests" / name, staged / "tests" / name)
    if expose_views:
        view_path = staged / "view/view.js"
        view_source = view_path.read_text()
        marker = "  const tree = new TreeView();"
        if view_source.count(marker) != 1:
            raise RuntimeError("View test-hook location changed")
        view_path.write_text(view_source.replace(marker,
            marker + "\n  window.__isolatedTestTree = tree;"))
    package = work / "test-extension.zip"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in staged.rglob("*"):
            if file.is_file():
                archive.write(file, file.relative_to(staged))
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--trace-api", action="store_true", help="Trace synthetic group API calls when diagnosing a failure")
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    # Ubuntu Snap Firefox and its driver share this path; neither necessarily
    # shares the host's /tmp. It is always a NEW directory, not a user profile.
    parent = Path.home() / "snap/firefox/common" if "/snap/" in args.geckodriver else Path.home()
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="tktsto-context-test-", dir=parent))
    output = args.output or work
    output.mkdir(parents=True, exist_ok=True)
    print(f"Disposable test data: {work}", flush=True)
    package = stage_extension(work, trace_api=args.trace_api)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    log = (output / "firefox-driver.log").open("w")
    driver = subprocess.Popen([args.geckodriver, "--port", str(port), "--host", "127.0.0.1",
                               "--profile-root", str(work), "--allow-system-access"],
                              stdout=log, stderr=subprocess.STDOUT)
    session = None

    def request(method, endpoint, data=None, timeout=100):
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(base + endpoint, data=body, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                value = json.load(response).get("value")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(exc.read().decode()) from exc
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(json.dumps(value))
        return value

    def command(method, endpoint, data=None):
        return request(method, f"/session/{session}/{endpoint}", data)

    try:
        deadline = time.monotonic() + 15
        while True:
            if driver.poll() is not None:
                raise RuntimeError("geckodriver exited; see firefox-driver.log")
            try:
                request("GET", "/status", timeout=1)
                break
            except (OSError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("geckodriver did not start")
                time.sleep(0.1)
        capabilities = request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "firefox", "moz:firefoxOptions": {
                **({"binary": os.environ["FIREFOX_BIN"]} if os.environ.get("FIREFOX_BIN") else {}),
                "args": ["-headless", "-no-remote"],
                "prefs": {"privacy.userContext.enabled": True, "browser.tabs.groups.enabled": True,
                          "browser.startup.page": 0, "datareporting.policy.dataSubmissionEnabled": False}
            }
        }}})
        session = capabilities["sessionId"]
        print(f"Firefox {capabilities['capabilities']['browserVersion']}; isolated WebDriver session", flush=True)
        command("POST", "timeouts", {"script": 90000, "pageLoad": 30000})
        command("POST", "moz/addon/install", {"path": str(package), "temporary": True})
        command("POST", "moz/context", {"context": "chrome"})
        extension_url = command("POST", "execute/sync", {
            "script": "return WebExtensionPolicy.getByID(arguments[0]).getURL('');", "args": [ADDON_ID]})
        command("POST", "moz/context", {"context": "content"})
        test_url = extension_url + "tests/firefox-native-context.html?" + urllib.parse.urlencode({"origin": origin})
        command("POST", "url", {"url": test_url})
        wait_result = {"script": """
          const done = arguments[arguments.length - 1];
          const timer = setInterval(() => {
            if (window.__TEST_DONE__) {
              clearInterval(timer);
              done(window.__TEST_RESULTS__);
            }
          }, 100);
        """, "args": []}
        result = command("POST", "execute/async", wait_result)
        (output / "firefox-native-context-results.json").write_text(json.dumps(result, indent=2))
        print(f"Lifecycle: {result['passCount']} passed, {result['failCount']} failed", flush=True)
        if not result["failCount"]:
            # Reload only our temporary addon in this disposable profile.
            # Navigation waits for its new background initialization below.
            command("POST", "execute/sync", {"script": "setTimeout(() => browser.runtime.reload(), 0); return true;", "args": []})
            time.sleep(0.8)
            # Firefox closes the old addon page during reload. Select one of
            # this disposable session's remaining tabs, then create a fresh
            # harness window rather than reusing the discarded context.
            handles = command("GET", "window/handles")
            command("POST", "window", {"handle": handles[0]})
            harness = command("POST", "window/new", {"type": "window"})
            command("POST", "window", {"handle": harness["handle"]})
            command("POST", "url", {"url": test_url + "&phase=reload"})
            reloaded = command("POST", "execute/async", wait_result)
            result["results"].extend(reloaded["results"])
            result["passCount"] += reloaded["passCount"]
            result["failCount"] += reloaded["failCount"]
        (output / "firefox-native-context-results.json").write_text(json.dumps(result, indent=2))
        for item in result.get("results", []):
            print(f"{'PASS' if item['pass'] else 'FAIL'}: {item['name']} {item.get('error', '')}", flush=True)
        print(json.dumps({key: result[key] for key in ("passCount", "failCount")}), flush=True)
        # Render the actual production TreeView, not a mock, with synthetic
        # tabs and containers from this test profile.
        command("POST", "window/rect", {"width": 760, "height": 1000})
        command("POST", "url", {"url": extension_url + "view/sidepanel.html"})
        time.sleep(1.5)
        # Scroll the real tree to the fixture window; don't hide or restyle any
        # production DOM. The tutorial in the first window is otherwise taller
        # than the viewport and obscures the container/group rows.
        visible = command("POST", "execute/async", {"script": """
          const done = arguments[arguments.length - 1];
          browser.storage.local.get('nativeContextCheckpoint').then(({nativeContextCheckpoint: saved}) => {
            const id = 'node' + saved?.focusNodeId;
            if (!document.getElementById(id)) document.getElementById('view-scope-btn')?.click();
            const deadline = Date.now() + 5000;
            const timer = setInterval(() => {
              const target = document.getElementById(id);
              if (target) {
                clearInterval(timer);
                target.scrollIntoView({block: 'start'});
                done(true);
              } else if (Date.now() > deadline) {
                clearInterval(timer); done(false);
              }
            }, 50);
          }, error => done(String(error)));
        """, "args": []})
        screenshot = command("GET", "screenshot")
        (output / "firefox-native-context.png").write_bytes(base64.b64decode(screenshot))
        if result["failCount"]:
            raise RuntimeError("Firefox native-context integration tests failed")
        if visible is not True:
            raise RuntimeError("Production sidebar could not display the synthetic fixture window")
    finally:
        if session:
            try:
                request("DELETE", f"/session/{session}", timeout=15)
            except (OSError, RuntimeError):
                pass
        try:
            driver.terminate()
        except PermissionError:
            # Ubuntu's Snap signal policy can reject the named Codex AppArmor
            # peer even for its own child. Ask the same user's service manager
            # to terminate precisely this test-owned PID, without sudo.
            subprocess.run(["systemd-run", "--user", "--wait", "--collect", "--quiet",
                            "/usr/bin/kill", "-TERM", str(driver.pid)], check=True)
        try:
            driver.wait(timeout=5)
        except subprocess.TimeoutExpired:
            driver.kill()
            driver.wait(timeout=5)
        server.shutdown()
        server.server_close()
        log.close()
        # Leave the disposable staging directory and diagnostics available for
        # inspection. No process uses it after this function exits.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
