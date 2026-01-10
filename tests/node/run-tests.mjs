// tests/node/run-tests.mjs: Node-based test runner for core modules
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

globalThis.__TKTSTO_TEST__ = true;
globalThis.__TKTSTO_TEST_QUIET__ = !process.env.TKTSTO_TEST_VERBOSE;

if (!globalThis.chrome) {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: () => {} },
      onConnect: { addListener: () => {} }
    },
    tabs: {
      get: async () => ({}),
      move: async () => ({})
    },
    windows: {
      getAll: async () => ([]),
      get: async () => ({})
    },
    storage: {
      local: { get: async () => ({}), set: async () => ({}) },
      onChanged: { addListener: () => {} }
    },
    commands: { onCommand: { addListener: () => {} } },
    alarms: {
      onAlarm: { addListener: () => {} },
      get: async () => null,
      clear: async () => {},
      create: async () => {}
    },
    sidePanel: { setPanelBehavior: async () => {} }
  };
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected "${expected}" but got "${actual}"`);
  }
}

let api;
let emit;
let Bkgd;
let Tree;
let TreeStore;
let Node;
let OpsQueue;
let runReconcile;
let TestNode;

function createTree(bkgd) {
  const tree = new Tree(TestNode);
  tree.nextId = 0;
  tree.bkgd = bkgd;
  return tree;
}

async function addChild(parent, details) {
  const index = parent.nodes.length;
  return await parent.addChild(index, details, { reason: 'test' });
}

class FakeOpsDb {
  constructor () {
    this.ops = new Map();
  }

  async enqueueOp (op) {
    this.ops.set(op.opId, { ...op });
  }

  async loadOp (opId) {
    const op = this.ops.get(opId);
    return op ? { ...op } : null;
  }

  async saveOp (op) {
    this.ops.set(op.opId, { ...op });
  }

  async updateOp (opId, updates) {
    const existing = this.ops.get(opId);
    if (! existing) return null;
    const updated = { ...existing, ...updates };
    this.ops.set(opId, { ...updated });
    return updated;
  }

  async listPendingOps (limit = 10) {
    const pending = [...this.ops.values()]
      .filter((op) => op.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    return pending.slice(0, limit).map((op) => ({ ...op }));
  }

  async listOpsByState (state, limit = 10) {
    const filtered = [...this.ops.values()]
      .filter((op) => op.state === state)
      .sort((a, b) => a.createdAt - b.createdAt);
    return filtered.slice(0, limit).map((op) => ({ ...op }));
  }

  async countOpsByState (state) {
    return [...this.ops.values()].filter((op) => op.state === state).length;
  }

  async deleteOp (opId) {
    this.ops.delete(opId);
  }
}

test('emit reports failure via hook', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalOnFailure = emit.onFailure;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  const originalCooldown = emit.failureCooldownMs;
  const originalConsoleError = console.error;
  let notice = null;
  try {
    console.error = () => {};
    api.runtime.sendMessage = async () => { throw new Error('nope'); };
    emit.onFailure = (detail) => { notice = detail; };
    emit.maxTries = 2;
    emit.retryDelayMs = 0;
    emit.failureCooldownMs = 0;
    await emit('bkgd_test', { foo: 'bar' });
    assert(notice, 'Should report emit failure');
    assertEqual(notice.name, 'bkgd_test', 'Should include message name');
    assertEqual(notice.args.foo, 'bar', 'Should include args payload');
  } finally {
    console.error = originalConsoleError;
    api.runtime.sendMessage = originalSendMessage;
    emit.onFailure = originalOnFailure;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
    emit.failureCooldownMs = originalCooldown;
  }
});

test('OpsQueue enqueue stores pending op record', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-1' } });
  const record = await queue.enqueue({
    name: 'ensureLoaded',
    source: 'view',
    payload: { nodeId: 'n1' }
  });
  assertEqual(record.opId, 'op-1', 'Should assign deterministic opId');
  assertEqual(record.state, 'pending', 'Should default to pending state');
  assertEqual(record.type, 'intent', 'Should default to intent type');
  assertEqual(record.source, 'view', 'Should keep provided source');
  assert(record.createdAt <= record.updatedAt, 'updatedAt should be >= createdAt');
  assertEqual(db.ops.get('op-1').name, 'ensureLoaded', 'Should persist op record');
});

test('OpsQueue claimNextOps marks oldest pending as running', async () => {
  const db = new FakeOpsDb();
  db.ops.set('op-a', {
    opId: 'op-a',
    state: 'pending',
    createdAt: 1,
    updatedAt: 1
  });
  db.ops.set('op-b', {
    opId: 'op-b',
    state: 'pending',
    createdAt: 2,
    updatedAt: 2
  });
  db.ops.set('op-c', {
    opId: 'op-c',
    state: 'done',
    createdAt: 0,
    updatedAt: 0
  });

  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  const claimed = await queue.claimNextOps(1);
  assertEqual(claimed.length, 1, 'Should claim one op');
  assertEqual(claimed[0].opId, 'op-a', 'Should claim oldest pending op');
  assertEqual(db.ops.get('op-a').state, 'running', 'Should mark op running');
  assertEqual(db.ops.get('op-b').state, 'pending', 'Should keep other pending');
});

test('OpsQueue markFailed increments retry and preserves error', async () => {
  const db = new FakeOpsDb();
  db.ops.set('op-fail', {
    opId: 'op-fail',
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    retryCount: 0
  });
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  await queue.markFailed('op-fail', new Error('boom'));
  const updated = db.ops.get('op-fail');
  assertEqual(updated.state, 'failed', 'Should mark failed');
  assertEqual(updated.lastError, 'boom', 'Should store lastError message');
  assertEqual(updated.retryCount, 1, 'Should increment retry count');
});

test('OpsQueue requeueFailedOps moves eligible failures back to pending', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  db.ops.set('op-fail', {
    opId: 'op-fail',
    state: 'failed',
    createdAt: 1,
    updatedAt: 1,
    retryCount: 1
  });
  const now = Date.now();
  const originalNow = Date.now;
  try {
    Date.now = () => now + 5000;
    const requeued = await queue.requeueFailedOps({
      limit: 5,
      maxRetries: 3,
      minAgeMs: 1000
    });
    assertEqual(requeued, 1, 'Should requeue failed op');
    assertEqual(db.ops.get('op-fail').state, 'pending', 'Should mark pending');
  } finally {
    Date.now = originalNow;
  }
});

test('OpsQueue requeueStaleRunningOps moves old running ops to pending', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  db.ops.set('op-run', {
    opId: 'op-run',
    state: 'running',
    createdAt: 1,
    updatedAt: 1
  });
  const now = Date.now();
  const originalNow = Date.now;
  try {
    Date.now = () => now + 5000;
    const requeued = await queue.requeueStaleRunningOps({
      limit: 5,
      minAgeMs: 1000
    });
    assertEqual(requeued, 1, 'Should requeue running op');
    assertEqual(db.ops.get('op-run').state, 'pending', 'Should mark pending');
  } finally {
    Date.now = originalNow;
  }
});

test('OpsQueue countPendingOps returns pending count', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  db.ops.set('op-a', { opId: 'op-a', state: 'pending', createdAt: 1 });
  db.ops.set('op-b', { opId: 'op-b', state: 'running', createdAt: 2 });
  const count = await queue.countPendingOps();
  assertEqual(count, 1, 'Should count pending ops');
});

test('OpsQueue updateCursor updates checkpoint data', async () => {
  const db = new FakeOpsDb();
  db.ops.set('op-cursor', {
    opId: 'op-cursor',
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    cursor: null
  });
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  await queue.updateCursor('op-cursor', { step: 'phase1', progress: 2 });
  const updated = db.ops.get('op-cursor');
  assertEqual(updated.cursor.step, 'phase1', 'Should store cursor step');
  assertEqual(updated.cursor.progress, 2, 'Should store cursor progress');
});

test('processOpsQueue executes ensureUnloaded intents', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-1' } });
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.opsQueue = queue;
  bkgd.resolveTreeDbLoaded();
  bkgd.resolveTreeLoaded();

  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const tab = await addChild(win, {
    id: 't1',
    url: 'https://example.com',
    loaded: true,
    tabId: 10
  });

  await queue.enqueue({
    name: 'ensureUnloaded',
    source: 'test',
    payload: { nodeId: tab.id, reason: 'onTabRemoved' }
  });

  await bkgd.processOpsQueue({ budgetMs: 50, batchLimit: 1 });

  assertEqual(tab.loaded, false, 'Should unload tab');
  assertEqual(db.ops.get('op-1').state, 'done', 'Op should be marked done');
});

test('TreeStore onTabRemoved honors tabClosedReason for manual unload', async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const calls = [];
  try {
    globalThis.indexedDB = {
      open: () => {
        const request = {};
        setTimeout(() => {
          if (request.onsuccess) {
            request.onsuccess({
              target: {
                result: {
                  objectStoreNames: { contains: () => true }
                }
              }
            });
          }
        }, 0);
        return request;
      }
    };

    const bkgd = {
      enqueueIntent: async (name, payload, source) => {
        calls.push({ name, payload, source });
      }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: true,
      windowId: 1
    });
    const tab = await addChild(win, {
      id: 't1',
      url: 'https://example.com',
      loaded: false,
      tabId: undefined,
      windowId: undefined
    });
    tab.oldTabId = 12;
    tab.tabClosedReason = 'unload';

    await tree.onTabRemoved(12, { windowId: 1, isWindowClosing: false });

    assertEqual(calls.length, 1, 'Should enqueue one intent');
    assertEqual(calls[0].name, 'ensureUnloaded', 'Should finalize unload');
    assertEqual(calls[0].payload.nodeId, tab.id, 'Should target tab node');
    assertEqual(calls[0].payload.detail, 'manualUnload', 'Should tag manual unload');
    assertEqual(tab.tabClosedReason, undefined, 'Should clear tabClosedReason');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('ensureMoved passes op to applyMoveForIntent', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  tree.createRootNode();
  const parent = await addChild(tree.root, { id: 'p1' });
  const dest = await addChild(tree.root, { id: 'p2' });
  const mover = await addChild(parent, { id: 'c1' });
  bkgd.tree = tree;

  let receivedOp = null;
  tree.applyMoveForIntent = async (node, destParent, destIndex, args, op) => {
    receivedOp = op;
    return true;
  };

  const op = {
    opId: 'op-move',
    name: 'ensureMoved',
    payload: {
      nodeId: mover.id,
      destParentId: dest.id,
      destIndex: 0
    }
  };

  await bkgd.ensureMoved(op.payload, op);
  assertEqual(receivedOp.opId, 'op-move', 'Should pass op to applyMoveForIntent');
});

test('findMatchingWindow honors exclude list', async () => {
  const tree = createTree(null);
  const win1 = await addChild(tree.root, { id: 'w1', type: 'window' });
  const win2 = await addChild(tree.root, { id: 'w2', type: 'window' });
  await addChild(win1, { id: 't1', url: 'https://example.com/a', loaded: true });
  await addChild(win1, { id: 't2', url: 'https://example.com/b', loaded: true });
  await addChild(win2, { id: 't3', url: 'https://example.com/a', loaded: true });
  await addChild(win2, { id: 't4', url: 'https://example.com/b', loaded: true });

  const realWindow = {
    id: 101,
    tabs: [
      { id: 1, url: 'https://example.com/a' },
      { id: 2, url: 'https://example.com/b' }
    ]
  };

  const match1 = await tree.findMatchingWindow(realWindow);
  assert(match1, 'Should match a window node');

  const exclude = new Set([match1.id]);
  const match2 = await tree.findMatchingWindow(realWindow, exclude);
  assert(match2, 'Should match a second window node');
  assert(match2.id !== match1.id, 'Exclude list should prevent reuse');
  const tab = tree.nodes.t1;
  assertEqual(tab.tabId, 1, 'Should attach tabId to matched node');
  assertEqual(tab.wasLoaded, false, 'Matched tab should reset wasLoaded');
});

test('mergeOpenWindowsIntoTree assigns unique window nodes', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;

  const win1 = await addChild(tree.root, { id: 'w1', type: 'window' });
  const win2 = await addChild(tree.root, { id: 'w2', type: 'window' });
  await addChild(win1, { id: 't1', url: 'https://example.com/a' });
  await addChild(win1, { id: 't2', url: 'https://example.com/b' });
  await addChild(win2, { id: 't3', url: 'https://example.com/a' });
  await addChild(win2, { id: 't4', url: 'https://example.com/b' });

  api.windows.getAll = async () => ([
    {
      id: 60,
      tabs: [
        { id: 1, url: 'https://example.com/a' },
        { id: 2, url: 'https://example.com/b' }
      ]
    },
    {
      id: 1098,
      tabs: [
        { id: 3, url: 'https://example.com/a' },
        { id: 4, url: 'https://example.com/b' }
      ]
    }
  ]);

  await bkgd.mergeOpenWindowsIntoTree();

  const windowNodes = tree.root.findNodes((n) => n.isWindow());
  const windowIds = windowNodes.map((n) => n.windowId).filter(Boolean);
  assertEqual(windowIds.length, 2, 'Both window nodes should attach');
  const uniqueIds = new Set(windowIds);
  assertEqual(uniqueIds.size, 2, 'Window nodes should be unique');
  assert(uniqueIds.has(60), 'Should attach window 60');
  assert(uniqueIds.has(1098), 'Should attach window 1098');
});

test('runReconcile drops boring closed tabs', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 't1',
      tabId: 10,
      url: 'https://example.com',
      loaded: true
    });

    api.windows.getAll = async () => ([]);

    await runReconcile.call(bkgd, { reason: 'test' });

    assert(!tree.nodes.t1, 'Should delete closed boring tab');
    assert(!tree.nodes.w1, 'Should delete empty window after cleanup');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('onTabMoved ignores no-op moves', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const tab1 = await addChild(win, {
    id: 't1',
    tabId: 10,
    loaded: true
  });
  await addChild(win, {
    id: 't2',
    tabId: 11,
    loaded: true
  });

  let moved = false;
  const originalMoveTo = tab1.moveTo;
  tab1.moveTo = async (...args) => {
    moved = true;
    return await originalMoveTo.apply(tab1, args);
  };

  await tree.onTabMoved(10, { fromIndex: 0, toIndex: 0, windowId: 1 });
  assertEqual(moved, false, 'No-op move should not re-move tab');
});

test('serializeNodes includes window geometry fields', async () => {
  const tree = createTree(null);
  await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    geometry: [800, 600, 10, 20],
    windowState: 'maximized',
    incognito: true
  });

  const data = tree.serializeNodes();
  const saved = data.w1;
  assertEqual(saved.geometry[0], 800, 'Should persist geometry width');
  assertEqual(saved.windowState, 'maximized', 'Should persist windowState');
  assertEqual(saved.incognito, true, 'Should persist incognito');
});

test('onWindowBoundsChanged updates window geometry', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1
  });

  await bkgd.onWindowBoundsChanged({
    id: 1,
    width: 900,
    height: 700,
    left: 12,
    top: 34,
    state: 'normal',
    incognito: false
  });

  assertEqual(win.geometry[0], 900, 'Should update geometry width');
  assertEqual(win.windowState, 'normal', 'Should update windowState');
  assertEqual(win.incognito, false, 'Should update incognito');
});

test('initLocalBackupAlarm triggers overdue backup', async () => {
  const originalGet = api.storage.local.get;
  const originalSet = api.storage.local.set;
  const originalAlarmsGet = api.alarms.get;
  const originalAlarmsCreate = api.alarms.create;
  const originalAlarmsClear = api.alarms.clear;
  try {
    api.storage.local.get = async () => ({
      localBackupInterval: 1,
      lastBackupTime: Date.now() - 120000,
      backupOnStartup: true
    });
    api.storage.local.set = async () => ({});
    api.alarms.get = async () => null;
    api.alarms.create = async () => {};
    api.alarms.clear = async () => {};

    const bkgd = new Bkgd();
    let backupCalls = 0;
    bkgd.tree = { downloadBackupNow: async () => { backupCalls += 1; } };
    bkgd.resolveTreeLoaded();
    await bkgd.initLocalBackupAlarm();
    await new Promise(r => setTimeout(r, 0));
    assertEqual(backupCalls, 1, 'Should run overdue backup once');
    assertEqual(bkgd.backupQueued, false, 'Backup queue should reset');
  } finally {
    api.storage.local.get = originalGet;
    api.storage.local.set = originalSet;
    api.alarms.get = originalAlarmsGet;
    api.alarms.create = originalAlarmsCreate;
    api.alarms.clear = originalAlarmsClear;
  }
});

test('initLocalBackupAlarm respects backupOnStartup false', async () => {
  const originalGet = api.storage.local.get;
  const originalAlarmsGet = api.alarms.get;
  const originalAlarmsCreate = api.alarms.create;
  try {
    api.storage.local.get = async () => ({
      localBackupInterval: 1,
      lastBackupTime: Date.now() - 120000,
      backupOnStartup: false
    });
    api.alarms.get = async () => null;
    api.alarms.create = async () => {};

    const bkgd = new Bkgd();
    let backupCalls = 0;
    bkgd.tree = { downloadBackupNow: async () => { backupCalls += 1; } };
    bkgd.resolveTreeLoaded();
    await bkgd.initLocalBackupAlarm();
    await new Promise(r => setTimeout(r, 0));
    assertEqual(backupCalls, 0, 'Should not run overdue backup');
  } finally {
    api.storage.local.get = originalGet;
    api.alarms.get = originalAlarmsGet;
    api.alarms.create = originalAlarmsCreate;
  }
});

async function runTests() {
  const mods = await Promise.all([
    import('/api.js'),
    import('/bkgd/bkgd.js'),
    import('/bkgd/ops.js'),
    import('/bkgd/reconcile.js'),
    import('/bkgd/treestore.js'),
    import('/common/tree.js'),
    import('/common/node.js'),
    import('/common/common.js')
  ]);
  api = mods[0].api;
  Bkgd = mods[1].Bkgd;
  OpsQueue = mods[2].OpsQueue;
  runReconcile = mods[3].runReconcile;
  TreeStore = mods[4].TreeStore;
  Tree = mods[5].Tree;
  Node = mods[6].Node;
  emit = mods[7].emit;
  TestNode = class TestNode extends Node {
    newNodeId () {
      this.tree.nextId += 1;
      return `test-${this.tree.nextId}`;
    }

    async addChild (index, details, ...extra) {
      if (!details.id) details.id = this.newNodeId();
      return await super.addChild(index, details, ...extra);
    }

    async load () {
      this.loaded = true;
      return true;
    }

    async unload () {
      this.loaded = false;
      this.tabId = undefined;
      return true;
    }
  };

  let passCount = 0;
  let failCount = 0;

  for (const item of tests) {
    try {
      await item.fn();
      passCount += 1;
      console.log(`PASS: ${item.name}`);
    } catch (err) {
      failCount += 1;
      console.error(`FAIL: ${item.name}`);
      console.error(err && err.message ? err.message : err);
    }
  }

  console.log(`\nNode Tests: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

runTests();
