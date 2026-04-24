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
      query: async () => ([]),
      update: async () => ({}),
      move: async () => ({})
    },
    windows: {
      getAll: async () => ([]),
      get: async () => ({}),
      update: async () => ({})
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
    if (Number.isFinite(limit) && (limit > 0)) {
      return filtered.slice(0, limit).map((op) => ({ ...op }));
    }
    return filtered.map((op) => ({ ...op }));
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

test('OpsQueue requeueFailedOps skips ineligible ops without starvation', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  const now = Date.now();
  db.ops.set('op-skip', {
    opId: 'op-skip',
    state: 'failed',
    createdAt: 1,
    updatedAt: now,
    retryCount: 5
  });
  db.ops.set('op-eligible', {
    opId: 'op-eligible',
    state: 'failed',
    createdAt: 2,
    updatedAt: now - 5000,
    retryCount: 0
  });
  const requeued = await queue.requeueFailedOps({
    limit: 1,
    maxRetries: 3,
    minAgeMs: 0
  });
  assertEqual(requeued, 1, 'Should requeue eligible op even if earlier ops skipped');
  assertEqual(db.ops.get('op-eligible').state, 'pending', 'Should requeue later eligible op');
  assertEqual(db.ops.get('op-skip').state, 'failed', 'Should keep ineligible op failed');
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

test('OpsQueue requeueStaleRunningOps skips fresh ops without starvation', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  const now = Date.now();
  db.ops.set('op-fresh', {
    opId: 'op-fresh',
    state: 'running',
    createdAt: 1,
    updatedAt: now,
    retryCount: 0
  });
  db.ops.set('op-old', {
    opId: 'op-old',
    state: 'running',
    createdAt: 2,
    updatedAt: now - 60000,
    retryCount: 0
  });
  const requeued = await queue.requeueStaleRunningOps({
    limit: 1,
    minAgeMs: 1000
  });
  assertEqual(requeued, 1, 'Should requeue eligible running op even if earlier ops skipped');
  assertEqual(db.ops.get('op-old').state, 'pending', 'Should requeue stale running op');
  assertEqual(db.ops.get('op-fresh').state, 'running', 'Should keep fresh op running');
});

test('OpsQueue pruneDoneOps removes old done ops and respects limit', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  const now = Date.now();
  const originalNow = Date.now;
  try {
    Date.now = () => now;
    db.ops.set('op-old-1', {
      opId: 'op-old-1',
      state: 'done',
      createdAt: 1,
      updatedAt: now - 10000
    });
    db.ops.set('op-old-2', {
      opId: 'op-old-2',
      state: 'done',
      createdAt: 2,
      updatedAt: now - 8000
    });
    db.ops.set('op-fresh', {
      opId: 'op-fresh',
      state: 'done',
      createdAt: 3,
      updatedAt: now - 1000
    });
    db.ops.set('op-failed', {
      opId: 'op-failed',
      state: 'failed',
      createdAt: 4,
      updatedAt: now - 20000
    });
    const removed = await queue.pruneDoneOps({ maxAgeMs: 5000, limit: 1 });
    assertEqual(removed, 1, 'Should remove one old done op');
    const remainingDone = [...db.ops.values()].filter((op) => op.state === 'done');
    assertEqual(remainingDone.length, 2, 'Should keep remaining done ops');
    assert(db.ops.has('op-fresh'), 'Should keep recent done op');
    assert(db.ops.has('op-failed'), 'Should not touch other states');
  } finally {
    Date.now = originalNow;
  }
});

test('OpsQueue clearAllOps removes all ops', async () => {
  const db = new FakeOpsDb();
  const queue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  db.ops.set('op-pending', { opId: 'op-pending', state: 'pending', createdAt: 1 });
  db.ops.set('op-running', { opId: 'op-running', state: 'running', createdAt: 2 });
  db.ops.set('op-done', { opId: 'op-done', state: 'done', createdAt: 3 });
  const removed = await queue.clearAllOps();
  assertEqual(removed, 3, 'Should remove all ops');
  assertEqual(db.ops.size, 0, 'Ops store should be empty');
});

test('bkgd_pruneOps removes ops with missing node targets', async () => {
  const db = new FakeOpsDb();
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  tree.createRootNode();
  bkgd.tree = tree;
  bkgd.opsQueue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  bkgd.resolveTreeDbLoaded();
  bkgd.resolveTreeLoaded();

  await addChild(tree.root, { id: 'n1' });
  db.ops.set('op-missing', {
    opId: 'op-missing',
    state: 'pending',
    name: 'ensureLoaded',
    payload: { nodeId: 'missing' },
    createdAt: 1,
    updatedAt: 1
  });
  db.ops.set('op-missing-parent', {
    opId: 'op-missing-parent',
    state: 'running',
    name: 'ensureMoved',
    payload: { nodeId: 'n1', destParentId: 'missing-parent' },
    createdAt: 1,
    updatedAt: 1
  });
  db.ops.set('op-valid', {
    opId: 'op-valid',
    state: 'pending',
    name: 'ensureLoaded',
    payload: { nodeId: 'n1' },
    createdAt: 1,
    updatedAt: 1
  });

  const result = await bkgd.bkgd_pruneOps({
    maxAgeMs: 1000,
    limit: 10,
    pruneMissing: true
  });

  assertEqual(result.removedMissing, 2, 'Should remove ops with missing targets');
  assertEqual(result.removed, 2, 'Removed count should include missing ops');
  assert(db.ops.has('op-valid'), 'Should keep ops with valid targets');
});

