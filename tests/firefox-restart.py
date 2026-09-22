#!/usr/bin/env python3
"""Verify persistence and native-session rebinding across two Firefox processes.

Only a newly created marked profile is reused. Firefox removes temporary addons
at process exit, so the same staged test addon is reinstalled after relaunch;
its original profile, extension origin, IndexedDB, containers, and session data
are retained. This is not a runtime.reload test and not a signed-upgrade test.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import http.server
import importlib.util
import json
from pathlib import Path
import shutil
import threading
import time

from firefox_driver import FirefoxSession, new_workspace

ROOT = Path(__file__).resolve().parents[1]

SETUP = """
const done = arguments[arguments.length - 1], origin = arguments[0];
(async () => {
  const bg = await browser.runtime.getBackgroundPage();
  const app = bg.__nativeContextTest;
  await app.treeLoaded;
  const tree = app.tree;
  const wait = async (check, label) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) { const value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Restart fixture did not settle: ${label}; groups=${JSON.stringify(await browser.tabGroups.query({}))}; notes=${JSON.stringify(tree.root.findNodes(node => node.nativeGroup).map(node => ({id:node.id,label:node.label,expanded:node.expanded,collapsed:node.groupCollapsed,parent:node.parent?.id,children:node.nodes.map(child => child.id)})))}`);
  };
  await browser.storage.local.set({reorderTabsOnCreate: false, hideCollapsedTabs: false});
  tree.reorderTabsOnCreate = false;
  const identities = [];
  for (const [name, color, icon] of [['Restart personal', 'blue', 'fingerprint'], ['Restart work', 'green', 'briefcase']]) {
    identities.push(await browser.contextualIdentities.create({name, color, icon}));
  }
  const nativeWindow = await browser.windows.create({url: origin + '/outside', focused: false});
  const win = await wait(() => tree.root.getWindowId(nativeWindow.id), 'window attachment');
  const tabs = [];
  for (const identity of identities) {
    tabs.push(await browser.tabs.create({windowId: nativeWindow.id, url: origin + '/account',
      cookieStoreId: identity.cookieStoreId, active: false}));
    await browser.cookies.set({url: origin, name: 'restart_fixture', value: identity.name,
      storeId: identity.cookieStoreId, expirationDate: Math.floor(Date.now()/1000) + 3600});
  }
  const nodes = await wait(() => {
    const values = tabs.map(tab => tree.getNodeByTabId(tab.id));
    return values.every(Boolean) ? values : null;
  }, 'tab attachment');
  const groupId = await browser.tabs.group({tabIds: tabs.map(tab => tab.id), createProperties: {windowId: nativeWindow.id}});
  await browser.tabGroups.update(groupId, {title: 'Restart research', color: 'purple', collapsed: false});
  const group = await wait(() => nodes[0].getNativeGroupNode(), 'group attachment');
  await nodes[1].moveTo(nodes[0], nodes[0].nodes.length, {reason: 'userAction'});
  const saved = await nodes[0].addChild(nodes[0].nodes.length, {
    label: 'Saved restart page', url: origin + '/saved', wasLoaded: true,
    cookieStoreId: identities[1].cookieStoreId, containerProfileId: app.containers.profileId,
    containerName: identities[1].name, containerColor: 'green', containerIcon: 'briefcase'
  }, {reason: 'userAction'});
  const note = await saved.addChild(0, {label: 'Restart annotation', note: 'Private synthetic note'}, {reason: 'userAction'});
  await group.setExpanded(false, {reason: 'userAction'});
  await wait(async () => group.label === 'Restart research' && group.groupCollapsed
    && (await browser.tabGroups.get(groupId)).collapsed && nodes[1].parent === nodes[0], 'final group invariant');
  await tree.root.flushPendingPersistence();
  const checkpoint = {origin, profileId: app.containers.profileId,
    ids: {window: win.id, group: group.id, parent: nodes[0].id, child: nodes[1].id, saved: saved.id, note: note.id,
      outside: tree.getNodeByTabId(nativeWindow.tabs[0].id).id},
    identities: identities.map(identity => ({id: identity.cookieStoreId, name: identity.name})),
    groupCount: tree.root.findNodes(node => node.nativeGroup).length,
    parents: Object.fromEntries([group, ...nodes, saved, note].map(node => [node.id, node.parent.id]))};
  await browser.storage.local.set({restartCheckpoint: checkpoint});
  return checkpoint;
})().then(done, err => done({error: String(err), stack: err.stack}));
"""

VERIFY = """
const done = arguments[arguments.length - 1];
(async () => {
  const bg = await browser.runtime.getBackgroundPage();
  const app = bg.__nativeContextTest;
  await app.treeLoaded;
  const tree = app.tree;
  const {restartCheckpoint: saved} = await browser.storage.local.get('restartCheckpoint');
  const assert = (value, text) => {if (!value) throw new Error(text);};
  assert(saved, 'Persistent checkpoint missing');
  const checks = [];
  assert(app.containers.profileId === saved.profileId, 'Container profile identity changed'); checks.push('container scope');
  for (const [id, parent] of Object.entries(saved.parents)) {
    assert(tree.nodes[id]?.parent?.id === parent, `Saved ancestry changed for ${id}`);
  }
  checks.push('node identities and nested saved ancestry');
  const group = tree.nodes[saved.ids.group];
  assert(group.nativeGroup && group.label === 'Restart research' && group.groupColor === 'purple'
    && group.groupCollapsed && !group.expanded, 'Native group metadata/collapse changed');
  const nativeGroup = await browser.tabGroups.get(group.groupId);
  assert(nativeGroup.title === group.label && nativeGroup.collapsed, 'Group not rebound to restored native group');
  assert(tree.root.findNodes(node => node.nativeGroup).length === saved.groupCount, 'Group note duplicated');
  checks.push('native group rebinding without duplicate notes');
  for (const [position, key] of ['parent', 'child'].entries()) {
    const node = tree.nodes[saved.ids[key]];
    assert(node.loaded && node.tabId, 'Previously live tab did not reconnect');
    const tab = await browser.tabs.get(node.tabId);
    assert(tab.cookieStoreId === saved.identities[position].id && tab.groupId === group.groupId, 'Tab changed cookie store or group');
    const cookie = await browser.cookies.get({url: saved.origin, name: 'restart_fixture', storeId: tab.cookieStoreId});
    assert(cookie?.value === saved.identities[position].name, 'Persistent synthetic cookie lost/crossed accounts');
  }
  checks.push('live bindings and separated persistent synthetic cookies');
  const pending = tree.nodes[saved.ids.saved];
  assert(!pending.loaded && !pending.tabId && pending.cookieStoreId === saved.identities[1].id, 'Saved tab was opened or remapped');
  assert(tree.nodes[saved.ids.note].note === 'Private synthetic note', 'Saved annotation lost');
  checks.push('saved tabs remain saved');
  const outside = tree.nodes[saved.ids.outside];
  assert(outside?.loaded && outside.parent.id === saved.ids.window, 'Ungrouped outside tab lost its identity');
  assert((await browser.tabs.get(outside.tabId)).url === saved.origin + '/outside', 'Ungrouped outside tab was not restored');
  checks.push('ungrouped native tab preserved');
  assert(bg.__nativeContextErrors.length === 0, bg.__nativeContextErrors.join('\\n'));
  checks.push('no unexpected background errors');
  return {checks, checkpoint: saved};
})().then(done, err => done({error: String(err), stack: err.stack}));
"""


def process_alive(pid):
    # The PID came from our WebDriver session. No discovery of user processes.
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        return text.rsplit(") ", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    spec = importlib.util.spec_from_file_location("restart_native_stage", ROOT / "tests/firefox-native-context.py")
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    work = new_workspace(args.geckodriver)
    profile = work / "profile"
    package = native.stage_extension(work)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), native.FixtureServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    prefs = {"browser.startup.page": 3, "browser.sessionstore.resume_from_crash": True,
             "browser.sessionstore.interval": 1000, "browser.sessionstore.max_resumed_crashes": -1,
             "browser.sessionstore.restore_on_demand": False, "browser.warnOnQuit": False,
             "browser.tabs.warnOnClose": False}
    try:
        with FirefoxSession(args.geckodriver, work, args.output / "before", profile=profile, prefs=prefs) as first:
            addon_id = first.install(package)
            first_url = first.addon_url(addon_id)
            first.navigate(first_url + "view/sidepanel.html")
            first.wait("return document.querySelector('.row') !== null;")
            checkpoint = first.script(SETUP, origin, asynchronous=True)
            assert "error" not in checkpoint, checkpoint
            (args.output / "checkpoint.json").write_text(json.dumps(checkpoint, indent=2))
            old_pid = first.capabilities["moz:processID"]
            print(f"Before restart: Firefox PID {old_pid}, persistent fixture ready", flush=True)
            time.sleep(1.2)  # Allow the configured native session-store interval.
        deadline = time.monotonic() + 10
        while process_alive(old_pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not process_alive(old_pid), "The first Firefox process did not terminate"
        assert (profile / "prefs.js").is_file(), "The explicitly owned test profile was not retained"
        with FirefoxSession(args.geckodriver, work, args.output / "after", profile=profile, prefs=prefs) as second:
            new_pid = second.capabilities["moz:processID"]
            assert new_pid != old_pid, "The test did not create a new Firefox process"
            # Browser startup can return control before native session restore
            # has finished. Wait for its real lifecycle barrier, not a sleep or
            # the extension's independent initialization promise.
            second.command("POST", "moz/context", {"context": "chrome"})
            try:
                native_state = second.script("""
                  const done=arguments[arguments.length-1];
                  (async () => {
                    let module;
                    try { module=ChromeUtils.importESModule('moz-src:///browser/components/sessionstore/SessionStore.sys.mjs'); }
                    catch { module=ChromeUtils.importESModule('resource:///modules/sessionstore/SessionStore.sys.mjs'); }
                    const {SessionStore}=module;
                    if (!SessionStore.promiseAllWindowsRestored?.then) throw new Error('Native restore barrier unavailable');
                    await SessionStore.promiseAllWindowsRestored;
                    return JSON.parse(SessionStore.getBrowserState()).windows.map(win=>({
                      tabs: win.tabs.map(tab=>({url:tab.entries?.[(tab.index||1)-1]?.url,
                        userContextId:tab.userContextId,extData:tab.extData})), extData:win.extData}));
                  })().then(done,err=>done({error:String(err)}));
                """, asynchronous=True)
            finally:
                second.command("POST", "moz/context", {"context": "content"})
            (args.output / "native-before-reinstall.json").write_text(json.dumps(native_state,indent=2))
            restored_urls=[tab.get("url") for win in native_state for tab in win["tabs"]]
            assert restored_urls.count(origin + '/account') == 2 and origin + '/outside' in restored_urls, native_state
            # Never navigate over a restored fixture tab merely to host the
            # test controls. Create a separate fresh automation window first.
            harness = second.command("POST", "window/new", {"type": "window"})["handle"]
            second.command("POST", "window", {"handle": harness})
            second.install(package)
            second_url = second.addon_url(addon_id)
            assert first_url == second_url, "The test addon origin changed across process restart"
            second.navigate(second_url + "view/sidepanel.html")
            try:
                result = second.script(VERIFY, asynchronous=True)
            except RuntimeError:
                diagnostic = second.script("""
                  const done=arguments[arguments.length-1];
                  (async()=>{
                    const bg=await browser.runtime.getBackgroundPage(),app=bg.__nativeContextTest;
                    const {restartCheckpoint:saved}=await browser.storage.local.get('restartCheckpoint');
                    return {nodes:Object.fromEntries(Object.entries(saved.ids).map(([key,id])=>[key,app.tree.nodes[id]?.toDict()])),
                      tabs:(await browser.tabs.query({})).map(tab=>({id:tab.id,windowId:tab.windowId,groupId:tab.groupId,url:tab.url,cookieStoreId:tab.cookieStoreId})),
                      groups:await browser.tabGroups.query({}),errors:bg.__nativeContextErrors};
                  })().then(done,err=>done({failure:String(err)}));
                """,asynchronous=True)
                (args.output / "failure-diagnostic.json").write_text(json.dumps(diagnostic,indent=2))
                raise
            (args.output / "verification.json").write_text(json.dumps(result, indent=2))
            assert "error" not in result, result
            # Restore the saved member through the real background load path,
            # not just from a JSON assertion of persisted metadata.
            restored = second.script("""
              const done = arguments[arguments.length - 1];
              (async () => {
                const {restartCheckpoint: saved} = await browser.storage.local.get('restartCheckpoint');
                const bg = await browser.runtime.getBackgroundPage(), app = bg.__nativeContextTest;
                const response = await app.bkgd_loadSavedNode({nodeId: saved.ids.saved, discarded: false});
                if (response.error) throw new Error(response.error);
                const until = Date.now() + 10000;
                while (Date.now() < until) {
                  const node = app.tree.nodes[saved.ids.saved];
                  if (node.loaded && node.tabId) {
                    const tab = await browser.tabs.get(node.tabId);
                    if (tab.groupId === app.tree.nodes[saved.ids.group].groupId) return {
                      container: tab.cookieStoreId === saved.identities[1].id,
                      group: node.getNativeGroupNode()?.id === saved.ids.group,
                      ancestry: node.parent.id === saved.ids.parent};
                  }
                  await new Promise(resolve => setTimeout(resolve, 50));
                }
                throw new Error('Saved member did not restore after process restart');
              })().then(done, err => done({error: String(err)}));
            """, asynchronous=True)
            assert restored == {"container": True, "group": True, "ancestry": True}, restored
            second.wait("return document.querySelector('.row') !== null;")
            second.script("""
              if (![...document.querySelectorAll('.native-group')].some(node => node.textContent.includes('Restart research')))
                document.getElementById('view-scope-btn').click();
            """)
            second.wait("return [...document.querySelectorAll('.native-group')].some(node => node.textContent.includes('Restart research'));")
            second.script("[...document.querySelectorAll('.native-group')].find(node => node.textContent.includes('Restart research')).scrollIntoView({block:'center'});")
            second.screenshot("post-restart.png")
            report = {"passed": True, "beforePid": old_pid, "afterPid": new_pid,
                      "firefox": second.capabilities["browserVersion"], "workspace": str(work),
                      "sameTestProfile": True, "temporaryAddonReinstalled": True,
                      "checks": result["checks"], "savedMemberRestore": restored}
            (args.output / "results.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
