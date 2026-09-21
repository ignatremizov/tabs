// Real-browser tests; only loaded by firefox-native-context.py's staging addon.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
const api = browser;
const results = [];
let trace;
const origin = new URL(location.href).searchParams.get('origin');
if (! /^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw new Error('Loopback fixture origin required');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, message) { if (! value) throw new Error(message); }
async function waitFor(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function test(name, run) {
  trace?.push({ time: Date.now(), test: name });
  try { await run(); results.push({ name, pass: true }); }
  catch (err) { results.push({ name, pass: false, error: `${err?.message || err}\n${err?.stack || ''}` }); }
  document.getElementById('results').textContent = JSON.stringify(results, null, 2);
}

try {
  const background = await api.runtime.getBackgroundPage();
  trace = background.__nativeContextTrace;
  const bkgd = await waitFor(() => background.__nativeContextTest, 'background test handle');
  await Promise.race([bkgd.treeLoaded, sleep(15000).then(() => { throw new Error('Background did not initialize'); })]);
  const tree = bkgd.tree;
  if (new URL(location.href).searchParams.get('phase') === 'reload') {
    const { nativeContextCheckpoint: saved } = await api.storage.local.get('nativeContextCheckpoint');
    assert(saved, 'Missing pre-reload checkpoint');
    await test('extension reload retains container scope, group notes, and member identities', async () => {
      assert(bkgd.containers.profileId === saved.profileId, 'Container profile scope changed');
      for (const before of saved.nodes) {
        const node = tree.nodes[before.id];
        assert(node, `Saved node lost: ${before.id}`);
        assert(node.parent.id === before.parent, `Ancestry changed for ${before.id}`);
        if (before.cookieStoreId) {
          assert(node.cookieStoreId === before.cookieStoreId, 'Container reference lost');
          if (before.loaded) assert(node.loaded && node.tabId === before.tabId, 'Live tab binding changed');
        }
        if (before.nativeGroup) {
          assert(node.nativeGroup && node.label === before.label && node.groupColor === before.groupColor,
            'Persistent native group metadata changed');
        }
      }
      assert(tree.root.findNodes(node => node.nativeGroup).length === saved.groupCount, 'Group notes duplicated');
    });
    await test('extension reload keeps synthetic authentication stores separate', async () => {
      for (const [storeId, value] of saved.cookies) {
        const cookie = await api.cookies.get({ url: origin, name: 'test_session', storeId });
        assert(cookie?.value === value, 'Container cookie state changed across reload');
      }
    });
    await test('extension reload reports no unexpected background errors', () => {
      assert(background.__nativeContextErrors.length === 0, background.__nativeContextErrors.join('\n'));
    });
  } else {
  tree.reorderTabsOnCreate = false;
  await api.storage.local.set({ hideCollapsedTabs: false });
  const personal = await api.contextualIdentities.create({ name: 'Personal fixture', color: 'blue', icon: 'fingerprint' });
  const work = await api.contextualIdentities.create({ name: 'Work fixture', color: 'green', icon: 'briefcase' });
  const office = await api.contextualIdentities.create({ name: 'Office fixture', color: 'toolbar', icon: 'briefcase' });
  await bkgd.runSerializedBrowserMutation(() => bkgd.containers.refresh());
  const nativeWindow = await api.windows.create({ url: origin + '/outside', focused: false });
  const win = await waitFor(() => tree.root.getWindowId(nativeWindow.id), 'fixture window');
  const outsideTab = nativeWindow.tabs[0];
  const outside = await waitFor(() => tree.getNodeByTabId(outsideTab.id), 'outside tab');
  const create = async (store, path = '/account') => {
    const tab = await api.tabs.create({ windowId: win.windowId, cookieStoreId: store, url: origin + path, active: false });
    const node = await waitFor(() => tree.getNodeByTabId(tab.id), 'tab attachment');
    await sleep(120);
    return { tab, node };
  };
  const p = await create(personal.cookieStoreId);
  const w = await create(work.cookieStoreId);
  await test('identical URLs retain distinct container IDs and synthetic login cookies', async () => {
    assert(p.node !== w.node, 'Nodes must not be coalesced by URL');
    assert(p.node.cookieStoreId === personal.cookieStoreId, 'Personal identity not captured');
    assert(w.node.cookieStoreId === work.cookieStoreId, 'Work identity not captured');
    assert(p.node.containerName === personal.name && w.node.containerName === work.name, 'Container labels missing');
    await api.cookies.set({ url: origin, name: 'test_session', value: 'personal-only', storeId: personal.cookieStoreId });
    await api.cookies.set({ url: origin, name: 'test_session', value: 'work-only', storeId: work.cookieStoreId });
    assert((await api.cookies.get({ url: origin, name: 'test_session', storeId: personal.cookieStoreId })).value === 'personal-only', 'Personal cookie crossed stores');
    assert((await api.cookies.get({ url: origin, name: 'test_session', storeId: work.cookieStoreId })).value === 'work-only', 'Work cookie crossed stores');
  });

  await outside.moveTo(p.node, p.node.nodes.length, { reason: 'test', skipTabReorder: true, emit: false });
  await w.node.moveTo(outside, outside.nodes.length, { reason: 'test', skipTabReorder: true, emit: false });
  const savedOutside = await p.node.addChild(p.node.nodes.length, { url: origin + '/saved-outside', label: 'Unrelated saved tab' }, { reason: 'test' });
  const nativeGroup = await api.tabs.group({ tabIds: [p.tab.id, w.tab.id], createProperties: { windowId: win.windowId } });
  await api.tabGroups.update(nativeGroup, { title: 'Payments research', color: 'blue' });
  let group;
  await test('native grouping preserves nested members and promotes unrelated descendants', async () => {
    group = await waitFor(() => p.node.getNativeGroupNode(), 'group note');
    await waitFor(() => group.label === 'Payments research' && outside.parent === win
      && w.node.parent === p.node && savedOutside.parent === win, 'settled grouping');
    assert(group.nativeGroup && group.groupId === nativeGroup, 'Wrong native note binding');
    assert(p.node.parent === group && w.node.parent === p.node, 'Member hierarchy flattened');
    assert(savedOutside.parent === win, 'Unrelated saved descendant pulled into group');
  });

  await test('native group rename, color, collapse, and literal Pinned heading synchronize', async () => {
    await api.tabGroups.update(nativeGroup, { title: 'Pinned', color: 'purple', collapsed: true });
    await waitFor(() => group?.label === 'Pinned' && group.groupCollapsed, 'group update');
    assert(group.groupColor === 'purple' && ! group.expanded, 'Color/collapse not reflected');
    assert(! group.isPinnedBranch() && ! p.node.isPinned(), 'Group name interpreted as pin command');
    await group.setExpanded(true, { reason: 'userAction' });
    await waitFor(async () => ! (await api.tabGroups.get(nativeGroup)).collapsed, 'outline expand');
    await group.setNotes('Payments research', group.note, { reason: 'userAction' });
    await waitFor(async () => (await api.tabGroups.get(nativeGroup)).title === 'Payments research', 'outline rename');
  });

  await test('container rename/color/icon changes update the tracked tab', async () => {
    await api.contextualIdentities.update(work.cookieStoreId, { name: 'iremizov fixture', color: 'green', icon: 'briefcase' });
    await waitFor(() => w.node.containerName === 'iremizov fixture', 'identity rename');
    assert(w.node.containerIcon === 'briefcase' && w.node.containerColor === 'green', 'Identity presentation stale');
  });

  const second = await create('firefox-default', '/second-group');
  const secondId = await api.tabs.group({ tabIds: [second.tab.id], createProperties: { windowId: win.windowId } });
  await api.tabGroups.update(secondId, { title: 'Another group', color: 'orange' });
  const secondNote = await waitFor(() => second.node.getNativeGroupNode(), 'second group');
  await test('outline reorder preserves group identities, member nesting, and outsider membership', async () => {
    await secondNote.moveTo(win, 0, { reason: 'userAction' });
    await sleep(300);
    assert((await api.tabs.get(p.node.tabId)).groupId === nativeGroup, 'First native group was replaced');
    assert((await api.tabs.get(w.node.tabId)).groupId === nativeGroup, 'Nested member lost native group');
    assert((await api.tabs.get(second.node.tabId)).groupId === secondId, 'Second group was replaced');
    assert((await api.tabs.get(outside.tabId)).groupId === -1, 'Outside tab accidentally grouped');
    assert(w.node.parent === p.node, 'Group reorder flattened nested members');
  });

  await test('native cross-window group move preserves its note, nesting, and containers', async () => {
    const otherWindow = await api.windows.create({ url: origin + '/other-window', focused: false });
    const other = await waitFor(() => tree.root.getWindowId(otherWindow.id), 'second window attachment');
    try {
      await api.tabGroups.move(nativeGroup, { windowId: otherWindow.id, index: -1 });
      await waitFor(() => group.parent === other && p.node.windowId === otherWindow.id
        && w.node.windowId === otherWindow.id, 'cross-window group synchronization');
      assert(w.node.parent === p.node && p.node.parent === group, 'Native group move flattened members');
      assert(group.groupId === nativeGroup, 'Native move replaced group binding');
      assert((await api.tabs.get(p.node.tabId)).cookieStoreId === personal.cookieStoreId, 'Native move crossed container');
      assert(outside.parent === win && secondNote.parent === win, 'Unrelated tabs followed group');
    } finally {
      await api.tabGroups.move(nativeGroup, { windowId: win.windowId, index: -1 });
      await waitFor(() => group.parent === win && w.node.windowId === win.windowId, 'return native group');
      await api.windows.remove(otherWindow.id);
    }
  });

  await test('outline cross-window group move preserves the native group and its member tree', async () => {
    const otherWindow = await api.windows.create({ url: origin + '/outline-destination', focused: false });
    const other = await waitFor(() => tree.root.getWindowId(otherWindow.id), 'outline destination');
    let failure;
    const captureFailure = async (phase, err) => {
      trace?.push({ time: Date.now(), phase, error: String(err),
        group: group.toDict(), personal: p.node.toDict(), work: w.node.toDict(),
        groups: await api.tabGroups.query({}),
        tabs: (await api.tabs.query({})).map(tab => ({ id: tab.id,
          windowId: tab.windowId, groupId: tab.groupId, index: tab.index })) });
    };
    try {
      await group.moveTo(other, other.nodes.length, { reason: 'userAction' });
      await waitFor(async () => (await api.tabGroups.get(nativeGroup)).windowId === otherWindow.id,
        'outline group moved in browser');
      assert(group.parent === other && p.node.parent === group && w.node.parent === p.node, 'Outline move flattened tree');
      assert((await api.tabs.get(w.node.tabId)).cookieStoreId === work.cookieStoreId, 'Outline move crossed container');
      assert((await api.tabs.get(outside.tabId)).windowId === win.windowId, 'Outside tab moved');
    } catch (err) {
      failure = err;
      await captureFailure('outbound outline move', err);
    } finally {
      try {
        await group.moveTo(win, win.nodes.length, { reason: 'userAction' });
        await waitFor(async () => (await api.tabGroups.get(nativeGroup)).windowId === win.windowId,
          'return outline group');
        await api.windows.remove(otherWindow.id);
      } catch (err) {
        await captureFailure('return outline move', err);
        failure ||= err;
      }
    }
    if (failure) throw failure;
  });

  await test('saved grouped tab resumes in its exact container and existing native group', async () => {
    const originalId = p.node.tabId;
    await p.node.unload({ reason: 'userAction' });
    await waitFor(() => ! p.node.loaded && ! p.node.tabId, 'unload container tab');
    const response = await bkgd.bkgd_loadSavedNode({ nodeId: p.node.id, discarded: false });
    assert(! response.error && response.result === 'ok', JSON.stringify(response));
    await waitFor(() => p.node.loaded && p.node.tabId !== originalId && p.node.groupId === nativeGroup, 'restore grouped container tab');
    const tab = await api.tabs.get(p.node.tabId);
    assert(tab.cookieStoreId === personal.cookieStoreId && tab.groupId === nativeGroup, 'Restore crossed identity/group');
    assert((await api.cookies.get({ url: origin, name: 'test_session', storeId: tab.cookieStoreId })).value === 'personal-only', 'Restored authentication store changed');
  });

  await test('deleted container restore stays saved and creates no replacement tab', async () => {
    const o = await create(office.cookieStoreId, '/deleted-container');
    await o.node.setNotes('Missing container example', undefined, { reason: 'test' });
    await o.node.unload({ reason: 'userAction' });
    await waitFor(() => ! o.node.loaded, 'unload office');
    await api.contextualIdentities.remove(office.cookieStoreId);
    await waitFor(() => o.node.containerMissing, 'deleted identity metadata');
    const before = (await api.tabs.query({})).length;
    const response = await bkgd.bkgd_loadSavedNode({ nodeId: o.node.id });
    assert(response.error && o.node.restoreError, 'Missing identity failure not visible');
    assert((await api.tabs.query({})).length === before && ! o.node.loaded, 'Opened fallback tab');
  });

  await test('initial tab of a new saved window opens in the saved container and group', async () => {
    const savedWindow = await tree.root.addChild(tree.root.nodes.length, { type: 'window', label: 'Restored container window', incognito: false }, { reason: 'test' });
    const savedGroup = await savedWindow.addChild(0, { nativeGroup: true, label: 'Saved group', groupColor: 'green', groupCollapsed: true }, { reason: 'test' });
    const node = await savedGroup.addChild(0, { url: origin + '/new-window', cookieStoreId: personal.cookieStoreId,
      containerProfileId: bkgd.containers.profileId, containerName: personal.name, containerColor: personal.color, containerIcon: personal.icon }, { reason: 'test' });
    const response = await bkgd.bkgd_loadSavedNode({ nodeId: node.id, discarded: false });
    assert(! response.error && response.result === 'ok', JSON.stringify(response));
    try {
      await waitFor(() => node.loaded && node.tabId && savedGroup.groupId !== undefined, 'new-window container restore');
    } catch (err) {
      throw new Error(`${err.message}\n${JSON.stringify({
        node: node.toDict(), group: savedGroup.toDict(), window: savedWindow.toDict(),
        pending: bkgd.nodesLoading.map(item => item.id),
        browsers: await api.windows.getAll({ populate: true }),
        candidates: Object.values(tree.nodes).filter(item => item.url?.endsWith('/new-window')).map(item => item.toDict())
      }, null, 2)}`);
    }
    assert((await api.tabs.get(node.tabId)).cookieStoreId === personal.cookieStoreId, 'Initial URL loaded in default store');
    assert((await api.tabGroups.get(savedGroup.groupId)).title === 'Saved group', 'Group was not recreated');
    await api.windows.remove(node.windowId);
    await waitFor(() => ! node.loaded, 'close restored window');
  });

  await test('native ungroup promotes a member without moving its remaining grouped descendants', async () => {
    await api.tabs.ungroup(p.node.tabId);
    // Reconciliation persists/broadcasts several moves. Observe the complete
    // invariant, not the instant between promoting the parent and its child.
    await waitFor(() => ! p.node.getNativeGroupNode()
      && w.node.getNativeGroupNode() === group, 'native ungroup');
    assert(w.node.getNativeGroupNode() === group, 'Still-grouped child followed its ungrouped parent');
    await api.tabs.group({ groupId: nativeGroup, tabIds: [p.node.tabId] });
    await waitFor(() => p.node.getNativeGroupNode() === group, 'regroup');
  });

  await test('closing and restoring a native window preserves containers and group note identities', async () => {
    const windowNodeId = win.id, groupNodeId = group.id, personalNodeId = p.node.id, workNodeId = w.node.id;
    const oldWindowId = win.windowId;
    await api.windows.remove(oldWindowId);
    await waitFor(() => ! win.loaded && ! p.node.loaded && ! w.node.loaded, 'closed native window');
    const closed = await waitFor(async () => (await api.sessions.getRecentlyClosed())
      .find(item => item.window?.tabs?.some(tab => tab.url === origin + '/account')), 'closed session');
    const restored = await api.sessions.restore(closed.window.sessionId);
    await waitFor(() => tree.nodes[personalNodeId]?.loaded && tree.nodes[workNodeId]?.loaded, 'native session tabs restored');
    await sleep(700);
    assert(tree.nodes[windowNodeId] === win && win.windowId === restored.window.id, 'Window history duplicated');
    assert(tree.nodes[groupNodeId] === group && w.node.getNativeGroupNode() === group && p.node.getNativeGroupNode() === group, 'Group note replaced/duplicated on session restore');
    assert((await api.tabs.get(p.node.tabId)).cookieStoreId === personal.cookieStoreId, 'Personal store lost on native restore');
    assert((await api.tabs.get(w.node.tabId)).cookieStoreId === work.cookieStoreId, 'Work store lost on native restore');
  });

  await test('background has no unexpected errors during native context lifecycle', async () => {
    const errors = background.__nativeContextErrors || [];
    assert(errors.length === 0, errors.join('\n'));
  });
  // The driver reloads the test addon, then checks this against IndexedDB's
  // reloaded tree and the browser's original live tabs, not in-memory objects.
  await bkgd.runSerializedBrowserMutation(() => bkgd.tabGroups.sync());
  await api.storage.local.set({ nativeContextCheckpoint: {
    profileId: bkgd.containers.profileId, focusNodeId: win.id,
    groupCount: tree.root.findNodes(node => node.nativeGroup).length,
    nodes: [group, p.node, w.node, secondNote, savedOutside].map(node => node.toDict()),
    cookies: [[personal.cookieStoreId, 'personal-only'], [work.cookieStoreId, 'work-only']]
  } });
  }
} catch (err) {
  results.push({ name: 'integration setup', pass: false, error: `${err?.message || err}\n${err?.stack || ''}` });
} finally {
  window.__TEST_RESULTS__ = { results, passCount: results.filter(item => item.pass).length,
    failCount: results.filter(item => ! item.pass).length };
  if (window.__TEST_RESULTS__.failCount) window.__TEST_RESULTS__.trace = trace;
  document.getElementById('results').textContent = JSON.stringify(window.__TEST_RESULTS__, null, 2);
  window.__TEST_DONE__ = true;
}