test('startup purges stale browser move ops without deleting fresh ops', async () => {
  const db = new FakeOpsDb();
  const bkgd = new Bkgd();
  bkgd.opsQueue = new OpsQueue(db, { idGen: { newId: () => 'op-x' } });
  bkgd.bootStartedAt = 2000;

  db.ops.set('op-old-browser-move', {
    opId: 'op-old-browser-move',
    state: 'pending',
    name: 'ensureMoved',
    source: 'browserEvent',
    createdAt: 1000,
    updatedAt: 1000,
    payload: {}
  });
  db.ops.set('op-fresh-browser-move', {
    opId: 'op-fresh-browser-move',
    state: 'pending',
    name: 'ensureMoved',
    source: 'browserEvent',
    createdAt: 3000,
    updatedAt: 3000,
    payload: {}
  });
  db.ops.set('op-view-move', {
    opId: 'op-view-move',
    state: 'pending',
    name: 'ensureMoved',
    source: 'view',
    createdAt: 1000,
    updatedAt: 1000,
    payload: {}
  });
  db.ops.set('op-browser-unload', {
    opId: 'op-browser-unload',
    state: 'pending',
    name: 'ensureUnloaded',
    source: 'browserEvent',
    createdAt: 1000,
    updatedAt: 1000,
    payload: {}
  });

  const removed = await bkgd.purgeStaleBrowserEventMoveOps();

  assertEqual(removed, 1, 'Should remove only stale browser move ops');
  assert(! db.ops.has('op-old-browser-move'),
    'Should delete pre-boot browser move op');
  assert(db.ops.has('op-fresh-browser-move'),
    'Should keep fresh browser move op');
  assert(db.ops.has('op-view-move'), 'Should keep view move op');
  assert(db.ops.has('op-browser-unload'), 'Should keep non-move browser op');
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
      },
      ensureUnloaded: async () => {}
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

test('TreeStore userAction load bypasses ops queue', async () => {
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
      enqueueIntent: async (...args) => { calls.push(args); },
      ensureLoaded: async () => { calls.push(['ensureLoaded']); }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();
    await addChild(tree.root, { id: 'n1', url: 'https://example.com', loaded: false });

    await tree.tree_nodeChanged({
      type: 'load',
      nodeId: 'n1',
      actionReason: 'userAction'
    });

    assertEqual(calls.length, 1, 'Should only call ensureLoaded');
    assertEqual(calls[0][0], 'ensureLoaded', 'Should bypass enqueue for userAction');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore userAction unload bypasses ops queue', async () => {
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
      enqueueIntent: async (...args) => { calls.push(args); },
      ensureUnloaded: async () => { calls.push(['ensureUnloaded']); }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();
    await addChild(tree.root, {
      id: 'n1',
      url: 'https://example.com',
      loaded: true,
      tabId: 1,
      windowId: 1
    });

    await tree.tree_nodeChanged({
      type: 'unload',
      nodeId: 'n1',
      actionReason: 'userAction',
      wasLoaded: true
    });

    assertEqual(calls.length, 1, 'Should only call ensureUnloaded');
    assertEqual(calls[0][0], 'ensureUnloaded', 'Should bypass enqueue for userAction');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore userAction move bypasses ops queue', async () => {
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
      enqueueIntent: async (...args) => { calls.push(args); },
      ensureMoved: async () => { calls.push(['ensureMoved']); }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();
    const parent = await addChild(tree.root, { id: 'p1' });
    const dest = await addChild(tree.root, { id: 'p2' });
    await addChild(parent, { id: 'c1' });

    await tree.tree_nodeMoved({
      nodeId: 'c1',
      destParentId: 'p2',
      destIndex: 0,
      actionReason: 'userAction'
    });

    assertEqual(calls.length, 1, 'Should only call ensureMoved');
    assertEqual(calls[0][0], 'ensureMoved', 'Should bypass enqueue for userAction');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore userAction delete bypasses ops queue', async () => {
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
      enqueueIntent: async (...args) => { calls.push(args); },
      ensureDeleted: async () => { calls.push(['ensureDeleted']); }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();
    await addChild(tree.root, { id: 'n1' });

    await tree.tree_nodeDeleted({
      nodeId: 'n1',
      actionReason: 'userAction'
    });

    assertEqual(calls.length, 1, 'Should only call ensureDeleted');
    assertEqual(calls[0][0], 'ensureDeleted', 'Should bypass enqueue for userAction');
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

test('ensureMoved can move browser tab node without its children', async () => {
  const originalQuery = api.tabs.query;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const child = await addChild(moved, {
      id: 'child',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const sibling = await addChild(win, {
      id: 'sibling',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: false },
      { id: 12, index: 1, windowId: 1, pinned: false },
      { id: 10, index: 2, windowId: 1, pinned: false }
    ]);

    await bkgd.ensureMoved({
      nodeId: moved.id,
      destParentId: win.id,
      destIndex: sibling.indexOf() + 1,
      reason: 'onTabMoved',
      skipTabReorder: true,
      moveNodeOnly: true,
      browserWindowId: 1,
      browserIndex: 2,
      pinned: false
    });

    assertEqual(moved.nodes.length, 0,
      'Moved browser tab node should not keep its children');
    assertEqual(win.nodes[0], child,
      'Former child should remain at the original flat position');
    assertEqual(win.nodes[1], sibling,
      'Existing sibling should remain before the moved tab');
    assertEqual(win.nodes[2], moved,
      'Moved tab should land at the browser-reported flat index');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('ensureMoved keeps browser-moved parent under outline parent', async () => {
  const originalQuery = api.tabs.query;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const parentA = await addChild(win, {
      id: 'a',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const childB = await addChild(parentA, {
      id: 'b',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const movedC = await addChild(parentA, {
      id: 'c',
      tabId: 12,
      windowId: 1,
      loaded: true
    });
    const grandchildD = await addChild(movedC, {
      id: 'd',
      tabId: 13,
      windowId: 1,
      loaded: true
    });
    const grandchildE = await addChild(movedC, {
      id: 'e',
      tabId: 14,
      windowId: 1,
      loaded: true
    });

    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: false },
      { id: 11, index: 1, windowId: 1, pinned: false },
      { id: 13, index: 2, windowId: 1, pinned: false },
      { id: 14, index: 3, windowId: 1, pinned: false },
      { id: 12, index: 4, windowId: 1, pinned: false }
    ]);

    await bkgd.ensureMoved({
      nodeId: movedC.id,
      destParentId: win.id,
      destIndex: 5,
      reason: 'onTabMoved',
      skipTabReorder: true,
      moveNodeOnly: true,
      browserWindowId: 1,
      browserIndex: 4,
      pinned: false
    });

    assertEqual(movedC.nodes.length, 0,
      'Moved parent tab should not keep promoted children');
    assertEqual(win.nodes.map((node) => node.id).join(','), 'a',
      'Window root should not receive C as a top-level child');
    assertEqual(parentA.nodes.map((node) => node.id).join(','), 'b,d,e,c',
      'C should remain under A after D and E are promoted');
    assertEqual(childB.parent, parentA, 'B should remain under A');
    assertEqual(grandchildD.parent, parentA, 'D should be promoted under A');
    assertEqual(grandchildE.parent, parentA, 'E should be promoted under A');
    assertEqual(movedC.parent, parentA, 'C should remain under A');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('view-side user move emits tree move without direct tab reorder request', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const first = await addChild(win, {
      id: 'first',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const sent = [];
    api.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      return {};
    };

    await moved.moveTo(win, 0, { reason: 'userAction' });

    assertEqual(win.nodes[0], moved, 'View tree should apply local move');
    assertEqual(win.nodes[1], first, 'Original first tab should shift down');
    assert(sent.some((msg) => msg.msg === 'tree_nodeMoved'),
      'View should still notify background about the tree move');
    assert(! sent.some((msg) => msg.msg === 'bkgd_reorderAllTabsInThisWindow'),
      'View should not independently request browser tab reorder');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('applyMoveForIntent keeps only-child loaded window content under window', async () => {
  const originalIndexedDb = globalThis.indexedDB;
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
      bkgd_loadSavedWindow: async () => {},
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const mover = await addChild(windowNode, {
      id: 't1',
      tabId: 1,
      windowId: 1,
      loaded: true,
      url: 'https://example.com'
    });

    await tree.applyMoveForIntent(
      mover,
      tree.root,
      1,
      {
        openWindowOnRootMove: true,
        reason: 'userAction',
        prevParentId: windowNode.id,
        when: Date.now()
      }
    );

    assertEqual(mover.parent, windowNode, 'Loaded only-child should stay under window');
    assertEqual(windowNode.parent, tree.root, 'Window should remain at root');
    assertEqual(tree.root.nodes[0], windowNode, 'Window should stay at root index');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('applyMoveForIntent wraps loaded branch into new window', async () => {
  const originalIndexedDb = globalThis.indexedDB;
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

    const loadCalls = [];
    const bkgd = {
      bkgd_loadSavedWindow: async (payload) => {
        loadCalls.push(payload);
      },
      opsQueue: null,
      idGen: { newId: () => 'test-win' }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(windowNode, {
      id: 't1',
      tabId: 1,
      windowId: 1,
      loaded: true,
      url: 'https://example.com'
    });
    const mover = await addChild(windowNode, {
      id: 't2',
      tabId: 2,
      windowId: 1,
      loaded: true,
      url: 'https://example.com/two'
    });

    await tree.applyMoveForIntent(
      mover,
      tree.root,
      1,
      {
        openWindowOnRootMove: true,
        reason: 'userAction',
        prevParentId: windowNode.id,
        when: Date.now()
      }
    );

    assertEqual(tree.root.nodes.length, 2, 'Root should have two windows');
    assertEqual(windowNode.nodes.length, 1, 'Original window should keep one child');
    assertEqual(windowNode.nodes[0].id, 't1', 'Original child should remain in window');
    const newWindow = tree.root.nodes[1];
    assert(newWindow.isWindow(), 'New window should be a window node');
    assertEqual(mover.parent, newWindow, 'Moved node should be under new window');
    assertEqual(loadCalls.length, 1, 'Should load new window');
    assertEqual(loadCalls[0].windowNodeId, newWindow.id, 'Should load new window ID');
    assertEqual(loadCalls[0].nodeId, mover.id, 'Should load moved node');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('applyMoveForIntent wraps unloaded branch with loaded descendant', async () => {
  const originalIndexedDb = globalThis.indexedDB;
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

    const loadCalls = [];
    const bkgd = {
      bkgd_loadSavedWindow: async (payload) => {
        loadCalls.push(payload);
      },
      opsQueue: null,
      idGen: { newId: () => 'test-win-2' }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(windowNode, {
      id: 't1',
      tabId: 1,
      windowId: 1,
      loaded: true,
      url: 'https://example.com/one'
    });
    const mover = await addChild(windowNode, {
      id: 't2',
      tabId: 2,
      windowId: 1,
      loaded: false,
      url: 'https://example.com/two'
    });
    await addChild(mover, {
      id: 't3',
      tabId: 3,
      windowId: 1,
      loaded: true,
      url: 'https://example.com/three'
    });

    await tree.applyMoveForIntent(
      mover,
      tree.root,
      1,
      {
        openWindowOnRootMove: false,
        reason: 'userAction',
        prevParentId: windowNode.id,
        when: Date.now()
      }
    );

    assertEqual(tree.root.nodes.length, 2, 'Root should have two windows');
    assertEqual(windowNode.nodes.length, 1, 'Original window should keep one child');
    assertEqual(windowNode.nodes[0].id, 't1', 'Original child should remain in window');
    const newWindow = tree.root.nodes[1];
    assert(newWindow.isWindow(), 'New window should be a window node');
    assertEqual(mover.parent, newWindow, 'Moved node should be under new window');
    assertEqual(loadCalls.length, 1, 'Should load new window');
    assertEqual(loadCalls[0].windowNodeId, newWindow.id, 'Should load new window ID');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('applyMoveForIntent avoids wrapping unloaded root move without open tabs', async () => {
  const originalIndexedDb = globalThis.indexedDB;
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

    const loadCalls = [];
    const bkgd = {
      bkgd_loadSavedWindow: async (payload) => {
        loadCalls.push(payload);
      },
      opsQueue: null,
      idGen: { newId: () => 'test-win-3' }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: false
    });
    const mover = await addChild(windowNode, {
      id: 't1',
      loaded: false,
      url: 'https://example.com'
    });

    await tree.applyMoveForIntent(
      mover,
      tree.root,
      1,
      {
        openWindowOnRootMove: true,
        reason: 'userAction',
        prevParentId: windowNode.id,
        when: Date.now()
      }
    );

    const windowCount = tree.root.nodes.filter((node) => node.isWindow()).length;
    assertEqual(loadCalls.length, 0, 'Should not load a new window');
    assert(windowCount <= 1, 'Should not create an extra window node');
    assertEqual(mover.parent, tree.root, 'Should move node directly to root');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('bkgd_loadSavedNode creates window when windowId is missing', async () => {
  const originalWindowsCreate = api.windows.create;
  const originalTabsCreate = api.tabs.create;
  try {
    let windowCalls = 0;
    let tabCalls = 0;
    api.windows.create = async () => {
      windowCalls += 1;
      return { id: 99 };
    };
    api.tabs.create = async () => {
      tabCalls += 1;
      return {};
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: true,
      windowId: undefined
    });
    const tab = await addChild(windowNode, {
      id: 't1',
      url: 'https://example.com',
      loaded: false
    });

    await bkgd.bkgd_loadSavedNode({ nodeId: tab.id, reason: 'userAction' });

    assertEqual(windowCalls, 1, 'Should create window when windowId is missing');
    assertEqual(tabCalls, 0, 'Should not create tab in missing window');
  } finally {
    api.windows.create = originalWindowsCreate;
    api.tabs.create = originalTabsCreate;
  }
});

test('bkgd_loadSavedNode preserves pinned state while restoring saved tab', async () => {
  const originalTabsCreate = api.tabs.create;
  try {
    const created = [];
    api.tabs.create = async (props) => {
      created.push(props);
      return { id: 77 };
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: true,
      windowId: 1
    });
    await addChild(windowNode, {
      id: 'existing-pinned',
      tabId: 50,
      windowId: 1,
      url: 'https://example.com/existing-pinned',
      loaded: true,
      pinned: true
    });
    const tab = await addChild(windowNode, {
      id: 't1',
      url: 'https://example.com/pinned',
      loaded: false,
      pinned: true
    });

    await bkgd.bkgd_loadSavedNode({ nodeId: tab.id, reason: 'userAction' });

    assertEqual(created.length, 1, 'Should create one browser tab');
    assertEqual(created[0].pinned, true,
      'Saved pinned tab should request pinned browser creation');
    assertEqual(created[0].index, 1,
      'Saved pinned tab should request its pinned-prefix index');

    await tree.onTabCreated({
      id: 77,
      index: 0,
      windowId: 1,
      pinned: false,
      url: 'https://example.com/pinned',
      title: 'Pinned',
      active: true
    });

    assertEqual(tab.tabId, 77, 'Saved node should attach to created tab');
    assertEqual(tab.pinned, true,
      'Saved pinned state should not be cleared by restore event');

    await tree.onTabUpdated(77, { pinned: false }, {
      id: 77,
      windowId: 1,
      pinned: false,
      title: 'Pinned',
      url: 'https://example.com/pinned'
    });
    assertEqual(tab.pinned, true,
      'False update during pinned restore should not clear saved state');

    await tree.onTabUpdated(77, { pinned: true }, {
      id: 77,
      windowId: 1,
      pinned: true,
      title: 'Pinned',
      url: 'https://example.com/pinned'
    });
    assertEqual(tab.pinRestorePending, false,
      'True pinned update should clear restore guard');
  } finally {
    api.tabs.create = originalTabsCreate;
  }
});

test('pin restore guard allows stale unpinned updates', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const tab = await addChild(win, {
    id: 't1',
    tabId: 77,
    windowId: 1,
    url: 'https://example.com/pinned',
    loaded: true,
    pinned: true
  });
  tab.pinRestorePending = true;
  tab.pinRestorePendingAt = Date.now() - 3000;

  await tree.onTabUpdated(77, { pinned: false }, {
    id: 77,
    windowId: 1,
    pinned: false,
    title: 'Pinned',
    url: 'https://example.com/pinned'
  });

  assertEqual(tab.pinRestorePending, false,
    'Stale restore guard should clear on later false update');
  assertEqual(tab.pinned, false,
    'Stale false update should be treated as a real unpin');
});

test('bkgd_loadSavedNode pins restored tab created with new window', async () => {
  const originalWindowsCreate = api.windows.create;
  const originalTabsUpdate = api.tabs.update;
  try {
    const updates = [];
    api.windows.create = async () => ({
      id: 99,
      tabs: [{ id: 77 }]
    });
    api.tabs.update = async (tabId, props) => {
      updates.push({ tabId, props });
      return {};
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: false,
      windowId: undefined
    });
    const tab = await addChild(windowNode, {
      id: 't1',
      url: 'https://example.com/pinned',
      loaded: false,
      pinned: true
    });

    await bkgd.bkgd_loadSavedNode({ nodeId: tab.id, reason: 'userAction' });

    assertEqual(updates.length, 1, 'Should pin the created browser tab');
    assertEqual(updates[0].tabId, 77, 'Should pin the new window first tab');
    assertEqual(updates[0].props.pinned, true,
      'Should request pinned state after window creation');
    assertEqual(tab.pinRestorePending, false,
      'Successful post-create pinning should clear restore guard');
  } finally {
    api.windows.create = originalWindowsCreate;
    api.tabs.update = originalTabsUpdate;
  }
});

test('bkgd_loadSavedNode clears restore guard when new-window pinning fails', async () => {
  const originalWindowsCreate = api.windows.create;
  const originalTabsUpdate = api.tabs.update;
  try {
    api.windows.create = async () => ({
      id: 99,
      tabs: [{ id: 77 }]
    });
    api.tabs.update = async () => {
      throw new Error('pin failed');
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: false,
      windowId: undefined
    });
    const tab = await addChild(windowNode, {
      id: 't1',
      url: 'https://example.com/pinned',
      loaded: false,
      pinned: true
    });

    await bkgd.bkgd_loadSavedNode({ nodeId: tab.id, reason: 'userAction' });

    assertEqual(tab.pinRestorePending, false,
      'Failed browser pinning should not leave restore guard stuck');
    assertEqual(tab.pinned, false,
      'Failed browser pinning should reconcile tree pinned state');
  } finally {
    api.windows.create = originalWindowsCreate;
    api.tabs.update = originalTabsUpdate;
  }
});

test('bkgd_loadSavedWindow uses nested loaded tabs when windowId missing', async () => {
  const originalWindowsCreate = api.windows.create;
  const originalTabsGet = api.tabs.get;
  try {
    const created = [];
    api.windows.create = async (props) => {
      created.push(props);
      return { id: 101 };
    };
    api.tabs.get = async (tabId) => ({ id: tabId, windowId: 101 });

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      loaded: true,
      windowId: undefined
    });
    const nestedWindow = await addChild(windowNode, {
      id: 'w2',
      type: 'window',
      loaded: true,
      windowId: 55
    });
    await addChild(nestedWindow, {
      id: 't1',
      tabId: 42,
      windowId: 55,
      loaded: true,
      url: 'https://example.com'
    });

    await bkgd.bkgd_loadSavedWindow({
      windowNodeId: windowNode.id,
      nodeId: windowNode.id
    });

    assertEqual(created.length, 1, 'Should create a window for nested tabs');
    assertEqual(created[0].tabId, 42, 'Should use nested tabId as opener');
  } finally {
    api.windows.create = originalWindowsCreate;
    api.tabs.get = originalTabsGet;
  }
});

test('getNodeByTabId prefers tabId over oldTabId', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, { id: 'w1', type: 'window' });
  const direct = await addChild(win, {
    id: 't1',
    url: 'https://example.com',
    tabId: 10,
    loaded: true
  });
  const old = await addChild(win, {
    id: 't2',
    url: 'https://example.com/old',
    loaded: false
  });
  old.oldTabId = 10;

  const found = tree.getNodeByTabId(10);
  assertEqual(found.id, direct.id, 'Should prefer direct tabId match');
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
  assertEqual(match2.windowId, 101, 'Excluded rematch should attach the other window');
  const matchedTab = match2.findNodes((node) =>
    { return node.url === 'https://example.com/a'; })[0];
  assertEqual(matchedTab.tabId, 1, 'Matched window should own the tab binding');
  assertEqual(matchedTab.wasLoaded, false, 'Matched tab should reset wasLoaded');
});

test('findMatchingWindow matches duplicate URLs by pinned state', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, { id: 'w1', type: 'window' });
  const regular = await addChild(win, {
    id: 'regular',
    url: 'https://same.example.com',
    loaded: true,
    pinned: false
  });
  const pinned = await addChild(win, {
    id: 'pinned',
    url: 'https://same.example.com',
    loaded: true,
    pinned: true
  });

  const realWindow = {
    id: 102,
    tabs: [
      { id: 1, url: 'https://same.example.com', pinned: true },
      { id: 2, url: 'https://same.example.com', pinned: false }
    ]
  };

  const match = await tree.findMatchingWindow(realWindow);

  assert(match, 'Should match saved window');
  assertEqual(pinned.tabId, 1,
    'Pinned browser tab should pre-attach to pinned saved duplicate');
  assertEqual(regular.tabId, 2,
    'Unpinned browser tab should pre-attach to unpinned saved duplicate');
});

test('findMatchingWindow scores duplicate windows by pinned order', async () => {
  const tree = createTree(null);
  const wrongWin = await addChild(tree.root, { id: 'wrong-win', type: 'window' });
  await addChild(wrongWin, {
    id: 'wrong-regular',
    url: 'https://same.example.com',
    loaded: true,
    pinned: false
  });
  await addChild(wrongWin, {
    id: 'wrong-pinned',
    url: 'https://same.example.com',
    loaded: true,
    pinned: true
  });

  const rightWin = await addChild(tree.root, { id: 'right-win', type: 'window' });
  const rightPinned = await addChild(rightWin, {
    id: 'right-pinned',
    url: 'https://same.example.com',
    loaded: true,
    pinned: true
  });
  const rightRegular = await addChild(rightWin, {
    id: 'right-regular',
    url: 'https://same.example.com',
    loaded: true,
    pinned: false
  });

  const realWindow = {
    id: 103,
    tabs: [
      { id: 1, url: 'https://same.example.com', pinned: true },
      { id: 2, url: 'https://same.example.com', pinned: false }
    ]
  };

  const match = await tree.findMatchingWindow(realWindow);

  assertEqual(match.id, rightWin.id,
    'Window match should prefer pinned order when URLs tie');
  assertEqual(rightPinned.tabId, 1,
    'Pinned browser tab should attach to pinned node in selected window');
  assertEqual(rightRegular.tabId, 2,
    'Unpinned browser tab should attach to unpinned node in selected window');
});

test('setTabFields detaches conflicting tab bindings', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const stale = await addChild(win, {
    id: 'stale',
    tabId: 10,
    windowId: 1,
    url: 'https://example.com/stale',
    loaded: true,
    active: true
  });
  stale.oldTabId = 10;
  const fresh = await addChild(win, {
    id: 'fresh',
    url: 'https://example.com/fresh',
    loaded: false
  });

  await fresh.setTabFields({
    tabId: 10,
    windowId: 1,
    loaded: true,
    active: false
  }, { reason: 'test' });

  assertEqual(tree.getNodeByTabId(10).id, 'fresh', 'Fresh node should win the tabId');
  assertEqual(stale.tabId, undefined, 'Stale node should lose direct tabId binding');
  assertEqual(stale.oldTabId, undefined, 'Stale node should lose oldTabId binding');
  assertEqual(stale.loaded, false, 'Stale node should be marked unloaded');
  assertEqual(stale.active, false, 'Stale node should no longer be active');
});

test('setTabFields broadcasts pinned changes from move and attach events', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    const tree = createTree(null);
    const node = await addChild(tree.root, {
      id: 'tab',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: false
    });
    const sent = [];
    api.runtime.sendMessage = async (msg) => {
      sent.push(msg);
      return {};
    };

    await node.setTabFields({ pinned: true }, { reason: 'onTabMoved' });
    await node.setTabFields({ windowId: 2 }, { reason: 'onTabAttached' });

    assertEqual(sent.length, 2,
      'Move and attach field changes should notify open views');
    assertEqual(sent[0].msg, 'tree_nodeChanged',
      'Pinned move change should emit tree_nodeChanged');
    assertEqual(sent[0].changes.pinned, true,
      'Pinned move change should include pinned field');
    assertEqual(sent[1].changes.windowId, 2,
      'Attach change should include windowId field');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
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
      focused: true,
      tabs: [
        { id: 1, url: 'https://example.com/a' },
        { id: 2, url: 'https://example.com/b' }
      ]
    },
    {
      id: 1098,
      focused: false,
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
  const focusedWindow = windowNodes.find((n) => n.windowId === 60);
  const unfocusedWindow = windowNodes.find((n) => n.windowId === 1098);
  assertEqual(focusedWindow.active, true, 'Focused window should be active');
  assertEqual(unfocusedWindow.active, false, 'Unfocused window should be inactive');
});

test('mergeOpenWindowsIntoTree repairs stale tab placement and duplicate bindings', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const liveWin = await addChild(tree.root, {
      id: 'live-win',
      type: 'window',
      windowId: 50,
      loaded: true
    });
    const staleWin = await addChild(tree.root, {
      id: 'stale-win',
      type: 'window',
      windowId: 60,
      loaded: true
    });
    const liveTab = await addChild(liveWin, {
      id: 'live-tab',
      tabId: 10,
      windowId: 50,
      url: 'https://example.com/old',
      title: 'Old title',
      loaded: true
    });
    const staleTab = await addChild(staleWin, {
      id: 'stale-tab',
      tabId: 11,
      windowId: 60,
      url: 'https://example.com/stale',
      loaded: true
    });

    api.windows.getAll = async () => ([
      {
        id: 50,
        focused: true,
        tabs: [
          {
            id: 11,
            index: 0,
            url: 'https://example.com/live',
            title: 'Live title',
            active: true,
            discarded: false,
            frozen: false,
            hidden: false,
            incognito: false,
            lastAccessed: 123
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(liveTab.tabId, 11, 'Live tab should attach to the open browser tab');
    assertEqual(liveTab.url, 'https://example.com/live', 'Live tab URL should refresh from browser');
    assertEqual(liveTab.title, 'Live title', 'Live tab title should refresh from browser');
    assertEqual(liveTab.parent.id, 'live-win', 'Live tab should stay under the active window');
    assertEqual(staleTab.tabId, undefined, 'Stale duplicate should lose the tab binding');
    assertEqual(staleTab.loaded, false, 'Stale duplicate should be unloaded');
    assertEqual(tree.getNodeByTabId(11).id, 'live-tab', 'Lookup should resolve to repaired tab');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree adjusts index fallback after pinned tabs', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 77,
      loaded: true
    });
    const first = await addChild(win, {
      id: 't1',
      url: 'https://saved.example.com/one',
      loaded: false
    });
    const second = await addChild(win, {
      id: 't2',
      url: 'https://saved.example.com/two',
      loaded: false
    });

    api.windows.getAll = async () => ([
      {
        id: 77,
        focused: true,
        tabs: [
          {
            id: 90,
            index: 0,
            pinned: true,
            url: 'https://pinned.example.com/mail',
            title: 'Pinned mail',
            active: false
          },
          {
            id: 91,
            index: 1,
            pinned: false,
            url: 'https://live.example.com/one',
            title: 'Live one',
            active: true
          },
          {
            id: 92,
            index: 2,
            pinned: false,
            url: 'https://live.example.com/two',
            title: 'Live two',
            active: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(first.tabId, 91, 'First saved node should map to first unpinned tab');
    assertEqual(second.tabId, 92, 'Second saved node should map to second unpinned tab');
    assertEqual(first.url, 'https://live.example.com/one',
      'First saved node should refresh from first unpinned tab');
    assertEqual(second.url, 'https://live.example.com/two',
      'Second saved node should refresh from second unpinned tab');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree skips saved pinned nodes during index fallback', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 88,
      loaded: true
    });
    const pinned = await addChild(win, {
      id: 'pinned',
      tabId: 80,
      windowId: 88,
      url: 'https://old-pinned.example.com',
      loaded: true,
      pinned: true
    });
    const first = await addChild(win, {
      id: 'first',
      url: 'https://saved.example.com/one',
      loaded: false
    });

    api.windows.getAll = async () => ([
      {
        id: 88,
        focused: true,
        tabs: [
          {
            id: 80,
            index: 0,
            pinned: true,
            url: 'https://new-pinned.example.com',
            title: 'New pinned',
            active: false
          },
          {
            id: 81,
            index: 1,
            pinned: false,
            url: 'https://live.example.com/one',
            title: 'Live one',
            active: true
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(pinned.pinned, true,
      'Persisted pinned node should stay pinned after fallback matching');
    assertEqual(first.tabId, 81,
      'First unpinned live tab should attach to first unpinned saved node');
    assertEqual(first.pinned, false,
      'First unpinned saved node should stay unpinned');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree fallback matches saved pinned nodes', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 89,
      loaded: true
    });
    const pinned = await addChild(win, {
      id: 'pinned',
      url: 'https://old-pinned.example.com',
      loaded: false,
      pinned: true
    });
    const first = await addChild(win, {
      id: 'first',
      url: 'https://saved.example.com/one',
      loaded: false
    });

    api.windows.getAll = async () => ([
      {
        id: 89,
        focused: true,
        tabs: [
          {
            id: 90,
            index: 0,
            pinned: true,
            url: 'https://new-pinned.example.com',
            title: 'New pinned',
            active: false
          },
          {
            id: 91,
            index: 1,
            pinned: false,
            url: 'https://live.example.com/one',
            title: 'Live one',
            active: true
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(pinned.tabId, 90,
      'Pinned browser tab should fallback-match saved pinned node');
    assertEqual(pinned.pinned, true,
      'Pinned fallback match should keep pinned state');
    assertEqual(first.tabId, 91,
      'Unpinned browser tab should still fallback-match unpinned node');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree repositions tab that became pinned', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 90,
      loaded: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 91,
      windowId: 90,
      url: 'https://regular.example.com',
      loaded: true
    });
    const becamePinned = await addChild(win, {
      id: 'became-pinned',
      tabId: 92,
      windowId: 90,
      url: 'https://pin.example.com',
      loaded: true,
      pinned: false
    });

    api.windows.getAll = async () => ([
      {
        id: 90,
        focused: true,
        tabs: [
          {
            id: 92,
            index: 0,
            pinned: true,
            url: 'https://pin.example.com',
            title: 'Pinned',
            active: true
          },
          {
            id: 91,
            index: 1,
            pinned: false,
            url: 'https://regular.example.com',
            title: 'Regular',
            active: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(becamePinned.pinned, true,
      'Matched node should refresh pinned state from browser');
    assertEqual(win.nodes[0], becamePinned,
      'Pinned node should move into the pinned prefix');
    assertEqual(win.nodes[1], regular,
      'Regular node should remain after pinned prefix');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree repositions tab that became unpinned', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 91,
      loaded: true
    });
    const becameUnpinned = await addChild(win, {
      id: 'became-unpinned',
      tabId: 100,
      windowId: 91,
      url: 'https://pin.example.com',
      loaded: true,
      pinned: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 101,
      windowId: 91,
      url: 'https://regular.example.com',
      loaded: true
    });

    api.windows.getAll = async () => ([
      {
        id: 91,
        focused: true,
        tabs: [
          {
            id: 101,
            index: 0,
            pinned: false,
            url: 'https://regular.example.com',
            title: 'Regular',
            active: false
          },
          {
            id: 100,
            index: 1,
            pinned: false,
            url: 'https://pin.example.com',
            title: 'Unpinned',
            active: true
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(becameUnpinned.pinned, false,
      'Matched node should clear stale pinned state');
    assertEqual(win.nodes[0], regular,
      'First browser movable tab should become first tree tab');
    assertEqual(win.nodes[1], becameUnpinned,
      'Formerly pinned tab should move into movable order');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree inserts unmatched pinned tabs in pinned prefix', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 92,
      loaded: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 111,
      windowId: 92,
      url: 'https://regular.example.com',
      loaded: true
    });

    api.windows.getAll = async () => ([
      {
        id: 92,
        focused: true,
        tabs: [
          {
            id: 110,
            index: 0,
            pinned: true,
            url: 'https://new-pinned.example.com',
            title: 'New pinned',
            active: true
          },
          {
            id: 111,
            index: 1,
            pinned: false,
            url: 'https://regular.example.com',
            title: 'Regular',
            active: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    const created = tree.getNodeByTabId(110);
    assert(created, 'Should create node for unmatched pinned browser tab');
    assertEqual(created.pinned, true, 'Created node should be pinned');
    assertEqual(win.nodes[0], created,
      'Unmatched pinned tab should insert before regular tabs');
    assertEqual(win.nodes[1], regular,
      'Regular tab should remain after new pinned tab');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree matches duplicate URLs by pinned state first', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 93,
      loaded: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      url: 'https://same.example.com',
      loaded: false,
      pinned: false
    });
    const pinned = await addChild(win, {
      id: 'pinned',
      url: 'https://same.example.com',
      loaded: false,
      pinned: true
    });

    api.windows.getAll = async () => ([
      {
        id: 93,
        focused: true,
        tabs: [
          {
            id: 120,
            index: 0,
            pinned: true,
            url: 'https://same.example.com',
            title: 'Pinned same',
            active: false
          },
          {
            id: 121,
            index: 1,
            pinned: false,
            url: 'https://same.example.com',
            title: 'Regular same',
            active: true
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(pinned.tabId, 120,
      'Pinned live tab should attach to saved pinned duplicate');
    assertEqual(regular.tabId, 121,
      'Unpinned live tab should attach to saved unpinned duplicate');
    assertEqual(win.nodes[0], pinned,
      'Pinned duplicate should move to pinned prefix');
    assertEqual(win.nodes[1], regular,
      'Regular duplicate should remain after pinned duplicate');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree prefers URL match before raw index fallback', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const first = await addChild(win, {
      id: 'first',
      url: 'https://example.com/a',
      loaded: true
    });
    const second = await addChild(win, {
      id: 'second',
      url: 'https://example.com/b',
      loaded: true
    });

    api.windows.getAll = async () => ([
      {
        id: 1,
        focused: true,
        tabs: [
          {
            id: 20,
            index: 0,
            windowId: 1,
            url: 'https://example.com/b',
            title: 'B',
            pinned: false
          },
          {
            id: 10,
            index: 1,
            windowId: 1,
            url: 'https://example.com/a',
            title: 'A',
            pinned: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(second.tabId, 20,
      'Live tab should bind by URL before same-index fallback');
    assertEqual(first.tabId, 10,
      'Other saved tab should still bind to its matching URL');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('mergeOpenWindowsIntoTree preserves saved tree shape for linked tabs', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const group = await addChild(win, {
      id: 'group',
      label: 'Saved group'
    });
    const nested = await addChild(group, {
      id: 'nested',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/nested',
      loaded: true
    });
    const sibling = await addChild(win, {
      id: 'sibling',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/sibling',
      loaded: true
    });

    api.windows.getAll = async () => ([
      {
        id: 1,
        focused: true,
        tabs: [
          {
            id: 11,
            index: 0,
            windowId: 1,
            url: 'https://example.com/sibling',
            title: 'Sibling',
            pinned: false
          },
          {
            id: 10,
            index: 1,
            windowId: 1,
            url: 'https://example.com/nested',
            title: 'Nested',
            pinned: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(win.nodes[0], group,
      'Merge should not flatten saved group to match browser tab order');
    assertEqual(group.nodes[0], nested,
      'Nested linked tab should remain under its saved parent');
    assertEqual(win.nodes[1], sibling,
      'Sibling should remain in saved tree position');
  } finally {
    api.windows.getAll = originalGetAll;
  }
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

test('runReconcile startup does not emit refresh before tree load', async () => {
  const originalGetAll = api.windows.getAll;
  const originalSendMessage = api.runtime.sendMessage;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

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

    const messages = [];
    api.windows.getAll = async () => ([]);
    api.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      return {};
    };

    await runReconcile.call(bkgd, { reason: 'startup' });

    assert(! messages.some((msg) => msg && msg.msg === 'tree_refreshAll'),
      'Startup reconcile should not emit refresh before initial tree load');
  } finally {
    api.windows.getAll = originalGetAll;
    api.runtime.sendMessage = originalSendMessage;
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

test('onTabMoved updates tree without browser reorder feedback', async () => {
  const originalGet = api.tabs.get;
  const originalMove = api.tabs.move;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 'first-pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    let browserMoveCalls = 0;
    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });
    api.tabs.move = async () => { browserMoveCalls += 1; };

    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 1,
      toIndex: 0
    });

    assertEqual(win.nodes[0], moved,
      'Browser move should still update tree order');
    assertEqual(browserMoveCalls, 0,
      'Browser-originated move should not call tabs.move');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.move = originalMove;
  }
});

test('onTabMoved ignores extension-generated reorder events', async () => {
  const originalGet = api.tabs.get;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const first = await addChild(win, {
      id: 'first',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true
    });

    let tabLookupCalls = 0;
    api.tabs.get = async (tabId) => {
      tabLookupCalls += 1;
      return { id: tabId, windowId: 1, pinned: false };
    };

    tree.suppressTabMovedEvents(1, [11]);
    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 1,
      toIndex: 0
    });

    assertEqual(tabLookupCalls, 0,
      'Suppressed extension move should not query browser tab state');
    assertEqual(win.nodes[0], first,
      'Suppressed extension move should not change tree order');
    assertEqual(win.nodes[1], moved,
      'Suppressed extension move should leave moved tab in tree position');
  } finally {
    api.tabs.get = originalGet;
  }
});

test('failed tab reorder clears suppressed move events', async () => {
  const originalQuery = api.tabs.query;
  const originalMove = api.tabs.move;
  const originalConsoleError = console.error;
  try {
    const tree = createTree({});
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 'first',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 'second',
      tabId: 11,
      windowId: 1,
      loaded: true
    });

    console.error = () => {};
    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: false },
      { id: 11, index: 1, windowId: 1, pinned: false }
    ]);
    api.tabs.move = async () => {
      throw new Error('unexpected move failure');
    };

    await win.reorderAllTabsInThisWindow();

    assertEqual(tree.isSuppressedTabMovedEvent(1, 10), false,
      'Failed reorder should clear suppression for first tab');
    assertEqual(tree.isSuppressedTabMovedEvent(1, 11), false,
      'Failed reorder should clear suppression for second tab');
  } finally {
    console.error = originalConsoleError;
    api.tabs.query = originalQuery;
    api.tabs.move = originalMove;
  }
});

test('onTabMoved moves only the browser tab node, not its children', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  const originalMove = api.tabs.move;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const child = await addChild(moved, {
      id: 'child',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const sibling = await addChild(win, {
      id: 'sibling',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    let browserMoveCalls = 0;
    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: false },
      { id: 12, index: 1, windowId: 1, pinned: false },
      { id: 10, index: 2, windowId: 1, pinned: false }
    ]);
    api.tabs.move = async () => { browserMoveCalls += 1; };

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 2
    });

    assertEqual(moved.nodes.length, 0,
      'Moved browser tab node should not keep its children');
    assertEqual(win.nodes[0], child,
      'Former child should remain at the original flat position');
    assertEqual(win.nodes[1], sibling,
      'Existing sibling should remain before the moved tab');
    assertEqual(win.nodes[2], moved,
      'Moved tab should land at the browser-reported flat index');
    assertEqual(browserMoveCalls, 0,
      'Browser-originated move should not call tabs.move');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
    api.tabs.move = originalMove;
  }
});

test('onTabMoved can insert moved parent between promoted children', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'a',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const childB = await addChild(moved, {
      id: 'b',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const childC = await addChild(moved, {
      id: 'c',
      tabId: 12,
      windowId: 1,
      loaded: true
    });
    const siblingD = await addChild(win, {
      id: 'd',
      tabId: 13,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: false },
      { id: 10, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false },
      { id: 13, index: 3, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    assertEqual(moved.nodes.length, 0,
      'Moved parent tab should not keep promoted children');
    assertEqual(win.nodes.map((node) => node.id).join(','), 'b,a,c,d',
      'Browser order B,A,C,D should become sibling order B,A,C,D');
    assertEqual(childB.parent, win, 'Child B should be promoted');
    assertEqual(childC.parent, win, 'Child C should be promoted');
    assertEqual(siblingD.parent, win, 'Sibling D should remain in window');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
  }
});

test('onTabMoved keeps moved parent nested after last promoted child', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const parentA = await addChild(win, {
      id: 'a',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const childB = await addChild(parentA, {
      id: 'b',
      tabId: 11,
      windowId: 1,
      loaded: true
    });
    const movedC = await addChild(parentA, {
      id: 'c',
      tabId: 12,
      windowId: 1,
      loaded: true
    });
    const grandchildD = await addChild(movedC, {
      id: 'd',
      tabId: 13,
      windowId: 1,
      loaded: true
    });
    const grandchildE = await addChild(movedC, {
      id: 'e',
      tabId: 14,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: false },
      { id: 11, index: 1, windowId: 1, pinned: false },
      { id: 13, index: 2, windowId: 1, pinned: false },
      { id: 14, index: 3, windowId: 1, pinned: false },
      { id: 12, index: 4, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(12, {
      windowId: 1,
      fromIndex: 2,
      toIndex: 4
    });

    assertEqual(movedC.nodes.length, 0,
      'Moved parent tab should not keep promoted children');
    assertEqual(win.nodes.map((node) => node.id).join(','), 'a',
      'Top-level window children should remain unchanged');
    assertEqual(parentA.nodes.map((node) => node.id).join(','), 'b,d,e,c',
      'Moved parent should remain nested under A after promoted children');
    assertEqual(childB.parent, parentA, 'B should remain under A');
    assertEqual(grandchildD.parent, parentA, 'D should be promoted under A');
    assertEqual(grandchildE.parent, parentA, 'E should be promoted under A');
    assertEqual(movedC.parent, parentA, 'C should remain under A');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
  }
});

test('onTabCreated places pinned tab among pinned siblings', async () => {
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    tree.reorderTabsOnCreate = false;
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const firstPinned = await addChild(win, {
      id: 'first-pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: true },
      { id: 11, index: 1, windowId: 1, pinned: true },
      { id: 12, index: 2, windowId: 1, pinned: false }
    ]);

    await tree.onTabCreated({
      id: 11,
      index: 1,
      windowId: 1,
      pinned: true,
      url: 'https://example.com/pinned-two',
      title: 'Pinned two',
      active: false
    });

    const created = tree.getNodeByTabId(11);
    assert(created, 'Should create node for pinned tab');
    assertEqual(created.pinned, true, 'Created node should be marked pinned');
    assertEqual(win.nodes[0], firstPinned,
      'Existing pinned tab should stay first');
    assertEqual(win.nodes[1], created,
      'New pinned tab should insert after existing pinned tab');
    assertEqual(win.nodes[2], regular,
      'Regular tab should stay after pinned tabs');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('onTabMoved maps browser indexes after pinned tabs', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const pinned = await addChild(win, {
      id: 'pinned',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/pinned',
      loaded: true,
      pinned: true
    });
    const other = await addChild(win, {
      id: 'other',
      tabId: 12,
      windowId: 1,
      url: 'https://example.com/other',
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/moved',
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: true },
      { id: 11, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 2,
      toIndex: 1
    });

    assertEqual(win.nodes[0], pinned,
      'Pinned tab should stay in the pinned prefix');
    assertEqual(win.nodes[1], moved,
      'Moved unpinned tab should use index after pinned prefix');
    assertEqual(win.nodes[2], other,
      'Other unpinned tab should follow moved tab');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
  }
});

test('onTabUpdated pinned fallback moves tab into pinned prefix', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const regular = await addChild(win, {
    id: 'regular',
    tabId: 12,
    windowId: 1,
    loaded: true
  });
  const moved = await addChild(win, {
    id: 'moved',
    tabId: 11,
    windowId: 1,
    loaded: true,
    pinned: false
  });

  await tree.onTabUpdated(11, { pinned: true }, {
    id: 11,
    windowId: 1,
    index: 0,
    pinned: true,
    title: 'Pinned',
    url: 'https://example.com/pinned'
  });

  assertEqual(moved.pinned, true, 'Tab should update to pinned');
  assertEqual(win.nodes[0], moved,
    'Pinned update should move tab into pinned prefix');
  assertEqual(win.nodes[1], regular,
    'Regular tab should follow pinned tab');
});

test('onTabUpdated unpinned fallback moves tab out of pinned prefix', async () => {
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const stillPinned = await addChild(win, {
      id: 'still-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });

    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: true },
      { id: 10, index: 1, windowId: 1, pinned: false }
    ]);

    await tree.onTabUpdated(10, { pinned: false }, {
      id: 10,
      windowId: 1,
      index: 1,
      pinned: false,
      title: 'Unpinned',
      url: 'https://example.com/unpinned'
    });

    assertEqual(moved.pinned, false, 'Tab should update to unpinned');
    assertEqual(win.nodes[0], stillPinned,
      'Remaining pinned tab should stay in pinned prefix');
    assertEqual(win.nodes[1], moved,
      'Unpinned update should move tab after pinned prefix');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('onTabMoved reorders pinned tabs within pinned prefix', async () => {
  const originalGet = api.tabs.get;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const firstPinned = await addChild(win, {
      id: 'first-pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 1,
      toIndex: 0
    });

    assertEqual(win.nodes[0], moved,
      'Moved pinned tab should move within pinned prefix');
    assertEqual(win.nodes[1], firstPinned,
      'Previous first pinned tab should shift after moved tab');
  } finally {
    api.tabs.get = originalGet;
  }
});

test('onTabMoved reorders pinned tabs right within pinned prefix', async () => {
  const originalGet = api.tabs.get;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const secondPinned = await addChild(win, {
      id: 'second-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    assertEqual(win.nodes[0], secondPinned,
      'Second pinned tab should shift before moved pinned tab');
    assertEqual(win.nodes[1], moved,
      'Moved pinned tab should land at requested pinned index');
    assertEqual(win.nodes[2], regular,
      'Regular tab should remain after pinned tabs');
  } finally {
    api.tabs.get = originalGet;
  }
});

test('onTabMoved moves unpinned tab out of pinned prefix', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const stillPinned = await addChild(win, {
      id: 'still-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const regular = await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: true },
      { id: 10, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    assertEqual(moved.pinned, false,
      'Moved node should refresh to unpinned state');
    assertEqual(win.nodes[0], stillPinned,
      'Remaining pinned tab should stay in pinned prefix');
    assertEqual(win.nodes[1], moved,
      'Unpinned tab should move after remaining pinned tabs');
    assertEqual(win.nodes[2], regular,
      'Regular tab should remain after moved tab');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
  }
});

test('onTabAttached corrects pinned index in same window', async () => {
  const originalGet = api.tabs.get;
  try {
    const tree = createTree({ windowsLoading: [] });
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const secondPinned = await addChild(win, {
      id: 'second-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabAttached(10, {
      newWindowId: 1,
      newPosition: 1
    });

    assertEqual(win.nodes[0], secondPinned,
      'Second pinned tab should shift before moved tab');
    assertEqual(win.nodes[1], moved,
      'Attached pinned tab should move to requested same-window index');
  } finally {
    api.tabs.get = originalGet;
  }
});

test('TreeStore onTabMoved maps browser indexes after pinned tabs', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 'pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const other = await addChild(win, {
      id: 'other',
      tabId: 12,
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 10, index: 0, windowId: 1, pinned: true },
      { id: 11, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 2,
      toIndex: 1
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue an ensureMoved op');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move the requested tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Moved tab should target the window root');
    assertEqual(calls[0][1].destIndex, other.indexOf(),
      'Move destination should use the unpinned tab index');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabMoved ignores extension-generated reorder events', async () => {
  const originalGet = api.tabs.get;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const first = await addChild(win, {
      id: 'first',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true
    });

    let tabLookupCalls = 0;
    api.tabs.get = async (tabId) => {
      tabLookupCalls += 1;
      return { id: tabId, windowId: 1, pinned: false };
    };

    tree.suppressTabMovedEvents(1, [11]);
    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 1,
      toIndex: 0
    });

    assertEqual(tabLookupCalls, 0,
      'Suppressed extension move should not query browser tab state');
    assertEqual(calls.length, 0,
      'Suppressed extension move should not enqueue a move intent');
    assertEqual(win.nodes[0], first,
      'Suppressed extension move should not change tree order');
    assertEqual(win.nodes[1], moved,
      'Suppressed extension move should leave moved tab in tree position');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabUpdated pinned fallback enqueues move', async () => {
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: false
    });

    await tree.onTabUpdated(11, { pinned: true }, {
      id: 11,
      windowId: 1,
      index: 0,
      pinned: true,
      title: 'Pinned',
      url: 'https://example.com/pinned'
    });

    assertEqual(moved.pinned, true, 'Tab should update to pinned');
    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue ensureMoved');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move pinned tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Pinned tab should target window root');
    assertEqual(calls[0][1].destIndex, 0,
      'Pinned tab should target pinned prefix start');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabMoved reorders pinned tabs within pinned prefix', async () => {
  const originalGet = api.tabs.get;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const firstPinned = await addChild(win, {
      id: 'first-pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabMoved(11, {
      windowId: 1,
      fromIndex: 1,
      toIndex: 0
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue an ensureMoved op');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move the pinned tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Pinned tab should stay under the same window');
    assertEqual(calls[0][1].destIndex, firstPinned.indexOf(),
      'Pinned tab should target the requested pinned index');
    assertEqual(calls[0][1].skipTabReorder, true,
      'Browser-originated move should not reorder browser tabs again');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabMoved reorders pinned tabs right within pinned prefix', async () => {
  const originalGet = api.tabs.get;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const secondPinned = await addChild(win, {
      id: 'second-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue an ensureMoved op');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move the pinned tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Pinned tab should stay under the same window');
    assertEqual(calls[0][1].destIndex, secondPinned.indexOf() + 1,
      'Pinned tab should target the position after the next pinned tab');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabMoved moves unpinned tab out of pinned prefix', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const stillPinned = await addChild(win, {
      id: 'still-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    await addChild(win, {
      id: 'regular',
      tabId: 12,
      windowId: 1,
      loaded: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 11, index: 0, windowId: 1, pinned: true },
      { id: 10, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false }
    ]);

    await tree.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });

    assertEqual(moved.pinned, false,
      'Moved node should refresh to unpinned state');
    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move the unpinned tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Moved tab should stay under same window');
    assertEqual(calls[0][1].destIndex, stillPinned.indexOf() + 1,
      'Moved tab should target the position after remaining pinned tabs');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabAttached moves pinned tabs between windows', async () => {
  const originalGet = api.tabs.get;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      windowsLoading: [],
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const oldWin = await addChild(tree.root, {
      id: 'old-win',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const newWin = await addChild(tree.root, {
      id: 'new-win',
      type: 'window',
      windowId: 2,
      loaded: true
    });
    const existingPinned = await addChild(newWin, {
      id: 'existing-pinned',
      tabId: 20,
      windowId: 2,
      loaded: true,
      pinned: true
    });
    await addChild(newWin, {
      id: 'regular',
      tabId: 21,
      windowId: 2,
      loaded: true
    });
    const pinned = await addChild(oldWin, {
      id: 'pinned',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 2,
      pinned: true
    });

    await tree.onTabAttached(10, {
      newWindowId: 2,
      newPosition: 1
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue an ensureMoved op');
    assertEqual(calls[0][1].nodeId, pinned.id, 'Should move attached pinned tab');
    assertEqual(calls[0][1].destParentId, newWin.id,
      'Pinned tab should move under the new window');
    assertEqual(calls[0][1].destIndex, existingPinned.indexOf() + 1,
      'Pinned tab should insert after existing pinned tabs');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabAttached corrects pinned index in same window', async () => {
  const originalGet = api.tabs.get;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      windowsLoading: [],
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const moved = await addChild(win, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: true
    });
    const secondPinned = await addChild(win, {
      id: 'second-pinned',
      tabId: 11,
      windowId: 1,
      loaded: true,
      pinned: true
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 1,
      pinned: true
    });

    await tree.onTabAttached(10, {
      newWindowId: 1,
      newPosition: 1
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move attached pinned tab');
    assertEqual(calls[0][1].destParentId, win.id,
      'Pinned tab should stay under same window');
    assertEqual(calls[0][1].destIndex, secondPinned.indexOf() + 1,
      'Pinned tab should target requested same-window pinned index');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabAttached inserts first unpinned tab after pinned prefix', async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  const originalIndexedDb = globalThis.indexedDB;
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
    const calls = [];
    const bkgd = {
      enqueueIntent: async (...args) => { calls.push(args); },
      windowsLoading: [],
      opsQueue: null
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();

    const oldWin = await addChild(tree.root, {
      id: 'old-win',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const newWin = await addChild(tree.root, {
      id: 'new-win',
      type: 'window',
      windowId: 2,
      loaded: true
    });
    const existingPinned = await addChild(newWin, {
      id: 'existing-pinned',
      tabId: 20,
      windowId: 2,
      loaded: true,
      pinned: true
    });
    const moved = await addChild(oldWin, {
      id: 'moved',
      tabId: 10,
      windowId: 1,
      loaded: true,
      pinned: false
    });

    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 2,
      pinned: false
    });
    api.tabs.query = async () => ([
      { id: 20, index: 0, windowId: 2, pinned: true },
      { id: 10, index: 1, windowId: 2, pinned: false }
    ]);

    await tree.onTabAttached(10, {
      newWindowId: 2,
      newPosition: 1
    });

    assertEqual(calls.length, 1, 'Should enqueue one move intent');
    assertEqual(calls[0][0], 'ensureMoved', 'Should enqueue an ensureMoved op');
    assertEqual(calls[0][1].nodeId, moved.id, 'Should move attached tab');
    assertEqual(calls[0][1].destParentId, newWin.id,
      'Attached tab should move under the new window');
    assertEqual(calls[0][1].destIndex, existingPinned.indexOf() + 1,
      'First unpinned tab should insert after the pinned prefix');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
    globalThis.indexedDB = originalIndexedDb;
  }
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

test('onWindowFocusChanged marks the focused window active', async () => {
  const originalGet = api.windows.get;
  try {
    api.windows.get = async () => ({
      width: 800,
      height: 600,
      left: 10,
      top: 20,
      state: 'normal',
      incognito: false
    });

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const win1 = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      active: true
    });
    const win2 = await addChild(tree.root, {
      id: 'w2',
      type: 'window',
      windowId: 2,
      active: false
    });

    await bkgd.onWindowFocusChanged(2);

    assertEqual(win1.active, false, 'Should clear active on unfocused window');
    assertEqual(win2.active, true, 'Should mark focused window active');
  } finally {
    api.windows.get = originalGet;
  }
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
