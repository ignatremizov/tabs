// Reliability regressions for storage, recovery, and independently held views.
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

export async function registerReliabilityTests(h) {
  const { test, assert, assertEqual: eq, api, emit, Bkgd, Tree, TreeStore,
    NodeStore, TreeView, addChild, jsonSchema, IDB } = h;
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

  const validBackup = () => ({ $schema: jsonSchema, metadata: { exportDate: 2, sessionStartDate: 1 },
    nodes: { root: { id: 'root', nodes: ['child'], label: 'Imported', ctime: 1 },
      child: { id: 'child', label: 'Пример', note: 'Notes', url: 'https://example.test/account', nodes: [],
        cookieStoreId: 'firefox-container-7', containerProfileId: 'foreign-profile',
        loaded: true, active: true, tabId: 43, windowId: 5, groupId: 8 } } });

  test('reserved fields and invalid import values are rejected without changing live or durable data', async () => {
    const { tree, bkgd, records } = store();
    await addChild(tree.root, { label: 'Keep me' });
    const memory = JSON.stringify(tree.serializeNodes());
    const disk = JSON.stringify([...records]);
    const cases = [ ['toDict', null], ['constructor', {}], ['__proto__', {}], ['tree', {}],
      ['note', {}], ['url', []], ['loaded', 'true'], ['geometry', [1,2,3]],
      ['nodes', [123]], ['id', 'mismatched'], ['mtime', Infinity], ['pointer', 0.5] ];
    const oldError = console.error;
    try {
      console.error = () => {};
      for (const [field, value] of cases) {
        const backup = validBackup();
        Object.defineProperty(backup.nodes.child, field, { value, enumerable: true, configurable: true });
        const response = await bkgd.bkgd_importBackupFile({ data: backup, filename: 'invalid.json' });
        assert(response.error, `Accepted invalid field ${field}`); eq(response.total, 0);
        eq(JSON.stringify(tree.serializeNodes()), memory);
        eq(JSON.stringify([...records]), disk);
        assert(tree.makeBackupObject(tree.root).nodes.root, 'Rejected import broke later backup');
        eq(tree.root.getPersistenceState().pending, 0);
      }
    } finally { console.error = oldError; }
  });

  test('valid imported metadata is preserved but browser IDs cannot leak into live bindings', async () => {
    const { tree, bkgd, records } = store();
    const backup = validBackup();
    backup.nodes.root.nodes = ['group'];
    backup.nodes.group = { id: 'group', nodes: ['child'], nativeGroup: true,
      label: 'Research', groupTitle: 'Research', groupColor: 'green', groupCollapsed: true,
      expanded: false, groupId: 8, groupWindowId: 5 };
    const before = JSON.stringify(backup);
    const response = await bkgd.bkgd_importBackupFile({ data: backup, filename: 'valid.json' });
    eq(response.error, undefined); eq(response.total, 2); eq(JSON.stringify(backup), before);
    const imported = tree.root.nodes[0], group = imported.nodes[0], child = group.nodes[0];
    eq(group.nativeGroup, true); eq(group.groupColor, 'green'); eq(group.groupId, undefined);
    eq(group.groupCollapsed, true); eq(child.label, 'Пример'); eq(child.note, 'Notes');
    eq(child.cookieStoreId, 'firefox-container-7'); eq(child.containerProfileId, 'foreign-profile');
    eq(child.loaded, false); eq(child.active, false); eq(child.wasLoaded, true);
    eq(child.tabId, undefined); eq(child.windowId, undefined);
    eq(records.get(child.id).parent, group.id);
    eq(imported.expanded, false); eq(tree.root.ctime, 1);
  });

  test('failed atomic imports publish nothing and a later clean import succeeds once', async () => {
    const { tree, bkgd, records } = store();
    await addChild(tree.root, { label: 'Keep me' });
    const memory = JSON.stringify(tree.serializeNodes()), disk = JSON.stringify([...records]);
    const write = tree.db.writeNodes;
    let writes = 0;
    tree.db.writeNodes = async (...args) => {
      if (++writes === 1) throw new Error('Synthetic import transaction failure');
      return write(...args);
    };
    const oldError = console.error;
    try {
      console.error = () => {};
      const failed = await bkgd.bkgd_importBackupFile({ data: validBackup(), filename: 'retry.json' });
      assert(failed.error); eq(failed.total, 0);
      eq(JSON.stringify(tree.serializeNodes()), memory); eq(JSON.stringify([...records]), disk);
      eq(tree.root.getPersistenceState().pending, 0);
      const done = await bkgd.bkgd_importBackupFile({ data: validBackup(), filename: 'retry.json' });
      eq(done.error, undefined); eq(done.total, 1); eq(writes, 2);
      eq(tree.root.nodes.length, 2); eq(records.size, 4);
    } finally { console.error = oldError; }
  });

  test('an import committing alongside another root mutation retains both changes', async () => {
    const { tree, bkgd, records } = store();
    await addChild(tree.root, { label: 'Original' });
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    tree.db.writeNodes = async (nodes, deletes = []) => {
      const snapshots = nodes.map(node => structuredClone(node.toDict()));
      if (++writes === 1) { entered(); await gate; }
      for (const record of snapshots) records.set(record.id, record);
      for (const id of deletes) records.delete(id);
    };
    const importing = bkgd.bkgd_importBackupFile({ data: validBackup(), filename: 'concurrent.json' });
    await reached;
    const adding = addChild(tree.root, { label: 'Concurrent note' });
    await new Promise(resolve => setTimeout(resolve, 0));
    release(); const [response, concurrent] = await Promise.all([importing, adding]);
    eq(response.error, undefined);
    eq(tree.root.nodes.length, 3); assert(tree.root.nodes.includes(concurrent));
    eq(JSON.stringify(records.get('root').nodes), JSON.stringify(tree.root.nodes.map(node => node.id)));
    eq(records.get(concurrent.id).label, 'Concurrent note');
  });

  test('import graph sanitation preserves disconnected data and reports skipped edges', async () => {
    const { tree, bkgd } = store();
    const data = validBackup();
    data.nodes.root.nodes.push('child', 'missing');
    data.nodes.child.nodes = ['root'];
    data.nodes.detached = { id: 'detached', label: 'Recovered note', nodes: [] };
    const result = await bkgd.bkgd_importBackupFile({ data, filename: 'recover.json' });
    eq(result.error, undefined); eq(result.total, 2);
    assert(result.warnings.length >= 3);
    const imported = tree.root.nodes[0];
    eq(imported.nodes.length, 2); eq(imported.nodes[0].nodes.length, 0);
    eq(imported.nodes[1].label, 'Recovered note');
  });

  test('excessive import depth is rejected before live reconstruction', async () => {
    const { tree, bkgd } = store();
    const { treeDataLimits } = await import('/common/serialized-tree.js');
    const data = { $schema: jsonSchema, nodes: { root: { nodes: ['n0'] } } };
    for (let i = 0; i <= treeDataLimits.depth; i++) {
      data.nodes[`n${i}`] = { nodes: i < treeDataLimits.depth ? [`n${i+1}`] : [] };
    }
    const oldError = console.error;
    try {
      console.error = () => {};
      const result = await bkgd.bkgd_importBackupFile({ data, filename: 'deep.json' });
      assert(result.error.includes('depth')); eq(tree.root.nodes.length, 0);
    } finally { console.error = oldError; }
  });

  test('invalid stored graphs fail before altering the current model or writing recovery data', async () => {
    const { tree } = store();
    await addChild(tree.root, { label: 'Existing safe state' });
    const before = JSON.stringify(tree.serializeNodes());
    const valid = { root: { id: 'root', nodes: ['a'] }, a: { id: 'a', parent: 'root', nodes: [] } };
    const variants = [];
    const cyclic = structuredClone(valid); cyclic.a.nodes = ['a']; variants.push(cyclic);
    const rootCycle = structuredClone(valid); rootCycle.a.nodes = ['root']; variants.push(rootCycle);
    const missing = structuredClone(valid); missing.root.nodes = ['missing']; variants.push(missing);
    const duplicate = structuredClone(valid); duplicate.root.nodes = ['a', 'a']; variants.push(duplicate);
    const disagree = structuredClone(valid); disagree.a.parent = 'other'; variants.push(disagree);
    const orphan = structuredClone(valid); orphan.other = { id: 'other', nodes: [] }; variants.push(orphan);
    const identity = structuredClone(valid); identity.a.id = 'wrong'; variants.push(identity);
    const fields = structuredClone(valid); fields.a.toDict = null; variants.push(fields);
    variants.push({ a: valid.a });
    let writes = 0;
    tree.db.writeNodes = async () => { writes++; };
    for (const data of variants) {
      const original = JSON.stringify(data);
      tree.db.loadAllNodes = async () => data;
      let failure;
      try { await TreeStore.prototype.loadTreeFromDB.call(tree); }
      catch (err) { failure = err; }
      assert(failure instanceof TypeError, 'Invalid storage must produce a bounded validation error');
      assert(! (failure instanceof RangeError));
      eq(JSON.stringify(tree.serializeNodes()), before);
      eq(JSON.stringify(data), original); eq(writes, 0);
    }
  });

  test('bounded iterative reconstruction accepts deep valid data and rejects excessive depth atomically', async () => {
    const { tree } = store();
    const { treeDataLimits } = await import('/common/serialized-tree.js');
    const hash = { root: { id: 'root', nodes: ['n0'] } };
    for (let i = 0; i < treeDataLimits.depth; i++) {
      hash[`n${i}`] = { id: `n${i}`, parent: i ? `n${i-1}` : 'root',
        nodes: i + 1 < treeDataLimits.depth ? [`n${i+1}`] : [] };
    }
    eq(tree.rebuildNodeFromSerializedHash(tree.root, hash), treeDataLimits.depth + 1);
    const last = tree.nodes[`n${treeDataLimits.depth - 1}`];
    eq(last.parent.id, `n${treeDataLimits.depth - 2}`);
    hash[last.id].nodes.push('too-deep'); hash['too-deep'] = { id: 'too-deep', nodes: [] };
    let failure;
    try { tree.rebuildNodeFromSerializedHash(tree.root, hash); } catch (err) { failure = err; }
    assert(failure?.message.includes('depth')); eq(tree.nodes[last.id], last);
    eq(tree.nodes['too-deep'], undefined);
  });

  test('invalid replacement snapshots preserve the previous view and mark caches', async () => {
    const { tree } = store();
    const node = await addChild(tree.root, { label: 'Safe', marked: true });
    const view = makeView(tree);
    const old = view.nodes[node.id];
    try {
      let failed = false;
      try { view.replaceSerializedTree(JSON.stringify({ root: { nodes: ['root'] } })); }
      catch { failed = true; }
      assert(failed); eq(view.nodes[node.id], old); eq(view.markedNodes.length, 1);
    } finally { view.destroy(); }
  });

  test('raw recovery export preserves malformed JSON and never writes or clears storage', async () => {
    const idb = new IDB();
    const records = [ { key: 'root', data: JSON.stringify({ id: 'root', nodes: [] }) },
      { key: 'bad', data: '{malformed original data' } ];
    const before = JSON.stringify(records);
    idb.db = Promise.resolve({ transaction: (name, mode) => {
      eq(mode, 'readonly');
      return { objectStore: () => ({ openCursor: () => {
        const request = {}; let position = 0;
        const next = () => queueMicrotask(() => {
          const value = records[position++];
          request.onsuccess({ target: { result: value ? {
            primaryKey: value.key, value, continue: next
          } : null } });
        });
        next(); return request;
      } }) };
    } });
    let rejected = false;
    try { await idb.loadAllNodes(); } catch (err) { rejected = err instanceof SyntaxError; }
    assert(rejected);
    const bkgd = new Bkgd(); bkgd.tree = { db: idb };
    const oldError = console.error;
    try {
      console.error = () => {};
      bkgd.failInitialization(new Error('Synthetic invalid storage'));
      const readiness = await Promise.allSettled([bkgd.treeLoaded, bkgd.configLoaded]);
      assert(readiness.every(result => result.status === 'rejected'));
      const state = bkgd.bkgd_getStartupState();
      eq(state.canExport, true); eq(state.failure, 'Synthetic invalid storage');
      const result = JSON.parse((await bkgd.bkgd_getRecoveryData()).data);
      eq(result.records.length, 2);
      eq(result.records[1].value.data, records[1].data);
      eq(JSON.stringify(records), before);
    } finally { console.error = oldError; }
  });

  test('background initialization errors reject readiness instead of leaving requests pending', async () => {
    const bkgd = new Bkgd();
    for (const method of ['initConnectListener', 'initMessageListener', 'initWindowListeners',
      'initTabListeners', 'initContextListeners', 'initMiscListeners']) bkgd[method] = () => {};
    bkgd.initConfig = async () => { throw new Error('Synthetic configuration failure'); };
    const oldError = console.error, oldBackground = emit.isBkgd, oldBkgd = emit.bkgd;
    try {
      console.error = () => {};
      bkgd.init(); await bkgd.initialization;
      const result = await Promise.allSettled([bkgd.configLoaded, bkgd.treeLoaded, bkgd.bkgd_getTree({})]);
      assert(result.every(item => item.status === 'rejected'));
      eq(bkgd.bkgd_getStartupState().canExport, false);
      assert(bkgd.startupError.includes('configuration'));
    } finally { console.error = oldError; emit.isBkgd = oldBackground; emit.bkgd = oldBkgd; }
  });

  test('raw recovery downloads bypass failed readiness without advancing normal backup timestamps', async () => {
    const { tree } = store();
    tree.bkgd = null;
    tree.treeLoaded = Promise.reject(new Error('Synthetic startup failure'));
    tree.treeLoaded.catch(() => {});
    const previous = api.downloads;
    const listeners = new Set();
    let filename, timestamps = 0;
    tree.cfg.set = async () => { timestamps++; };
    api.downloads = {
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      download: async options => {
        filename = options.filename;
        // Completion can precede the creation response.
        for (const fn of listeners) fn({ id: 42, state: { current: 'complete' } });
        return 42;
      }
    };
    try {
      assert(await tree.downloadBackupNow({ recoveryData: '{"raw":"preserved"}' }));
      assert(filename.startsWith('tktsto-recovery.'));
      eq(timestamps, 0); eq(listeners.size, 0); eq(tree.localBackupInProgress, false);
    } finally { api.downloads = previous; }
  });

  test('custom checkbox symbols and labels survive import and stored-model validation', async () => {
    const { tree, bkgd } = store();
    const { validateNodeGraph } = await import('/common/serialized-tree.js');
    for (const checkbox of ['🔒', 'TODO', '✓', '/', '%']) {
      const data = validBackup();
      data.nodes.child.checkbox = checkbox;
      data.nodes.child.checkboxPx = 0.5;
      const result = await bkgd.bkgd_importBackupFile({ data, filename: 'checkbox.json' });
      eq(result.error, undefined);
      eq(tree.root.nodes.at(-1).nodes[0].checkbox, checkbox);
    }
    const graph = validateNodeGraph(tree.serializeNodes());
    eq(graph.order.length, Object.keys(tree.nodes).length);
  });

  test('generated import headers cannot push accepted data beyond startup limits', async () => {
    const { tree, bkgd, records } = store();
    const { treeDataLimits } = await import('/common/serialized-tree.js');
    const data = validBackup();
    data.nodes.root.note = 'x'.repeat(treeDataLimits.fieldLength);
    const oldError = console.error;
    try {
      console.error = () => {};
      const result = await bkgd.bkgd_importBackupFile({ data, filename: 'large-note.json' });
      assert(result.error?.includes('text field note'));
      eq(tree.root.nodes.length, 0); eq(records.size, 0);
      eq(data.nodes.root.note.length, treeDataLimits.fieldLength);
    } finally { console.error = oldError; }
  });

  test('untrusted field names produce bounded validation diagnostics', async () => {
    const { validateNodeGraph } = await import('/common/serialized-tree.js');
    const data = validBackup();
    data.nodes.child['z'.repeat(5000)] = null;
    let error;
    try { validateNodeGraph(data.nodes); } catch (err) { error = err; }
    assert(error instanceof TypeError); assert(error.message.length < 550);
  });

}
