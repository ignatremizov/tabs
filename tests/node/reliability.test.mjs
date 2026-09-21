// Reliability regressions for storage, recovery, and independently held views.
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

export async function registerReliabilityTests(h) {
  const { test, assert, assertEqual: eq, api, emit, Bkgd, Tree, TreeStore,
    NodeStore, TreeView, addChild } = h;
  const waitFor = async (check) => {
    const until = Date.now() + 3000;
    while (! check()) {
      if (Date.now() > until) throw new Error('Timed out waiting for view convergence');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const store = () => {
    const bkgd = new Bkgd();
    let id = 0;
    bkgd.idGen = { newId: () => `reliability-${++id}` };
    const tree = new Tree(NodeStore);
    tree.bkgd = bkgd; bkgd.tree = tree;
    tree.runPersistenceBatch = TreeStore.prototype.runPersistenceBatch.bind(tree);
    tree.resolveTreeLoaded(); bkgd.resolveTreeLoaded();
    tree.reorderTabsOnCreate = false;
    const records = new Map();
    tree.db = { writeNodes: async (nodes, deletes = []) => {
      const snapshots = nodes.map(node => structuredClone(node.toDict()));
      for (const node of snapshots) records.set(node.id, node);
      for (const id of deletes) records.delete(id);
    } };
    return { tree, bkgd, records };
  };
  const makeView = tree => {
    const view = new TreeView({ isInert: true });
    view.resolveTreeLoaded(); view.resolveTreeViewLoaded();
    view.replaceSerializedTree(JSON.stringify(tree.serializeNodes()));
    view.viewRoot = view.root; view.viewScope = 'session'; view.windowId = 1;
    view.$treeRoot = {}; view.$ = { scrollTop: 333 };
    view.updateMarkedCount = () => {};
    view.draws = [];
    view.$renderWholeTree = function () {
      this.viewRoot = this.root;
      this.draws.push(Object.values(this.nodes).map(node => node.title));
    };
    view.setCursor = async function (node) { this.cursor = node; };
    return view;
  };
  async function messaging(run) {
    const before = { send: api.runtime.sendMessage, disabled: emit.disabled, isBkgd: emit.isBkgd };
    emit.disabled = false; emit.isBkgd = false;
    try { await run(); }
    finally {
      api.runtime.sendMessage = before.send;
      emit.disabled = before.disabled; emit.isBkgd = before.isBkgd;
    }
  }

  test('reconciliation resynchronizes two views and preserves local presentation', () => messaging(async () => {
    const { tree, bkgd } = store();
    bkgd.containers = null; bkgd.tabGroups = null;
    const win = await addChild(tree.root, { type: 'window', windowId: 1, loaded: true });
    const tab = await addChild(win, { tabId: 21, windowId: 1, loaded: true,
      url: 'https://example.test/account', title: 'Old title', marked: true, pinned: false });
    const views = [makeView(tree), makeView(tree)];
    for (const view of views) {
      view.cursor = view.nodes[tab.id];
      view.expandOverrides[tab.id] = view.cursor;
    }
    const oldWindows = api.windows.getAll;
    const deliveries = [];
    api.windows.getAll = async () => [{ id: 1, tabs: [{ id: 21, windowId: 1, index: 0,
      pinned: false, url: tab.url, title: 'Repaired title' }] }];
    api.runtime.sendMessage = async msg => {
      if (msg.msg === 'bkgd_getTree') return bkgd.bkgd_getTree(msg);
      for (const view of views) deliveries.push(view.onMessage({ ...msg, sourceId: 'background-test' }));
      return {};
    };
    try {
      const { runReconcile } = await import('/bkgd/reconcile.js');
      await runReconcile.call(bkgd, { reason: 'alarm' });
      await Promise.all(deliveries);
      await waitFor(() => views.every(view => ! view.resyncTask && ! view.resyncTimer));
      for (const view of views) {
        eq(view.nodes[tab.id].title, 'Repaired title');
        eq(view.cursor.id, tab.id); eq(view.$.scrollTop, 333);
        eq(view.expandOverrides[tab.id], view.nodes[tab.id]);
        eq(view.markedNodes.length, 1);
      }
      await tab.deleteSelf({ reason: 'test' });
      for (const view of views) view.requestTreeResync();
      await waitFor(() => views.every(view => ! view.resyncTask && ! view.resyncTimer));
      for (const view of views) {
        eq(view.nodes[tab.id], undefined); eq(view.cursor.id, win.id);
        eq(view.markedNodes.length, 0); eq(Object.keys(view.expandOverrides).length, 0);
        eq(view.$.scrollTop, 333);
      }
    } finally { api.windows.getAll = oldWindows; views.forEach(view => view.destroy()); }
  }));

  test('a delta during snapshot fetch discards the stale read and coalesces refreshes', () => messaging(async () => {
    const { tree, bkgd } = store();
    const node = await addChild(tree.root, { title: 'Before', label: 'A note' });
    const view = makeView(tree);
    let release, entered, reads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    api.runtime.sendMessage = async msg => {
      if (msg.msg !== 'bkgd_getTree') return {};
      const snapshot = await bkgd.bkgd_getTree(msg);
      if (++reads === 1) { entered(); await gate; }
      return snapshot;
    };
    try {
      view.requestTreeResync(); await reached;
      for (let i = 0; i < 10; i++) view.tree_refreshAll({});
      node.title = 'After';
      await view.onMessage({ msg: 'tree_nodeChanged', sourceId: 'other',
        nodeId: node.id, type: 'setTabFields', changes: { title: 'After' } });
      release();
      await waitFor(() => ! view.resyncTask && ! view.resyncTimer);
      eq(view.nodes[node.id].title, 'After'); eq(reads, 2);
      assert(! view.draws.some(titles => titles.includes('Before')),
        'The superseded snapshot must never be rendered');
    } finally { release(); view.destroy(); }
  }));

  test('snapshot recovery waits for active local actions without holding a view lock', () => messaging(async () => {
    const { tree, bkgd } = store();
    const node = await addChild(tree.root, { label: 'Before' });
    const view = makeView(tree);
    let release, reads = 0;
    const gate = new Promise(resolve => { release = resolve; });
    api.runtime.sendMessage = async msg => { reads++; return bkgd.bkgd_getTree(msg); };
    try {
      const action = view.runUiAction('Synthetic edit', async () => {
        await gate; node.label = 'After';
      });
      view.requestTreeResync(); eq(reads, 0);
      release(); await action;
      await waitFor(() => ! view.resyncTask && ! view.resyncTimer);
      eq(view.nodes[node.id].label, 'After'); eq(reads, 1);
    } finally { release(); view.destroy(); }
  }));

  test('background snapshots wait for an earlier view mutation to finish', async () => {
    const { tree, bkgd } = store();
    const node = await addChild(tree.root, { label: 'Before' });
    const unlock = await tree.onMessageMutex.lock();
    let resolved = false;
    const pending = bkgd.bkgd_getTree({}).then(value => { resolved = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 0)); eq(resolved, false);
    node.label = 'After'; unlock();
    eq(JSON.parse(await pending)[node.id].label, 'After');
  });
  test('failed note persistence is retried even when the value is unchanged', async () => {
    const { tree, records } = store();
    const node = await addChild(tree.root, { label: 'Before', note: 'Original' });
    const write = tree.db.writeNodes;
    let calls = 0;
    tree.db.writeNodes = async (...args) => {
      if (++calls === 1) throw new Error('Synthetic disk failure');
      return write(...args);
    };
    let failed = false;
    try { await node.setNotes('After', 'Updated', { reason: 'tree_nodeChanged' }); }
    catch { failed = true; }
    assert(failed); eq(records.get(node.id).note, 'Original');
    eq(tree.root.getPersistenceState().unsaved, true);
    await node.setNotes('After', 'Updated', { reason: 'tree_nodeChanged' });
    eq(calls, 2); eq(records.get(node.id).note, 'Updated');
    eq(tree.root.getPersistenceState().unsaved, false);
  });

  test('a later independent mutation flushes the complete failed batch', async () => {
    const { tree, records } = store();
    const a = await addChild(tree.root, { label: 'A' });
    const b = await addChild(tree.root, { label: 'B' });
    const write = tree.db.writeNodes;
    tree.db.writeNodes = async () => { throw new Error('Synthetic disk failure'); };
    try { await a.setNotes('Edited A', '', { reason: 'test' }); } catch {}
    tree.db.writeNodes = write;
    await b.setNotes('Edited B', '', { reason: 'test' });
    eq(records.get(a.id).label, 'Edited A'); eq(records.get(b.id).label, 'Edited B');
    eq(tree.root.getPersistenceState().pending, 0);
  });

  test('failed deletion retries retain tombstones and never resurrect stale node references', async () => {
    const { tree, bkgd, records } = store();
    const node = await addChild(tree.root, { label: 'Delete me' });
    const write = tree.db.writeNodes;
    tree.db.writeNodes = async () => { throw new Error('Synthetic delete failure'); };
    try { await node.deleteSelf({ reason: 'test' }); } catch {}
    assert(records.has(node.id)); eq(tree.nodes[node.id], undefined);
    tree.db.writeNodes = write;
    // A delayed callback still holding this object must not recreate it.
    await node.persistWithLock([node]);
    await bkgd.bkgd_retryPersistence();
    eq(records.has(node.id), false);
    eq(records.get('root').nodes.includes(node.id), false);
    eq(tree.root.getPersistenceState().unsaved, false);
  });

  test('unchanged view edits offer a real durability retry and new views can read the warning', () => messaging(async () => {
    const { tree, bkgd, records } = store();
    const node = await addChild(tree.root, { label: 'Before', note: 'Old' });
    const write = tree.db.writeNodes;
    tree.db.writeNodes = async () => { throw new Error('Synthetic failure'); };
    try { await node.setNotes('After', 'New', { reason: 'test' }); } catch {}
    const view = makeView(tree);
    api.runtime.sendMessage = async msg => {
      if (msg.msg === 'bkgd_getPersistenceState') return bkgd.bkgd_getPersistenceState();
      if (msg.msg === 'bkgd_retryPersistence') return bkgd.bkgd_retryPersistence();
      return {};
    };
    try {
      await view.refreshPersistenceState(); eq(view.persistenceState.unsaved, true);
      tree.db.writeNodes = write;
      await view.nodes[node.id].setNotes('After', 'New', { reason: 'userAction' });
      eq(records.get(node.id).note, 'New'); eq(view.persistenceState.unsaved, false);
    } finally { view.destroy(); }
  }));

  test('cached completed commands retry durability without replaying their side effects', async () => {
    const { tree, bkgd } = store();
    const node = await addChild(tree.root, { label: 'Before' });
    const write = tree.db.writeNodes;
    tree.db.writeNodes = async () => { throw new Error('Synthetic failure'); };
    try { await node.setNotes('After', '', { reason: 'test' }); } catch {}
    let commands = 0;
    bkgd.bkgd_testOnce = async () => { commands++; return { result: 'done' }; };
    const msg = { msg: 'bkgd_testOnce', sourceId: 'client', requestId: 'same-request' };
    try { await bkgd.onBkgdMessage(msg, {}, () => {}); } catch {}
    eq(commands, 1);
    tree.db.writeNodes = write;
    let response;
    await bkgd.onBkgdMessage(msg, {}, value => { response = value; });
    eq(commands, 1); eq(response.result, 'done');
    eq(tree.root.getPersistenceState().pending, 0);
    let rejected = 0;
    bkgd.bkgd_testFailure = async () => {
      if (++rejected === 1) throw new Error('Synthetic command failure');
      return { result: 'retry succeeded' };
    };
    const retry = { ...msg, msg: 'bkgd_testFailure' };
    try { await bkgd.onBkgdMessage(retry, {}, () => {}); } catch {}
    await bkgd.onBkgdMessage(retry, {}, value => { response = value; });
    eq(rejected, 2); eq(response.result, 'retry succeeded');
  });

  test('a successful older write cannot clear a newer pending generation', async () => {
    const { tree, records } = store();
    const node = await addChild(tree.root, { label: 'Initial' });
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    tree.db.writeNodes = async (nodes) => {
      const snapshots = nodes.map(node => structuredClone(node.toDict()));
      if (++writes === 1) { entered(); await gate; }
      else if (writes === 2) throw new Error('Newer write failed');
      for (const snapshot of snapshots) records.set(snapshot.id, snapshot);
    };
    const first = node.setNotes('First', '', { reason: 'test' });
    await reached;
    const second = node.setNotes('Second', '', { reason: 'test' });
    const settledSecond = second.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    release(); await first; await settledSecond;
    eq(records.get(node.id).label, 'First');
    eq(tree.root.getPersistenceState().unsaved, true);
    await tree.root.flushPendingPersistence();
    eq(records.get(node.id).label, 'Second');
    eq(tree.root.getPersistenceState().unsaved, false);
  });

}
