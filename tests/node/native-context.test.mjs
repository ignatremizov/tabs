// tests/node/native-context.test.mjs: containers and persistent native groups
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { cookieStoreKey, sameCookieStore } from '/common/containers.js';
import { Containers } from '/bkgd/containers.js';
import { TabGroups } from '/bkgd/tab-groups.js';

export async function registerNativeContextTests(h) {
  const { test, assert, assertEqual: eq, api, Bkgd, Tree, NodeStore, addChild } = h;
  const clone = value => structuredClone(value);

  async function fixture(run) {
    const original = { tabs: api.tabs, windows: api.windows, tabGroups: api.tabGroups,
      contextualIdentities: api.contextualIdentities, storage: api.storage };
    const state = { tabs: [], groups: new Map(), windows: [{ id: 1, type: 'normal', incognito: false }],
      identities: new Map(), writes: [], calls: [], nextGroup: 100 };
    const indexes = () => {
      for (const win of state.windows) {
        state.tabs.filter(tab => tab.windowId === win.id)
          .forEach((tab, index) => { tab.index = index; });
      }
    };
    const tabsIn = filter => state.tabs.filter(tab => Object.entries(filter || {})
      .every(([key, value]) => tab[key] === value));
    const cleanup = () => {
      for (const id of state.groups.keys()) {
        if (! state.tabs.some(tab => tab.groupId === id)) state.groups.delete(id);
      }
    };
    const move = (ids, windowId, index, forcedGroup) => {
      ids = Array.isArray(ids) ? ids : [ids];
      const moving = ids.map(id => state.tabs.find(tab => tab.id === id));
      if (moving.some(tab => ! tab)) throw new Error('Invalid tab ID');
      const old = tabsIn({ windowId });
      const remaining = old.filter(tab => ! ids.includes(tab.id));
      const at = index < 0 ? remaining.length : Math.min(index, remaining.length);
      const previous = remaining[at - 1], next = remaining[at];
      const adjacentGroup = previous?.groupId >= 0 && previous.groupId === next?.groupId
        ? previous.groupId : -1;
      for (const tab of moving) {
        const own = old.filter(other => other.groupId === tab.groupId);
        const withinOwn = tab.groupId >= 0 && own.length > 1
          && index >= own[0].index && index <= own.at(-1).index;
        tab.groupId = forcedGroup ?? (withinOwn ? tab.groupId : adjacentGroup);
        tab.windowId = windowId;
      }
      remaining.splice(at, 0, ...moving);
      state.tabs = state.tabs.filter(tab => tab.windowId !== windowId && ! ids.includes(tab.id))
        .concat(remaining);
      indexes();
      cleanup();
      return clone(moving);
    };
    api.tabs = { ...api.tabs,
      get: async id => {
        const tab = state.tabs.find(tab => tab.id === id);
        if (! tab) throw new Error(`Invalid tab ID: ${id}`);
        return clone(tab);
      },
      query: async filter => clone(tabsIn(filter)),
      move: async (ids, props) => {
        state.calls.push(['move', clone(ids), clone(props)]);
        const first = Array.isArray(ids) ? ids[0] : ids;
        return move(ids, props.windowId ?? state.tabs.find(tab => tab.id === first).windowId, props.index);
      },
      update: async (id, props) => {
        const tab = state.tabs.find(tab => tab.id === id);
        Object.assign(tab, props);
        return clone(tab);
      },
      group: async props => {
        state.calls.push(['group', clone(props)]);
        let group;
        if (props.groupId !== undefined) {
          group = state.groups.get(props.groupId);
          if (! group) throw new Error('No group');
        } else {
          group = { id: state.nextGroup++, windowId: props.createProperties?.windowId ?? 1,
            title: '', color: 'gray', collapsed: false };
          state.groups.set(group.id, group);
        }
        const ids = Array.isArray(props.tabIds) ? props.tabIds : [props.tabIds];
        const other = tabsIn({ windowId: group.windowId }).filter(tab => ! ids.includes(tab.id));
        const last = other.findLastIndex(tab => tab.groupId === group.id);
        move(ids, group.windowId, last < 0 ? -1 : last + 1, group.id);
        state.groups.set(group.id, group);
        for (const id of ids) state.tabs.find(tab => tab.id === id).pinned = false;
        return group.id;
      },
      ungroup: async ids => {
        state.calls.push(['ungroup', clone(ids)]);
        for (const id of (Array.isArray(ids) ? ids : [ids])) {
          state.tabs.find(tab => tab.id === id).groupId = -1;
        }
        cleanup();
      },
      remove: async ids => {
        const removing = new Set(Array.isArray(ids) ? ids : [ids]);
        state.tabs = state.tabs.filter(tab => ! removing.has(tab.id));
        indexes(); cleanup();
      }
    };
    api.windows = { ...api.windows,
      getAll: async () => state.windows.map(win => ({ ...clone(win), tabs: clone(tabsIn({ windowId: win.id })) })),
      get: async id => ({ ...clone(state.windows.find(win => win.id === id)), tabs: clone(tabsIn({ windowId: id })) })
    };
    api.tabGroups = {
      query: async filter => clone([...state.groups.values()].filter(group => Object.entries(filter)
        .every(([key, value]) => group[key] === value))),
      get: async id => {
        if (! state.groups.has(id)) throw new Error('No group');
        return clone(state.groups.get(id));
      },
      update: async (id, changes) => {
        Object.assign(state.groups.get(id), changes);
        return clone(state.groups.get(id));
      },
      move: async (id, props) => {
        state.calls.push(['groupMove', id, clone(props)]);
        const group = state.groups.get(id);
        if (! group) throw new Error('No group');
        const ids = tabsIn({ groupId: id }).map(tab => tab.id);
        group.windowId = props.windowId ?? group.windowId;
        move(ids, group.windowId, props.index, id);
        state.groups.set(id, group);
        return clone(group);
      }
    };
    api.contextualIdentities = {
      query: async () => clone([...state.identities.values()]),
      get: async id => {
        if (! state.identities.has(id)) throw new Error('No container');
        return clone(state.identities.get(id));
      }
    };
    const storage = { nativeContainerProfileId: 'test-profile' };
    api.storage = { ...api.storage, local: {
      get: async defaults => ({ ...defaults, ...storage }),
      set: async values => Object.assign(storage, values)
    } };
    const bkgd = new Bkgd();
    let nextId = 0;
    bkgd.idGen = { newId: () => `context-${++nextId}` };
    const tree = new Tree(NodeStore);
    tree.bkgd = bkgd;
    tree.db = { writeNodes: async (nodes, removed) => state.writes.push({
      nodes: nodes.map(node => clone(node.toDict())), removed: [...removed]
    }) };
    bkgd.tree = tree;
    bkgd.treeLoaded = Promise.resolve();
    tree.resolveTreeLoaded();
    tree.reorderTabsOnCreate = false;
    bkgd.containers.profileId = 'test-profile';
    const win = await addChild(tree.root, { type: 'window', windowId: 1, loaded: true });
    const addTab = async (parent = win, details = {}, groupId = -1) => {
      const id = details.tabId ?? (state.tabs.length + 1);
      const tab = { id, windowId: details.windowId ?? 1, url: details.url || `https://example.test/${id}`,
        title: details.title || `Tab ${id}`, active: false, pinned: false, incognito: false,
        cookieStoreId: details.cookieStoreId || 'firefox-default', groupId };
      state.tabs.push(tab); indexes();
      const node = await addChild(parent, { ...tree.browserTabToNodeDetails(tab), ...details });
      return node;
    };
    const addGroup = (id, ids, props = {}) => {
      state.groups.set(id, { id, windowId: 1, title: 'Research', color: 'blue', collapsed: false, ...props });
      for (const tab of state.tabs) if (ids.includes(tab.id)) tab.groupId = id;
    };
    try { await run({ state, bkgd, tree, win, addTab, addGroup }); }
    finally {
      clearTimeout(bkgd.tabGroups.syncTimer);
      for (const node of bkgd.nodesLoading) clearTimeout(node.pendingLoadTimer);
      Object.assign(api, original);
    }
  }

  test('container identity distinguishes default, private, and named cookie stores', () => {
    eq(cookieStoreKey({}), 'firefox-default');
    eq(cookieStoreKey({ incognito: true }), 'firefox-private');
    assert(! sameCookieStore({ cookieStoreId: 'firefox-container-1' }, {}));
    assert(! sameCookieStore({ cookieStoreId: 'firefox-container-1' }, { cookieStoreId: 'firefox-container-2' }));
  });

  test('container refresh persists renamed colors/icons and retains deleted identity labels', () => fixture(async ({ state, bkgd, win, tree }) => {
    const id = 'firefox-container-1';
    state.identities.set(id, { cookieStoreId: id, name: 'Personal', color: 'blue', icon: 'fingerprint' });
    await bkgd.containers.init();
    const node = await addChild(win, { url: 'https://example.test/', ...bkgd.containers.fieldsForTab({ cookieStoreId: id }) });
    state.identities.get(id).name = 'Renamed';
    state.identities.get(id).color = 'green';
    state.identities.get(id).icon = 'briefcase';
    state.writes.length = 0;
    assert(await bkgd.containers.refresh());
    eq(state.writes.length, 1);
    eq(node.containerName, 'Renamed'); eq(node.containerColor, 'green'); eq(node.containerIcon, 'briefcase');
    state.identities.delete(id);
    await bkgd.containers.refresh();
    eq(node.containerName, 'Renamed'); eq(node.containerMissing, true);
    const changes = tree.getBrowserTabChanges(node, { id: 77, windowId: 1, cookieStoreId: 'firefox-default' });
    assert(Object.hasOwn(changes, 'containerName') && changes.containerName === undefined);
  }));

  test('container query failure does not invent deletion or borrow foreign profile metadata', () => fixture(async ({ state, bkgd, win }) => {
    const id = 'firefox-container-1';
    state.identities.set(id, { cookieStoreId: id, name: 'Current', color: 'red', icon: 'circle' });
    const node = await addChild(win, { url: 'https://example.test/', cookieStoreId: id,
      containerProfileId: 'other-profile', containerName: 'Different account' });
    await bkgd.containers.refresh();
    eq(node.containerName, 'Different account'); eq(node.containerMissing, true);
    node.containerMissing = false;
    api.contextualIdentities.query = async () => { throw new Error('Permission temporarily unavailable'); };
    eq(await bkgd.containers.refresh(), false); eq(node.containerMissing, false);
  }));

  test('container validation rejects missing, foreign-profile, unavailable, and private restores', () => fixture(async ({ state, bkgd, win }) => {
    const id = 'firefox-container-1';
    const node = { cookieStoreId: id, containerProfileId: 'test-profile', containerName: 'Work' };
    const rejects = async value => {
      let failed = false;
      try { await bkgd.containers.validateRestore(value, win); } catch { failed = true; }
      assert(failed, 'Must not fall back to a different cookie store');
    };
    await rejects(node);
    state.identities.set(id, { cookieStoreId: id, name: 'Work', color: 'blue', icon: 'briefcase' });
    eq(await bkgd.containers.validateRestore(node, win), id);
    await rejects({ ...node, containerProfileId: 'different-profile' });
    await rejects({ ...node, containerProfileId: undefined });
    win.incognito = true; await rejects(node); win.incognito = false;
    api.contextualIdentities = undefined; await rejects(node);
    eq(await bkgd.containers.validateRestore({}, win), undefined);
    await rejects({ cookieStoreId: 'firefox-private', incognito: true });
  }));

  test('blocked container load reports a visible error without creating any browser object', () => fixture(async ({ bkgd, win }) => {
    const node = await addChild(win, { url: 'https://example.test/private-account',
      cookieStoreId: 'firefox-container-99', containerProfileId: 'test-profile', containerName: 'Removed' });
    let creates = 0;
    api.tabs.create = async () => { creates++; return {}; };
    api.windows.create = async () => { creates++; return {}; };
    const result = await bkgd.bkgd_loadSavedNode({ nodeId: node.id });
    assert(result.error); eq(creates, 0); assert(node.restoreError.includes('missing'));
    eq(node.browserLoadInProgress, false);
  }));

  for (const newWindow of [false, true]) {
    test(`container restore passes exact store to ${newWindow ? 'windows.create' : 'tabs.create'}`, () => fixture(async ({ state, bkgd, win }) => {
      const id = 'firefox-container-1';
      state.identities.set(id, { cookieStoreId: id, name: 'Work', color: 'blue', icon: 'briefcase' });
      const node = await addChild(win, { url: 'https://example.test/account', cookieStoreId: id, containerProfileId: 'test-profile' });
      if (newWindow) { win.loaded = false; win.windowId = undefined; }
      let properties;
      api.tabs.create = async props => { properties = props; return { id: 200, windowId: 1 }; };
      api.windows.create = async props => { properties = props; return { id: 2, tabs: [{ id: 200 }] }; };
      const result = await bkgd.bkgd_loadSavedNode({ nodeId: node.id });
      eq(result.result, 'ok'); eq(properties.cookieStoreId, id); eq(properties.url, node.url);
      if (newWindow) bkgd.tree.finishPendingWindowLoad(win, false);
    }));
  }

  test('pending URL matching cannot swap identical pages in different containers', () => fixture(async ({ bkgd, tree, win }) => {
    const one = await addChild(win, { url: 'https://example.test/account', cookieStoreId: 'firefox-container-1', containerProfileId: 'test-profile' });
    const two = await addChild(win, { url: one.url, cookieStoreId: 'firefox-container-2', containerProfileId: 'test-profile' });
    bkgd.nodesLoading = [one, two];
    eq(tree.takePendingLoadedNode({ windowId: 1, url: one.url, cookieStoreId: two.cookieStoreId }, one.url), two);
    eq(bkgd.nodesLoading[0], one);
  }));

  test('early blank creation/update events wait without locking and attach by returned tab ID', () => fixture(async ({ state, bkgd, tree, win }) => {
    const id = 'firefox-container-1';
    state.identities.set(id, { cookieStoreId: id, name: 'Work', color: 'green', icon: 'briefcase' });
    const group = await addChild(win, { nativeGroup: true, label: 'Saved group', groupColor: 'green' });
    const saved = await addChild(group, { url: 'https://example.test/account', cookieStoreId: id, containerProfileId: 'test-profile' });
    api.tabs.create = async () => {
      const tab = { id: 50, windowId: 1, index: 0, url: 'about:blank', title: '',
        cookieStoreId: id, groupId: -1, pinned: false, incognito: false };
      state.tabs.push(tab);
      await bkgd.onTabCreated(clone(tab));
      await bkgd.onTabUpdated(tab.id, { url: 'about:blank' }, clone(tab));
      eq(tree.getNodeByTabId(tab.id), null, 'Do not create a provisional duplicate');
      return clone(tab);
    };
    const response = await bkgd.bkgd_loadSavedNode({ nodeId: saved.id });
    eq(response.result, 'ok'); eq(tree.getNodeByTabId(50), saved);
    eq(saved.url, 'https://example.test/account'); eq(saved.cookieStoreId, id);
    eq(saved.getNativeGroupNode(), group); eq(saved.groupId, group.groupId);
    eq(bkgd.nodesLoading.length, 0); eq(bkgd.deferredCreatedTabs.size, 0);
    eq(saved.browserLoadInProgress, false);
  }));

  test('overlapping same-store same-URL restores bind by creation results, not response order', () => fixture(async ({ state, bkgd, tree, win }) => {
    const one = await addChild(win, { url: 'https://example.test/repeated' });
    const two = await addChild(win, { url: one.url });
    const resultResolvers = [];
    api.tabs.create = async () => {
      const id = 60 + resultResolvers.length;
      const tab = { id, index: resultResolvers.length, windowId: 1, url: one.url,
        cookieStoreId: 'firefox-default', pinned: false, groupId: -1, incognito: false };
      state.tabs.push(tab);
      const result = new Promise(resolve => resultResolvers.push(() => resolve(clone(tab))));
      await bkgd.onTabCreated(clone(tab));
      return result;
    };
    const first = bkgd.bkgd_loadSavedNode({ nodeId: one.id });
    const second = bkgd.bkgd_loadSavedNode({ nodeId: two.id });
    for (let count = 0; count < 100 && resultResolvers.length < 2; count++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    eq(resultResolvers.length, 2);
    resultResolvers[1](); await second;
    resultResolvers[0](); await first;
    eq(one.tabId, 60); eq(two.tabId, 61);
    eq(tree.root.findNodes(node => node.url === one.url).length, 2);
    eq(bkgd.nodesLoading.length, 0);
  }));

  test('browser notification wrappers never return uncloneable domain objects', async () => {
    const bkgd = new Bkgd();
    let listener;
    const event = { addListener: value => { listener = value; } };
    bkgd.addSafeListener(event, 'synthetic', async () => ({ callback: () => {} }));
    eq(await listener(), undefined);
    bkgd.addSafeListener(event, 'synthetic-sync', () => ({ callback: () => {} }));
    eq(listener(), undefined);
  });

  test('startup merge matches duplicate URLs by cookie store rather than raw index', () => fixture(async ({ state, bkgd, win, addTab }) => {
    const one = await addTab(win, { url: 'https://example.test/account', cookieStoreId: 'firefox-container-1', tabId: 21 });
    const two = await addTab(win, { url: one.url, cookieStoreId: 'firefox-container-2', tabId: 22 });
    one.tabId = 101; two.tabId = 102;
    state.tabs.reverse(); state.tabs.forEach((tab, index) => { tab.index = index; });
    await bkgd.mergeOpenWindowsIntoTree();
    eq(one.tabId, 21); eq(two.tabId, 22);
  }));

  test('startup session identities survive reused numeric IDs without borrowing saved descendants', () => fixture(async ({ state, bkgd, tree, win, addTab }) => {
    const outside = await addTab(win);
    const a = await addTab(win, {cookieStoreId: 'firefox-container-1'});
    const b = await addTab(a, {cookieStoreId: 'firefox-container-2', url: a.url});
    const saved = await addChild(a, {url: 'https://example.test/saved', wasLoaded: true,
      cookieStoreId: b.cookieStoreId, containerProfileId: 'test-profile'});
    const identities = new Map();
    for (const [index, node] of [outside, a, b].entries()) {
      const tab = state.tabs[index];
      tab.id += 1; // Every restored ID collides with a different persisted tab.
      identities.set(tab.id, node);
    }
    tree.getTabNodeFromSession = async id => identities.get(id);
    tree.getWindowNodeFromSession = async () => win;
    await bkgd.mergeOpenWindowsIntoTree();
    eq(outside.tabId, 2); eq(a.tabId, 3); eq(b.tabId, 4);
    assert(outside.loaded && a.loaded && b.loaded);
    eq(b.parent, a); eq(saved.parent, a);
    eq(saved.loaded, false); eq(saved.tabId, undefined);
    eq(saved.url, 'https://example.test/saved');
    eq(win.getLoadedTabs().length, 3);
    eq(tree.root.findNodes(node => node.url === a.url).length, 2);
  }));

  test('startup heuristics reserve nodes with an authoritative session match elsewhere in the snapshot', () => fixture(async ({ state, bkgd, tree, win, addTab }) => {
    const original = await addTab(win, {url: 'https://example.test/repeated'});
    const saved = await addChild(original, {url: 'https://example.test/history'});
    state.tabs[0].id = 100;
    // A newly opened same-URL tab is enumerated before the restored original.
    state.tabs.unshift({...state.tabs[0], id: 99, index: 0});
    state.tabs[1].index = 1;
    tree.getTabNodeFromSession = async id => id === 100 ? original : null;
    tree.getWindowNodeFromSession = async () => win;
    await bkgd.mergeOpenWindowsIntoTree();
    eq(original.tabId, 100); eq(saved.parent, original);
    eq(saved.url, 'https://example.test/history'); eq(saved.loaded, false);
    assert(tree.getNodeByTabId(99) !== original);
    eq(tree.getNodeByTabId(100), original);
  }));

  test('startup assigns restored window IDs before attaching their nested tabs', () => fixture(async ({ state, bkgd, tree, win, addTab }) => {
    const parent = await addTab(win);
    const child = await addTab(parent);
    const saved = await addChild(parent, { url: 'https://example.test/saved-history' });
    // The native window and its tabs were restored with different IDs. The
    // durable session values, not the old numbers, identify the saved tree.
    state.windows[0].id = 12;
    const identities = new Map();
    for (const [index, node] of [parent, child].entries()) {
      state.tabs[index].id += 100;
      state.tabs[index].windowId = 12;
      identities.set(state.tabs[index].id, node);
    }
    tree.getWindowNodeFromSession = async id => id === 12 ? win : null;
    tree.getTabNodeFromSession = async id => identities.get(id);
    await bkgd.mergeOpenWindowsIntoTree();
    eq(win.windowId, 12, 'Bind the restored window before a later reconciliation is needed');
    eq(tree.root.getWindowId(12), win);
    eq(parent.windowId, 12); eq(child.windowId, 12);
    eq(parent.parent, win); eq(child.parent, parent); eq(saved.parent, parent);
    eq(saved.loaded, false);
  }));

  test('native grouping preserves member nesting and promotes live and saved nonmembers', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win);
    const b = await addTab(a);
    const c = await addTab(b);
    const d = await addTab(c);
    const saved = await addChild(a, { url: 'https://example.test/saved' });
    const annotation = await addChild(a, { label: 'Keep my note' });
    addGroup(7, [a.tabId, c.tabId]);
    assert(await bkgd.tabGroups.sync());
    const note = tree.root.findNodes(node => node.nativeGroup)[0];
    eq(note.label, 'Research'); eq(note.parent, win);
    eq(a.parent, note); eq(c.parent, a); eq(b.parent, win); eq(d.parent, b);
    eq(saved.parent, win); eq(annotation.parent, a);
    state.writes.length = 0;
    eq(await bkgd.tabGroups.sync(), false); eq(state.writes.length, 0, 'Second snapshot must be a no-op');
  }));

  test('native group rename/color/collapse updates the existing note and Pinned stays literal', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const tab = await addTab(win); addGroup(7, [tab.tabId]); await bkgd.tabGroups.sync();
    const note = tab.getNativeGroupNode();
    Object.assign(state.groups.get(7), { title: 'Pinned', color: 'red', collapsed: true });
    await bkgd.tabGroups.sync();
    eq(tab.getNativeGroupNode(), note); eq(note.label, 'Pinned'); eq(note.groupColor, 'red');
    eq(note.expanded, false); eq(note.groupCollapsed, true); eq(note.isPinnedBranch(), false); eq(tab.isPinned(), false);
    eq(tree.root.findNodes(node => node.nativeGroup).length, 1);
  }));

  test('group restart reconnects through saved members instead of stale numeric group IDs', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const tab = await addTab(win); addGroup(7, [tab.tabId]); await bkgd.tabGroups.sync();
    const note = tab.getNativeGroupNode();
    state.groups.delete(7); addGroup(77, [tab.tabId], { title: 'Restored' });
    bkgd.tabGroups = new TabGroups(bkgd);
    await bkgd.tabGroups.sync();
    eq(tab.getNativeGroupNode(), note); eq(note.groupId, 77); eq(note.label, 'Restored');
    eq(tree.root.findNodes(node => node.nativeGroup).length, 1);
  }));

  test('native ungroup promotes the live tab but keeps saved member history', () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win), b = await addTab(win); addGroup(7, [a.tabId, b.tabId]);
    await bkgd.tabGroups.sync(); const note = a.getNativeGroupNode();
    const saved = await addChild(a, { url: 'https://example.test/group-history' });
    await api.tabs.ungroup([a.tabId]); await bkgd.tabGroups.sync();
    eq(a.parent, win); eq(b.parent, note); eq(saved.parent, note);
  }));

  test('closed group notes keep saved members and clear only live bindings', () => fixture(async ({ bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    assert(a.shouldUnloadNotDelete());
    const oldId = a.tabId;
    await api.tabs.remove(oldId);
    await tree.onTabRemoved(oldId, { windowId: 1, isWindowClosing: false });
    await bkgd.tabGroups.sync();
    eq(tree.nodes[a.id], a); eq(a.parent, note); eq(a.loaded, false); eq(note.groupId, undefined);
    eq(a.groupId, undefined);
  }));

  test('group restore reuses one native group even when two requests overlap', () => fixture(async ({ state, bkgd, win, addTab }) => {
    const note = await addChild(win, { nativeGroup: true, label: 'Saved work', groupColor: 'purple', groupCollapsed: true, groupId: 999 });
    const a = await addTab(note), b = await addTab(note);
    a.pendingNativeGroupNodeId = note.id; b.pendingNativeGroupNodeId = note.id;
    await Promise.all([bkgd.tabGroups.restoreTab(a, await api.tabs.get(a.tabId)),
      bkgd.tabGroups.restoreTab(b, await api.tabs.get(b.tabId))]);
    eq(state.groups.size, 1); eq(a.groupId, b.groupId); assert(note.groupId !== 999);
    const native = await api.tabGroups.get(note.groupId);
    eq(native.title, 'Saved work'); eq(native.color, 'purple'); eq(native.collapsed, true);
    eq(state.calls.filter(([name, props]) => name === 'group' && props.groupId === undefined).length, 1);
  }));

  test('group-aware reorder moves blocks without destroying other groups or grouping outsiders', () => fixture(async ({ state, bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win), b = await addTab(win), outside = await addTab(win), c = await addTab(win);
    addGroup(7, [a.tabId, b.tabId]); addGroup(8, [c.tabId], { title: 'Second' });
    await bkgd.tabGroups.sync();
    const first = a.getNativeGroupNode(), second = c.getNativeGroupNode();
    await first.moveTo(win, win.nodes.length, { reason: 'test', skipTabReorder: true });
    await bkgd.tabGroups.reorder(win, win.getLoadedTabs(), 0);
    eq((await api.tabs.get(outside.tabId)).groupId, -1);
    eq((await api.tabs.get(a.tabId)).groupId, 7); eq((await api.tabs.get(b.tabId)).groupId, 7);
    eq((await api.tabs.get(c.tabId)).groupId, 8);
    eq(state.groups.size, 2); eq(first.groupId, 7); eq(second.groupId, 8);
    assert(! state.calls.some(([name, ids]) => name === 'move' && Array.isArray(ids)
      && ids.includes(a.tabId) && ids.includes(c.tabId)), 'Must never bulk-move across groups');
  }));

  test('group snapshot failure cannot strip membership from the saved tree', () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    api.tabGroups.query = async () => { throw new Error('API unavailable'); };
    let failed = false;
    try { await bkgd.tabGroups.sync(); } catch { failed = true; }
    assert(failed); eq(a.parent, note); eq(note.groupId, 7);
  }));

  test('native snapshots cannot roll back an outline group move at an await boundary', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win), b = await addTab(a);
    addGroup(7, [a.tabId, b.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    state.windows.push({ id: 2, type: 'normal', incognito: false });
    const other = await addChild(tree.root, { type: 'window', windowId: 2, loaded: true });
    const oldSyncPins = tree.syncPinnedBranchStates;
    let resume, entered;
    const paused = new Promise(resolve => { entered = resolve; });
    tree.syncPinnedBranchStates = async function (...args) {
      entered(); await new Promise(resolve => { resume = resolve; });
      return oldSyncPins.apply(this, args);
    };
    const moving = note.moveTo(other, 0, { reason: 'userAction' });
    await paused;
    eq(note.parent, other);
    eq(await bkgd.tabGroups.sync({ force: true }), false, 'Do not reconcile during the outline transition');
    eq(note.parent, other, 'Old browser snapshot must not undo user intent');
    resume(); await moving;
    tree.syncPinnedBranchStates = oldSyncPins;
    await bkgd.tabGroups.sync();
    eq((await api.tabGroups.get(7)).windowId, 2);
    eq(note.parent, other); eq(a.parent, note); eq(b.parent, a);
    eq(bkgd.tabGroups.outlineApplying, 0);
  }));

  test('a queued outline mutation invalidates an in-flight group snapshot', () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const original = api.windows.getAll;
    let release, entered;
    const paused = new Promise(resolve => { entered = resolve; });
    api.windows.getAll = async () => {
      const snapshot = await original(); entered();
      await new Promise(resolve => { release = resolve; });
      return snapshot;
    };
    const syncing = bkgd.tabGroups.sync();
    await paused;
    let ran = false;
    const moving = bkgd.tabGroups.withOutlineMutation(async () => { ran = true; });
    eq(ran, false, 'Wait for snapshot owner before modifying ancestry');
    release(); eq(await syncing, false);
    await moving; eq(ran, true); eq(bkgd.tabGroups.outlineApplying, 0);
  }));

  for (const kind of ['rename', 'collapse']) {
    test(`in-flight snapshots cannot cancel a newer group ${kind}`, () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
      const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
      const note = a.getNativeGroupNode();
      const originalWindows = api.windows.getAll, originalGet = api.tabGroups.get;
      let entered, releaseSnapshot, releaseLookup;
      const reached = new Promise(resolve => { entered = resolve; });
      const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
      const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
      // Do not let a debounce timer hide the ordering under test.
      bkgd.tabGroups.requestSync = () => {};
      api.windows.getAll = async () => {
        const snapshot = await originalWindows(); entered();
        await snapshotGate; return snapshot;
      };
      const syncing = bkgd.tabGroups.sync();
      await reached;
      api.tabGroups.get = async (...args) => {
        const result = await originalGet(...args); await lookupGate; return result;
      };
      const editing = kind === 'rename'
        ? note.setNotes('New group name', note.note, { reason: 'userAction' })
        : note.setExpanded(false, { reason: 'userAction' });
      // In the old implementation, the API update enters the lookup gate.
      // With early intent locking it waits outside the snapshot instead.
      await new Promise(resolve => setTimeout(resolve, 0));
      releaseSnapshot(); await syncing;
      releaseLookup(); await editing;
      const live = await originalGet(7);
      if (kind === 'rename') {
        eq(note.label, 'New group name'); eq(live.title, 'New group name');
      } else {
        eq(note.expanded, false); eq(live.collapsed, true);
      }
      eq(bkgd.tabGroups.outlineApplying, 0);
    }));
  }

  test('failed native metadata updates release the guard and identical edits retry', () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    bkgd.tabGroups.requestSync = () => {};
    const original = api.tabGroups.update;
    let calls = 0;
    api.tabGroups.update = async (...args) => {
      if (++calls === 1) throw new Error('Synthetic native update failure');
      return original(...args);
    };
    let failed = false;
    try { await note.setNotes('Retry name', 'note', { reason: 'userAction' }); }
    catch (err) { failed = err.message.includes('Synthetic'); }
    assert(failed); eq(bkgd.tabGroups.outlineApplying, 0);
    await note.setNotes('Retry name', 'note', { reason: 'userAction' });
    eq((await api.tabGroups.get(7)).title, 'Retry name'); eq(calls, 2);
    const first = note.setNotes('First', 'note', { reason: 'userAction' });
    const second = note.setExpanded(false, { reason: 'userAction' });
    const last = note.setNotes('Last', 'note', { reason: 'userAction' });
    await Promise.all([first, second, last]);
    const live = await api.tabGroups.get(7);
    eq(live.title, 'Last'); eq(live.collapsed, true);
    eq(note.label, 'Last'); eq(note.expanded, false);
    eq(bkgd.tabGroups.outlineApplying, 0);
  }));

  test('outline moves and one-field edits preserve unrelated newer native group metadata', () => fixture(async ({ bkgd, win, addTab, addGroup }) => {
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    bkgd.tabGroups.requestSync = () => {};
    // A native rename/color update has happened but its notification has not
    // reached the outline. Reordering is not permission to overwrite it.
    await api.tabGroups.update(7, { title: 'Native rename', color: 'red' });
    await bkgd.tabGroups.reorder(win, win.getLoadedTabs(), 0);
    eq((await api.tabGroups.get(7)).title, 'Native rename');
    eq(note.label, 'Native rename'); eq(note.groupColor, 'red');
    await api.tabGroups.update(7, { title: 'Another native rename', color: 'green' });
    await note.setExpanded(false, { reason: 'userAction' });
    const collapsed = await api.tabGroups.get(7);
    eq(collapsed.collapsed, true); eq(collapsed.title, 'Another native rename');
    eq(collapsed.color, 'green');
    // Conversely, changing the name must not revert a newer native collapse.
    await api.tabGroups.update(7, { collapsed: false });
    await note.setNotes('Outline rename', note.note, { reason: 'userAction' });
    const renamed = await api.tabGroups.get(7);
    eq(renamed.title, 'Outline rename'); eq(renamed.collapsed, false);
    eq(renamed.color, 'green'); eq(note.expanded, true);
  }));

  test('moving a group into a provisional live window does not create another window', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win), b = await addTab(a);
    addGroup(7, [a.tabId, b.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    state.windows.push({ id: 2, type: 'normal', incognito: false });
    // Firefox can deliver onTabCreated first, creating this provisional
    // outline window before onWindowCreated marks it loaded.
    const other = await addChild(tree.root, {
      type: 'window', windowId: 2, loaded: false
    });
    let creates = 0;
    api.windows.create = async () => {
      creates++;
      throw new Error('Must reuse the already existing browser window');
    };
    await note.moveTo(other, 0, { reason: 'userAction' });
    eq(creates, 0, 'Do not move the first member through a spurious new window');
    eq(other.loaded, true); eq(other.windowId, 2);
    eq((await api.tabGroups.get(7)).windowId, 2);
    eq(note.groupId, 7); eq(a.parent, note); eq(b.parent, a);
    eq(state.groups.size, 1); eq(bkgd.windowsLoading.length, 0);
  }));

  test('a delayed reorder never pulls a natively moved group back to its old window', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win), b = await addTab(a);
    addGroup(7, [a.tabId, b.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    state.windows.push({ id: 2, type: 'normal', incognito: false });
    const other = await addChild(tree.root, { type: 'window', windowId: 2, loaded: true });
    await api.tabGroups.move(7, { windowId: 2, index: 0 });
    // Simulate a reorder queued before the native move's events can update
    // the outline. The stale tree still places the complete group in win.
    await bkgd.tabGroups.reorder(win, win.getLoadedTabs(), 0);
    eq((await api.tabGroups.get(7)).windowId, 2, 'Stale reorder must not reverse native movement');
    await bkgd.tabGroups.sync();
    eq(note.parent, other); eq(a.parent, note); eq(b.parent, a);
  }));

  test('unscoped container imports cannot borrow a same-numbered local identity', () => fixture(async ({ state, bkgd, tree, win }) => {
    const id = 'firefox-container-1';
    state.identities.set(id, { cookieStoreId: id, name: 'Different local account', color: 'blue', icon: 'circle' });
    const node = await addChild(win, { url: 'https://example.test/account', cookieStoreId: id, containerName: 'Unknown origin' });
    await bkgd.containers.refresh();
    eq(node.containerProfileId, undefined); eq(node.containerName, 'Unknown origin');
    eq(node.containerMissing, true);
    eq(tree.browserTabContextMatches(node, { cookieStoreId: id }), false);
    eq(tree.browserTabContextMatches(node, { cookieStoreId: id }, true), true);
    let creates = 0;
    api.tabs.create = async () => { creates++; return {}; };
    const result = await bkgd.bkgd_loadSavedNode({ nodeId: node.id });
    assert(result.error); eq(creates, 0); assert(node.restoreError.includes('unknown'));
  }));

  test('missed cross-window group events preserve live and saved ancestry during recovery', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const { runReconcile } = await import('/bkgd/reconcile.js');
    const a = await addTab(win), b = await addTab(a);
    addGroup(7, [a.tabId, b.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    const saved = await addChild(a, { url: 'https://example.test/saved', wasLoaded: true,
      cookieStoreId: 'firefox-container-9', containerProfileId: 'test-profile' });
    const annotation = await addChild(saved, { label: 'Retain this annotation' });
    const outside = await addTab(win);
    state.windows.push({ id: 2, type: 'normal', incognito: false });
    const other = await addChild(tree.root, { type: 'window', windowId: 2, loaded: true });
    await api.tabGroups.move(7, { windowId: 2, index: 0 });
    await runReconcile.call(bkgd, { reason: 'alarm' });
    eq(note.parent, other); eq(a.parent, note); eq(b.parent, a);
    eq(saved.parent, a); eq(saved.getNativeGroupNode(), note);
    eq(annotation.parent, saved); eq(outside.parent, win);
    eq(saved.cookieStoreId, 'firefox-container-9');
    eq(saved.containerProfileId, 'test-profile'); eq(note.groupId, 7);
    await runReconcile.call(bkgd, { reason: 'alarm' });
    eq(saved.parent, a); eq(state.groups.size, 1);
    eq(tree.root.findNodes(node => node.nativeGroup).length, 1);
  }));

  test('recovery refuses to flatten groups when native metadata is unavailable or inconsistent', () => fixture(async ({ state, bkgd, tree, win, addTab, addGroup }) => {
    const { runReconcile } = await import('/bkgd/reconcile.js');
    const a = await addTab(win); addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    const saved = await addChild(a, { url: 'https://example.test/saved' });
    state.windows.push({ id: 2, type: 'normal', incognito: false });
    await addChild(tree.root, { type: 'window', windowId: 2, loaded: true });
    await api.tabGroups.move(7, { windowId: 2, index: 0 });
    const query = api.tabGroups.query;
    api.tabGroups.query = async () => { throw new Error('Synthetic group snapshot failure'); };
    const before = JSON.stringify(tree.serializeNodes());
    const oldWarn = console.warn;
    try {
      console.warn = () => {};
      eq(await runReconcile.call(bkgd, { reason: 'alarm' }), null);
      eq(JSON.stringify(tree.serializeNodes()), before);
      // The two native API queries can straddle a browser-native move.
      api.tabGroups.query = async () => [{ ...(await api.tabGroups.get(7)), windowId: 1 }];
      eq(await runReconcile.call(bkgd, { reason: 'alarm' }), null);
      eq(JSON.stringify(tree.serializeNodes()), before);
    } finally { console.warn = oldWarn; api.tabGroups.query = query; }
    await runReconcile.call(bkgd, { reason: 'alarm' });
    eq(saved.parent, a); eq(a.parent, note); eq(note.getWindowNode().windowId, 2);
  }));

  test('backups retain container scope and group metadata but discard native binding IDs', () => fixture(async ({ bkgd, tree, win, addTab, addGroup }) => {
    const a = await addTab(win, { cookieStoreId: 'firefox-container-1', containerProfileId: 'test-profile' });
    addGroup(7, [a.tabId]); await bkgd.tabGroups.sync();
    const note = a.getNativeGroupNode();
    const backup = tree.serializeNodes(true);
    eq(backup[a.id].cookieStoreId, 'firefox-container-1');
    eq(backup[a.id].containerProfileId, 'test-profile');
    eq(backup[note.id].nativeGroup, true); eq(backup[note.id].groupColor, 'blue');
    for (const item of Object.values(backup)) {
      assert(! Object.hasOwn(item, 'groupId')); assert(! Object.hasOwn(item, 'groupWindowId'));
      assert(! Object.hasOwn(item, 'tabId')); assert(! Object.hasOwn(item, 'windowId'));
    }
  }));
}
