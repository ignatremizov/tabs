#!/usr/bin/env python3
"""Verify actual failed-startup UI and lossless recovery export in a new profile."""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import time

from firefox_driver import FirefoxSession, new_workspace

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    spec = importlib.util.spec_from_file_location("native_stage", ROOT / "tests/firefox-native-context.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    work = new_workspace(args.geckodriver)
    package = native.stage_extension(work)
    with FirefoxSession(args.geckodriver, work, args.output) as browser:
        addon_id = browser.install(package)
        url = browser.addon_url(addon_id) + "view/sidepanel.html"
        browser.navigate(url)
        browser.wait("return document.querySelector('.row') !== null;")
        expected = browser.script("""
          const done = arguments[arguments.length - 1];
          (async () => {
            const bg = await browser.runtime.getBackgroundPage();
            const app = bg.__nativeContextTest;
            await app.treeLoaded;
            // Hold only this disposable addon's mutation streams while writing
            // a synthetic cycle. Runtime reload destroys both locks afterwards.
            await app.tree.onMessageMutex.lock();
            await app.browserMutationMutex.lock();
            const database = await app.tree.db.db;
            const records = await app.tree.db.loadRawRecords();
            const root = records.find(record => record.key === 'root');
            const data = JSON.parse(root.value.data);
            data.nodes.push('root');
            root.value.data = JSON.stringify(data);
            await new Promise((resolve, reject) => {
              const transaction = database.transaction('Nodes', 'readwrite');
              transaction.objectStore('Nodes').put(root.value);
              transaction.oncomplete = resolve;
              transaction.onerror = () => reject(transaction.error);
            });
            return records;
          })().then(done, err => done({error: String(err)}));
        """, asynchronous=True)
        old_handle = browser.command("GET", "window")
        harness = browser.command("POST", "window/new", {"type": "tab"})["handle"]
        browser.command("POST", "window", {"handle": old_handle})
        browser.script("setTimeout(() => browser.runtime.reload(), 0); return true;")
        time.sleep(0.6)
        browser.command("POST", "window", {"handle": harness})
        browser.navigate(url)
        browser.wait("return document.getElementById('startup-warning') && !document.getElementById('startup-warning').classList.contains('hidden');")
        result = browser.script("""
          const done = arguments[arguments.length - 1];
          (async () => {
            const state = await browser.runtime.sendMessage({msg: 'bkgd_getStartupState'});
            const started = Date.now();
            const rejected = await browser.runtime.sendMessage({msg: 'bkgd_getTree'});
            const recovery = await browser.runtime.sendMessage({msg: 'bkgd_getRecoveryData'});
            return {state, requestRejected: Boolean(rejected.error), requestMs: Date.now() - started,
              data: JSON.parse(recovery.data), text: document.getElementById('startup-error-text').textContent,
              exportEnabled: !document.getElementById('export-recovery').disabled};
          })().then(done, err => done({error: String(err)}));
        """, asynchronous=True)
        assert result["state"]["failure"] and result["state"]["canExport"], result
        assert result["requestRejected"] and result["requestMs"] < 5000, result
        assert result["exportEnabled"], result
        assert result["data"]["records"] == expected, "Failed startup changed original stored records"
        browser.screenshot("recovery-warning.png")
        # Exercise the real export button; downloads are confined to work/downloads.
        browser.script("document.getElementById('export-recovery').click(); return true;")
        browser.wait("return document.getElementById('status-text').textContent.startsWith('Saved ');", timeout=30)
        files = list((work / "downloads").glob("tktsto-recovery.*.json"))
        assert len(files) == 1, "Recovery export did not create exactly one test-local file"
        exported = json.loads(files[0].read_text())
        assert exported["records"] == expected, "Downloaded recovery data was not lossless"
        report = {"firefox": browser.capabilities["browserVersion"], "workspace": str(work),
                  "rawRecordsPreserved": len(expected), "startupRejectedPromptly": True,
                  "visibleRecoveryWarning": True, "realRecoveryDownloadVerified": True, "passed": True}
        (args.output / "results.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
