"""Small WebDriver helper restricted to newly created, marked test workspaces."""
# SPDX-License-Identifier: AGPL-3.0-or-later
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


MARKER = ".disposable-tabs-test"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def new_workspace(geckodriver):
    parent = Path.home() / "snap/firefox/common" if "/snap/" in str(geckodriver) else Path(tempfile.gettempdir())
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="tabs-isolated-test-", dir=parent))
    (work / MARKER).write_text("disposable test profile; no user data\n")
    return work


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except PermissionError:
        subprocess.run(["systemd-run", "--user", "--wait", "--collect", "--quiet",
                        "/usr/bin/kill", "-TERM", str(process.pid)], check=True)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except PermissionError:
            subprocess.run(["systemd-run", "--user", "--wait", "--collect", "--quiet",
                            "/usr/bin/kill", "-KILL", str(process.pid)], check=True)
        process.wait(timeout=8)


class FirefoxSession:
    def __init__(self, geckodriver, work, output, *, profile=None, prefs=None, firefox=None):
        self.geckodriver = str(geckodriver)
        self.work = Path(work).resolve()
        if not (self.work / MARKER).is_file():
            raise ValueError("Refusing an unmarked/non-test Firefox workspace")
        self.profile = Path(profile).resolve() if profile else None
        if self.profile and not self.profile.is_relative_to(self.work):
            raise ValueError("Explicit profiles must be inside the disposable test workspace")
        (self.work / "downloads").mkdir(exist_ok=True)
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.prefs = dict(prefs or {})
        self.firefox = firefox or os.environ.get("FIREFOX_BIN")
        self.session = None
        self.process = None
        self.log = None
        self.base = f"http://127.0.0.1:{free_port()}"
        self.capabilities = {}

    def request(self, method, endpoint, data=None, timeout=90):
        req = urllib.request.Request(self.base + endpoint, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                value = json.load(response)["value"]
        except urllib.error.HTTPError as err:
            raise RuntimeError(err.read().decode()) from err
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(json.dumps(value))
        return value

    def command(self, method, endpoint, data=None):
        return self.request(method, f"/session/{self.session}/{endpoint}", data)

    def script(self, script, *args, asynchronous=False):
        return self.command("POST", "execute/async" if asynchronous else "execute/sync",
                            {"script": script, "args": list(args)})

    def addon_url(self, addon_id):
        self.command("POST", "moz/context", {"context": "chrome"})
        try:
            return self.script("return WebExtensionPolicy.getByID(arguments[0]).getURL('');", addon_id)
        finally:
            self.command("POST", "moz/context", {"context": "content"})

    def install(self, package, *, temporary=True):
        package = Path(package).resolve()
        staged = self.work / package.name
        if package != staged:
            shutil.copy2(package, staged)
        return self.command("POST", "moz/addon/install", {"path": str(staged), "temporary": temporary})

    def navigate(self, url):
        return self.command("POST", "url", {"url": url})

    def wait(self, script, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.script(script)
            if value:
                return value
            time.sleep(0.1)
        raise TimeoutError("Test condition did not become true")

    def screenshot(self, name):
        (self.output / name).write_bytes(base64.b64decode(self.command("GET", "screenshot")))

    def __enter__(self):
        try:
            self.log = (self.output / "geckodriver.log").open("x")
            args = [self.geckodriver, "--host", "127.0.0.1", "--port", self.base.rsplit(":", 1)[1],
                    "--profile-root", str(self.work), "--allow-system-access"]
            if self.profile:
                self.profile.mkdir(exist_ok=True)
                args += ["--marionette-port", str(free_port())]
            self.process = subprocess.Popen(args, stdout=self.log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 20
            while True:
                try:
                    self.request("GET", "/status", timeout=1)
                    break
                except OSError:
                    if self.process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Test geckodriver failed to start; see retained log")
                    time.sleep(0.1)
            options = {"args": ["-headless", "-no-remote"], "prefs": {
                "xpinstall.signatures.required": True,
                "privacy.userContext.enabled": True,
                "browser.tabs.groups.enabled": True,
                "datareporting.policy.dataSubmissionEnabled": False,
                "browser.shell.checkDefaultBrowser": False,
                "browser.download.folderList": 2,
                "browser.download.dir": str(self.work / "downloads"),
                "browser.download.useDownloadDir": True,
                **self.prefs}}
            if self.profile:
                options["args"] += ["-profile", str(self.profile)]
            if self.firefox:
                options["binary"] = self.firefox
            result = self.request("POST", "/session", {"capabilities": {"alwaysMatch": {
                "browserName": "firefox", "moz:firefoxOptions": options}}})
            self.session = result["sessionId"]
            self.capabilities = result["capabilities"]
            self.command("POST", "timeouts", {"script": 30000, "pageLoad": 30000})
            self.command("POST", "window/rect", {"width": 850, "height": 900})
            return self
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.session:
            try:
                self.request("DELETE", f"/session/{self.session}", timeout=15)
            except (OSError, RuntimeError):
                pass
            self.session = None
        try:
            stop_process(self.process)
        finally:
            if self.log:
                self.log.close()
                self.log = None

    def __exit__(self, *_args):
        self.close()
