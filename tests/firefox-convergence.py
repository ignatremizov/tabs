#!/usr/bin/env python3
"""Exercise two actual production TreeViews with dropped updates and delayed reads."""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import http.server
import importlib.util
import json
from pathlib import Path
import shutil
import threading

from firefox_driver import FirefoxSession, new_workspace

ROOT = Path(__file__).resolve().parents[1]


class TitleFixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        title = "Latest title" if self.path == "/latest" else "Repaired title" if self.path == "/repaired" else "Original title"
        body = f"<!doctype html><title>{title}</title><p>Synthetic view convergence</p>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    spec = importlib.util.spec_from_file_location("convergence_stage", ROOT / "tests/firefox-native-context.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    work = new_workspace(args.geckodriver)
    package = native.stage_extension(work, expose_views=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TitleFixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with FirefoxSession(args.geckodriver, work, args.output) as driver:
            addon_id = driver.install(package)
            url = driver.addon_url(addon_id) + "view/sidepanel.html"
            driver.navigate(url)
            ready = "return window.__isolatedTestTree && document.querySelector('.row') !== null;"
            driver.wait(ready)
            first = driver.command("GET", "window")
            second = driver.command("POST", "window/new", {"type": "tab"})["handle"]
            driver.command("POST", "window", {"handle": second})
            driver.navigate(url)
            driver.wait(ready)
            fixture = driver.script("""
              const done = arguments[arguments.length - 1], origin = arguments[0];
              (async () => {
                const tab = await browser.tabs.create({url: origin + '/original', active: false});
                const app = (await browser.runtime.getBackgroundPage()).__nativeContextTest;
                const until = Date.now() + 10000;
                while (Date.now() < until) {
                  const node = app.tree.getNodeByTabId(tab.id);
                  if (node?.title === 'Original title') return {nodeId: node.id, tabId: tab.id};
                  await new Promise(resolve => setTimeout(resolve, 50));
                }
                throw new Error('Synthetic tab did not attach');
              })().then(done, err => done({error: String(err)}));
            """, origin, asynchronous=True)
            node_id, tab_id = fixture["nodeId"], fixture["tabId"]
            for handle in (first, second):
                driver.command("POST", "window", {"handle": handle})
                driver.script("""
                  window.__fixtureNodeId = arguments[0];
                  const tree = window.__isolatedTestTree;
                  tree.viewScope = 'session'; tree.$renderWholeTree();
                """, node_id)
                driver.wait("return window.__isolatedTestTree.nodes[window.__fixtureNodeId]?.title === 'Original title';")
            driver.command("POST", "window", {"handle": first})
            state = driver.script("""
              const done = arguments[arguments.length - 1];
              (async () => {
                const tree = window.__isolatedTestTree;
                await tree.setCursor(tree.nodes[window.__fixtureNodeId], {scroll:false});
                tree.$.scrollTop = 120;
                window.__scrollTrace = [];
                const capture = tree.capturePresentationState.bind(tree);
                tree.capturePresentationState = () => {
                  const state = capture();
                  window.__scrollTrace.push({phase:'capture', state,
                    stack: new Error().stack});
                  return state;
                };
                const restore = tree.restorePresentationScroll.bind(tree);
                tree.restorePresentationScroll = state => {
                  restore(state);
                  window.__scrollTrace.push({phase:'restored', state, actual:tree.$.scrollTop});
                };
                const original = tree.onMessage.bind(tree);
                window.__skipFixtureUpdates = true;
                tree.onMessage = msg => window.__skipFixtureUpdates && msg.nodeId === window.__fixtureNodeId
                  && msg.msg === 'tree_nodeChanged' ? Promise.resolve() : original(msg);
                return {cursor: tree.cursor.id, scroll: tree.$.scrollTop};
              })().then(done, err => done({error: String(err)}));
            """, asynchronous=True)
            driver.command("POST", "window", {"handle": second})
            driver.script("return browser.tabs.update(arguments[0], {url: arguments[1] + '/repaired'});", tab_id, origin)
            driver.wait("return window.__isolatedTestTree.nodes[window.__fixtureNodeId]?.title === 'Repaired title';")
            driver.command("POST", "window", {"handle": first})
            assert driver.script("return window.__isolatedTestTree.nodes[window.__fixtureNodeId].title;") == "Original title"
            driver.command("POST", "window", {"handle": second})
            saved_id = driver.script("""
              const done = arguments[arguments.length - 1];
              (async () => {
                const app = (await browser.runtime.getBackgroundPage()).__nativeContextTest;
                const note = await app.tree.root.addChild(app.tree.root.nodes.length,
                  {label: 'Recovered structure', note: 'Synthetic missing structural event'}, {reason: 'test'});
                // Make the native browser snapshot discover a repair. The
                // normal event was deliberately lost only by the first view.
                app.tree.nodes[window.__fixtureNodeId].title = 'Before recovery';
                await app.onAlarm({name: app.reconcileAlarmName});
                return note.id;
              })().then(done, err => done({error: String(err)}));
            """, asynchronous=True)
            for handle in (first, second):
                driver.command("POST", "window", {"handle": handle})
                driver.script("window.__savedFixtureId = arguments[0];", saved_id)
                driver.wait("return window.__isolatedTestTree.nodes[window.__fixtureNodeId]?.title === 'Repaired title' && document.getElementById('node' + window.__savedFixtureId)?.textContent.includes('Recovered structure');")
            driver.command("POST", "window", {"handle": first})
            after = driver.script("const tree=window.__isolatedTestTree; return {cursor:tree.cursor.id,scroll:tree.$.scrollTop};")
            trace = driver.script("return window.__scrollTrace;")
            (args.output / "scroll-trace.json").write_text(json.dumps({"before":state,"after":after,"trace":trace},indent=2))
            # Focus changes during WebDriver fixture setup may legitimately
            # run the existing active-tab scroll policy. Test the actual
            # resynchronization boundary, not those unrelated earlier events.
            restores = [entry for entry in trace if entry["phase"] == "restored"]
            assert restores, "No authoritative model replacement was observed"
            for entry in restores:
                assert entry["actual"] == entry["state"]["scrollTop"], entry
            assert after["cursor"] == state["cursor"], {"before":state,"after":after}
            assert after["scroll"] == restores[-1]["actual"], {"after":after,"restores":restores}
            # Delay just the first view's next snapshot after it is captured.
            driver.script("""
              window.__skipFixtureUpdates = false;
              const original = browser.runtime.sendMessage.bind(browser.runtime);
              window.__snapshotReads = 0;
              browser.runtime.sendMessage = async (...args) => {
                const value = await original(...args);
                if (args[0]?.msg === 'bkgd_getTree' && ++window.__snapshotReads === 1) {
                  window.__readCaptured = true;
                  await new Promise(resolve => {window.__releaseRead = resolve;});
                }
                return value;
              };
              window.__isolatedTestTree.requestTreeResync();
            """)
            driver.wait("return window.__readCaptured;")
            driver.command("POST", "window", {"handle": second})
            driver.script("return browser.tabs.update(arguments[0], {url: arguments[1] + '/latest'});", tab_id, origin)
            driver.wait("return window.__isolatedTestTree.nodes[window.__fixtureNodeId]?.title === 'Latest title';")
            driver.command("POST", "window", {"handle": first})
            driver.wait("return window.__isolatedTestTree.nodes[window.__fixtureNodeId]?.title === 'Latest title';")
            driver.script("window.__releaseRead(); return true;")
            driver.wait("const tree=window.__isolatedTestTree; return !tree.resyncTask && !tree.resyncTimer && window.__snapshotReads >= 2;")
            assert driver.script("return document.getElementById('node' + window.__fixtureNodeId).textContent.includes('Latest title');")
            driver.screenshot("converged-view.png")
            failure = driver.script("""
              const done = arguments[arguments.length-1];
              (async () => {
                const app = (await browser.runtime.getBackgroundPage()).__nativeContextTest;
                const node = app.tree.nodes[window.__fixtureNodeId];
                const original = app.tree.db.writeNodes.bind(app.tree.db);
                app.__allowSyntheticWrites = false;
                app.tree.db.writeNodes = async (...args) => {
                  if (!app.__allowSyntheticWrites && args[0].some(item => item.id === node.id && item.note === 'Unsaved fixture'))
                    throw new Error('Synthetic convergence disk failure');
                  return original(...args);
                };
                try {
                  await app.runSerializedBrowserMutation(() => node.setNotes(node.label, 'Unsaved fixture', {reason:'userAction'}));
                  throw new Error('The injected write unexpectedly succeeded');
                } catch (error) {
                  if (!String(error).includes('Synthetic convergence disk failure')) throw error;
                }
                const stored = await app.tree.db.loadNode(node.id);
                return {durableStillOld: stored.note !== 'Unsaved fixture', unsaved: app.tree.root.getPersistenceState().unsaved};
              })().then(done, err => done({error:String(err)}));
            """, asynchronous=True)
            assert failure == {"durableStillOld": True, "unsaved": True}, failure
            for handle in (first, second):
                driver.command("POST", "window", {"handle": handle})
                driver.wait("return !document.getElementById('persistence-warning').classList.contains('hidden');")
            layout = driver.script("""
              const warning=document.getElementById('persistence-warning').getBoundingClientRect();
              const tree=document.getElementById('tree-view').getBoundingClientRect();
              return {warningBottom:warning.bottom, treeTop:tree.top};
            """)
            assert layout['warningBottom'] <= layout['treeTop'] + 1, layout
            driver.screenshot("unsaved-warning.png")
            driver.script("""
              const done = arguments[arguments.length-1];
              browser.runtime.getBackgroundPage().then(bg => {
                bg.__nativeContextTest.__allowSyntheticWrites = true;
                done(true);
              });
            """, asynchronous=True)
            driver.script("document.getElementById('retry-persistence').click(); return true;")
            for handle in (first, second):
                driver.command("POST", "window", {"handle": handle})
                driver.wait("return document.getElementById('persistence-warning').classList.contains('hidden');")
            durable = driver.script("""
              const done = arguments[arguments.length-1];
              (async () => {
                const app = (await browser.runtime.getBackgroundPage()).__nativeContextTest;
                const node = await app.tree.db.loadNode(window.__fixtureNodeId);
                return {note:node.note,pending:app.tree.root.getPersistenceState().pending};
              })().then(done,err=>done({error:String(err)}));
            """, asynchronous=True)
            assert durable == {"note":"Unsaved fixture", "pending":0}, durable
            errors = driver.script("""
              const done=arguments[arguments.length-1];
              browser.runtime.getBackgroundPage().then(bg=>done(bg.__nativeContextErrors));
            """, asynchronous=True)
            unexpected = [error for error in errors if 'Synthetic convergence disk failure' not in error]
            assert not unexpected, unexpected
            result = {"passed": True, "firefox": driver.capabilities["browserVersion"], "workspace": str(work),
                      "views": 2, "missedFieldAndStructuralUpdatesRepaired": True,
                      "cursorAndScrollPreserved": True, "newerDeltaWinsOverDelayedSnapshot": True,
                      "failedWriteWarningInBothViews": True, "realRetryButtonPersisted": True,
                      "unexpectedBackgroundErrors": 0}
            (args.output / "results.json").write_text(json.dumps(result, indent=2))
            print(json.dumps(result, indent=2))
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
