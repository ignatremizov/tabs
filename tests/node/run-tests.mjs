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
      session: { get: async () => ({}), set: async () => ({}) },
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
let runReconcile;
let TestNode;
let ThemedPage;
let PresetOption;
let IDB;
let NodeStore;
let TreeView;
let jsonSchema;
let compareBrowserVersions;
let buildEventName;
let normalizeKeyBinding;
let defaultKeyBindings;
let normalizeKeyBindingOverrides;

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

test('compareBrowserVersions compares numeric version components', () => {
  assert(compareBrowserVersions('147.0.10', '147.0.2') > 0,
    'A two-digit patch version should compare numerically');
  assert(compareBrowserVersions('115.10', '147.0.2') < 0,
    'An older major version should remain older');
  assertEqual(compareBrowserVersions('147.0.2esr', '147.0.2'), 0,
    'Non-numeric version suffixes should not change equal components');
});

test('key binding names use canonical letter and modifier casing', () => {
  assertEqual(normalizeKeyBinding('q'), 'Q',
    'Unmodified letters should be uppercase');
  assertEqual(
    normalizeKeyBinding('control+shift+arrowup'),
    'Shift+Ctrl+ArrowUp',
    'Modifiers and named keys should use canonical names and order'
  );
  assertEqual(normalizeKeyBinding('Shift++'), 'Shift++',
    'A plus key should survive modifier parsing');

  const event = {
    type: 'keydown',
    key: 'q',
    shiftKey: false,
    ctrlKey: true,
    altKey: false,
    metaKey: false
  };
  assertEqual(buildEventName(event), 'Ctrl+Q',
    'Captured keyboard events should use the same canonical form');
  assertEqual(defaultKeyBindings.D, 'deleteNode',
    'Default letter bindings should use uppercase keys');
  assertEqual(defaultKeyBindings.d, undefined,
    'Lowercase default aliases should not hide casing mismatches');
  assertEqual(defaultKeyBindings['Ctrl+ArrowUp'], 'cursorPrevSibling',
    'Ctrl+Up should jump toward a previous sibling or parent');
  assertEqual(defaultKeyBindings['Ctrl+ArrowDown'], 'cursorNextSibling',
    'Ctrl+Down should skip the current subtree');
  assertEqual(
    defaultKeyBindings['Shift+Ctrl+ArrowLeft'],
    'promoteChildren',
    'The child-promotion action should have a power-user default'
  );
});

test('legacy load and unload bindings collapse into one toggle binding', () => {
  const bindings = normalizeKeyBindingOverrides({
    loadNode: '',
    unloadNode: 'q',
    deleteNode: 'd'
  });

  assertEqual(bindings.toggleLoad, 'Q',
    'The existing unload key should become the combined binding');
  assertEqual(bindings.deleteNode, 'D',
    'Other stored letter bindings should also be canonicalized');
  assertEqual(bindings.loadNode, undefined,
    'Legacy load bindings should not remain as hidden overrides');
  assertEqual(bindings.unloadNode, undefined,
    'Legacy unload bindings should not remain as hidden overrides');
});

test('browser manifests expose one highlighted-node load toggle',
async () => {
  const fs = await import('node:fs');
  for (const filename of ['manifest.json', 'manifest-ff.json']) {
    const manifestUrl = new URL(`../../${filename}`, import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
    const commands = manifest.commands || {};
    assert(commands.toggleLoad,
      `${filename} should expose the combined load/unload command`);
    assertEqual(commands.loadNode, undefined,
      `${filename} should not expose a separate load command`);
    assertEqual(commands.unloadNode, undefined,
      `${filename} should not expose a separate unload command`);
  }
});


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
    await emit('notify_test', { foo: 'bar' });
    assert(notice, 'Should report emit failure');
    assertEqual(notice.name, 'notify_test', 'Should include message name');
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

test('emit sends once when retries are disabled', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalOnFailure = emit.onFailure;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  const originalCooldown = emit.failureCooldownMs;
  const originalConsoleError = console.error;
  let calls = 0;
  try {
    console.error = () => {};
    api.runtime.sendMessage = async () => {
      calls += 1;
      throw new Error('offline');
    };
    emit.onFailure = null;
    emit.maxTries = 5;
    emit.retryDelayMs = 0;
    emit.failureCooldownMs = 0;

    await emit('notify_testOnce', {}, { retry: false });

    assertEqual(calls, 1,
      'Disabling retries should still make exactly one delivery attempt');
  } finally {
    console.error = originalConsoleError;
    api.runtime.sendMessage = originalSendMessage;
    emit.onFailure = originalOnFailure;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
    emit.failureCooldownMs = originalCooldown;
  }
});

test('emit rejects undelivered tree mutations after all attempts', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  const originalCooldown = emit.failureCooldownMs;
  const originalConsoleError = console.error;
  let calls = 0;
  let failure;
  try {
    console.error = () => {};
    api.runtime.sendMessage = async () => {
      calls += 1;
      throw new Error('worker unavailable');
    };
    emit.maxTries = 3;
    emit.retryDelayMs = 0;
    emit.failureCooldownMs = 0;

    try {
      await emit('tree_nodeChanged', { nodeId: 'n1' });
    } catch (err) {
      failure = err;
    }

    assertEqual(calls, 3, 'Should use the configured number of attempts');
    assert(failure, 'An undelivered tree mutation should reject');
    assert(failure.message.includes('worker unavailable'),
      'Delivery rejection should preserve the underlying error');
  } finally {
    console.error = originalConsoleError;
    api.runtime.sendMessage = originalSendMessage;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
    emit.failureCooldownMs = originalCooldown;
  }
});

test('emit retries tree mutations which receive no acknowledgement',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  let calls = 0;
  try {
    api.runtime.sendMessage = async () => {
      calls += 1;
      if (calls < 3) return undefined;
      return { result: 'ok persisted' };
    };
    emit.maxTries = 3;
    emit.retryDelayMs = 0;

    const response = await emit('tree_nodeChanged', { nodeId: 'n1' });

    assertEqual(calls, 3,
      'Missing persistence acknowledgements should be retried');
    assertEqual(response.result, 'ok persisted',
      'A later acknowledgement should complete the mutation');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
  }
});

test('background tree broadcasts do not require persistence responses',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalIsBkgd = emit.isBkgd;
  const originalBkgd = emit.bkgd;
  const originalMaxTries = emit.maxTries;
  let calls = 0;
  try {
    api.runtime.sendMessage = async () => {
      calls += 1;
      return undefined;
    };
    emit.isBkgd = true;
    emit.bkgd = { ports: [{}] };
    emit.maxTries = 3;

    const response = await emit('tree_nodeChanged', { nodeId: 'n1' });

    assertEqual(response, undefined,
      'A one-way background broadcast should not fabricate a response');
    assertEqual(calls, 1,
      'A view broadcast should not retry merely because views do not reply');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
    emit.isBkgd = originalIsBkgd;
    emit.bkgd = originalBkgd;
    emit.maxTries = originalMaxTries;
  }
});

test('emit rejects background requests which receive no response',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  let failure;
  try {
    api.runtime.sendMessage = async () => undefined;
    emit.maxTries = 1;
    emit.retryDelayMs = 0;

    try {
      await emit('bkgd_importBackupFile', {});
    } catch (err) {
      failure = err;
    }

    assert(failure,
      'A request without a background response should reject');
    assert(failure.message.includes('missing background response'),
      'The failure should explain that no handler responded');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
  }
});

test('emit reuses one request ID across background delivery retries',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const originalMaxTries = emit.maxTries;
  const originalRetryDelayMs = emit.retryDelayMs;
  const requestIds = [];
  const payload = { value: 1 };
  try {
    api.runtime.sendMessage = async (msg) => {
      requestIds.push(msg.requestId);
      if (requestIds.length === 1) return undefined;
      return { result: 'ok' };
    };
    emit.maxTries = 2;
    emit.retryDelayMs = 0;

    await emit('bkgd_nonIdempotentTest', payload);

    assert(requestIds[0],
      'Background requests should carry a generated request ID');
    assertEqual(requestIds[1], requestIds[0],
      'Transport retries should preserve the original request identity');
    assertEqual(payload.requestId, undefined,
      'Generated transport metadata should not mutate the caller payload');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
    emit.maxTries = originalMaxTries;
    emit.retryDelayMs = originalRetryDelayMs;
  }
});

test('background tree transfer returns one JSON payload', async () => {
  const nodes = {
    root: {
      id: 'root',
      nodes: ['saved-tab']
    },
    'saved-tab': {
      id: 'saved-tab',
      nodes: [],
      label: 'Saved tab'
    }
  };
  const bkgd = new Bkgd();
  bkgd.tree = {
    onMessageMutex: new Tree().onMessageMutex,
    serializeNodes: () => nodes
  };
  bkgd.resolveTreeLoaded();

  const response = await bkgd.bkgd_getTree({});

  assertEqual(typeof response, 'string',
    'Tree transfer should avoid structured-cloning the node graph');
  assertEqual(response, JSON.stringify(nodes),
    'Tree transfer should contain the serialized node hash');
});

test('Tree loads the background JSON payload', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const nodes = {
    root: {
      id: 'root',
      nodes: ['saved-tab']
    },
    'saved-tab': {
      id: 'saved-tab',
      nodes: [],
      label: 'Saved tab'
    }
  };
  let request;
  try {
    api.runtime.sendMessage = async (msg) => {
      request = msg;
      return JSON.stringify(nodes);
    };
    const tree = new Tree(TestNode);

    await tree.loadTreeFromBkgd();

    assertEqual(request.msg, 'bkgd_getTree',
      'Tree loading should use the tree transfer endpoint');
    assertEqual(tree.root.nodes.length, 1,
      'Tree loading should restore the root children');
    assertEqual(tree.nodes['saved-tab'].label, 'Saved tab',
      'Tree loading should restore node fields from JSON');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('Tree rejects invalid JSON without replacing its current nodes',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    const tree = new Tree(TestNode);
    const existing = await addChild(tree.root, {
      id: 'existing',
      label: 'Keep me'
    });
    const originalRoot = tree.root;

    for (const payload of ['{not json', JSON.stringify({})]) {
      api.runtime.sendMessage = async () => payload;
      let failure;
      try {
        await tree.loadTreeFromBkgd();
      } catch (err) {
        failure = err;
      }

      assert(failure,
        'Malformed tree payloads should reject the load');
      assertEqual(tree.root, originalRoot,
        'A failed load should preserve the current root');
      assertEqual(tree.nodes.existing, existing,
        'A failed load should preserve the current node cache');
    }
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('applyTreeMutation dispatches directly', async () => {
  const bkgd = new Bkgd();
  const payload = { nodeId: 'n1' };
  let received = null;
  bkgd.ensureMoved = async (value) => {
    received = value;
    return 'moved';
  };

  const result = await bkgd.applyTreeMutation('ensureMoved', payload);

  assertEqual(received, payload, 'Should pass the original payload directly');
  assertEqual(result, 'moved', 'Should return the direct mutation result');
});

test('IDB batches writes and resolves after transaction commit', async () => {
  const written = [];
  const deleted = [];
  let transaction;
  const idb = new IDB();
  idb.db = Promise.resolve({
    transaction: () => {
      transaction = {
        error: null,
        objectStore: () => ({
          put: record => written.push(record),
          delete: key => deleted.push(key)
        })
      };
      return transaction;
    }
  });

  let resolved = false;
  const write = idb.writeNodes([
    { id: 'one', toDict: () => ({ id: 'one' }) },
    { id: 'two', toDict: () => ({ id: 'two' }) }
  ], ['old']).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();

  assertEqual(written.length, 2, 'Both records should share one transaction');
  assertEqual(deleted[0], 'old', 'Delete should share the write transaction');
  assertEqual(resolved, false,
    'Write should remain pending until transaction completion');

  transaction.oncomplete();
  await write;
  assertEqual(resolved, true, 'Write should resolve after commit');
});

test('IDB rejects malformed JSON instead of leaving reads pending', async () => {
  const idb = new IDB();
  let getRequest;
  let cursorRequest;
  idb.db = Promise.resolve({
    transaction: (dbName) => ({
      objectStore: () => ({
        get: () => {
          getRequest = {};
          return getRequest;
        },
        openCursor: () => {
          cursorRequest = {};
          return cursorRequest;
        }
      })
    })
  });

  const objectRead = idb.loadNode('bad');
  await Promise.resolve();
  getRequest.onsuccess({
    target: { result: { data: '{not json' } }
  });
  let objectFailure;
  try {
    await objectRead;
  } catch (err) {
    objectFailure = err;
  }
  assert(objectFailure instanceof SyntaxError,
    'Malformed object JSON should reject the read promise');

  const allNodesRead = idb.loadAllNodes();
  await Promise.resolve();
  cursorRequest.onsuccess({
    target: {
      result: {
        value: { data: '{also bad' },
        continue: () => {}
      }
    }
  });
  let cursorFailure;
  try {
    await allNodesRead;
  } catch (err) {
    cursorFailure = err;
  }
  assert(cursorFailure instanceof SyntaxError,
    'Malformed cursor JSON should reject the read promise');
});

test('NodeStore batches move, pin, and parent records together', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes, deleteNodeIds) => {
      writes.push({ nodes: [...nodes], deleteNodeIds: [...deleteNodeIds] });
    }
  };
  const win = await addChild(tree.root, {
    id: 'w-batch',
    type: 'window'
  });
  const pinnedBranch = await addChild(win, {
    id: 'pinned-batch',
    label: 'Pinned'
  });
  const tab = await addChild(win, {
    id: 'tab-batch',
    url: 'https://example.com'
  });
  writes.length = 0;

  await tab.moveTo(pinnedBranch, 0, { reason: 'test' });

  assertEqual(writes.length, 1,
    'A structural move should commit with one database transaction');
  const savedIds = writes[0].nodes.map(node => node.id).sort();
  assertEqual(savedIds.join(','), 'pinned-batch,tab-batch,w-batch',
    'Move transaction should include the node and both parents');
  assertEqual(tab.pinned, true,
    'Pinned-branch state should be included in the same transaction');
  assertEqual(tab.parent, pinnedBranch,
    'Moved node should be attached before persistence begins');
});

test('NodeStore batches child promotion during a self-relative move',
async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push([...nodes]);
    }
  };
  const branch = await addChild(tree.root, {
    id: 'self-move-branch',
    label: 'Branch'
  });
  await addChild(branch, {
    id: 'self-move-child-one',
    label: 'One'
  });
  await addChild(branch, {
    id: 'self-move-child-two',
    label: 'Two'
  });
  writes.length = 0;

  await branch.moveTo(branch, 1, { reason: 'onTabMoved' });

  assertEqual(writes.length, 1,
    'Promoting children and moving their parent should use one transaction');
  const savedIds = writes[0].map((node) => node.id).sort();
  assertEqual(
    savedIds.join(','),
    'root,self-move-branch,self-move-child-one,self-move-child-two',
    'The self-relative move should persist every affected record together'
  );
});

test('Bkgd batches browser-driven child promotion and parent movement',
async () => {
  const bkgd = new Bkgd();
  const tree = new Tree(NodeStore);
  tree.bkgd = bkgd;
  bkgd.tree = tree;
  tree.runPersistenceBatch = (mutator, args) =>
    tree.root.withPersistenceBatch(mutator, args);
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push([...nodes]);
    }
  };
  const branch = await addChild(tree.root, {
    id: 'browser-batch-branch',
    label: 'Branch'
  });
  await addChild(branch, {
    id: 'browser-batch-child-one',
    label: 'One'
  });
  await addChild(branch, {
    id: 'browser-batch-child-two',
    label: 'Two'
  });
  await addChild(tree.root, {
    id: 'browser-batch-sibling',
    label: 'Sibling'
  });
  writes.length = 0;

  await bkgd.ensureMoved({
    nodeId: branch.id,
    destParentId: tree.root.id,
    destIndex: tree.root.nodes.length,
    reason: 'onTabMoved',
    skipTabReorder: true,
    moveNodeOnly: true
  });

  assertEqual(writes.length, 1,
    'A browser-driven structural move should use one transaction');
  const savedIds = writes[0].map((node) => node.id).sort();
  assertEqual(
    savedIds.join(','),
    'browser-batch-branch,browser-batch-child-one,'
      + 'browser-batch-child-two,root',
    'The browser move should persist promoted children with their parent'
  );
});

test('NodeStore batches preserved tabs while closing a window', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push([...nodes]);
    }
  };
  const win = await addChild(tree.root, {
    id: 'close-batch-window',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  await addChild(win, {
    id: 'close-batch-tab-one',
    tabId: 10,
    windowId: 1,
    url: 'https://example.com/one',
    loaded: true
  });
  await addChild(win, {
    id: 'close-batch-tab-two',
    tabId: 11,
    windowId: 1,
    url: 'https://example.com/two',
    loaded: true
  });
  writes.length = 0;

  await win.unload({
    reason: 'onWindowRemoved',
    keepTabsOnClose: true
  });

  assertEqual(writes.length, 1,
    'Closing a preserved window should use one database transaction');
  const savedIds = writes[0].map((node) => node.id).sort();
  assertEqual(
    savedIds.join(','),
    'close-batch-tab-one,close-batch-tab-two,close-batch-window',
    'The close transaction should include the window and its live tabs'
  );
});

test('NodeStore batches an active-tab switch into one transaction', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push([...nodes]);
    }
  };
  const win = await addChild(tree.root, {
    id: 'active-batch-window',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const previous = await addChild(win, {
    id: 'active-batch-previous',
    tabId: 10,
    windowId: 1,
    url: 'https://example.com/previous',
    loaded: true,
    active: true
  });
  const next = await addChild(win, {
    id: 'active-batch-next',
    tabId: 11,
    windowId: 1,
    url: 'https://example.com/next',
    loaded: true,
    active: false
  });
  writes.length = 0;

  await win.applyActiveTabUpdates(
    [previous, next],
    next,
    { reason: 'onTabActivated' }
  );

  assertEqual(writes.length, 1,
    'Changing old and new active tabs should use one database transaction');
  const savedIds = writes[0].map((node) => node.id).sort();
  assertEqual(
    savedIds.join(','),
    'active-batch-next,active-batch-previous',
    'The active-state transaction should contain both changed tabs'
  );
});

test('NodeStore deletes a subtree in one transaction', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes, deleteNodeIds) => {
      writes.push({
        nodes: [...nodes],
        deleteNodeIds: [...deleteNodeIds]
      });
    }
  };
  const win = await addChild(tree.root, {
    id: 'delete-batch-window',
    type: 'window'
  });
  const branch = await addChild(win, {
    id: 'delete-batch-branch',
    label: 'Branch'
  });
  await addChild(branch, {
    id: 'delete-batch-child-one',
    url: 'https://example.com/one'
  });
  await addChild(branch, {
    id: 'delete-batch-child-two',
    url: 'https://example.com/two'
  });
  writes.length = 0;

  await branch.deleteSelf({ reason: 'test' });

  assertEqual(writes.length, 1,
    'Deleting a branch should commit one database transaction');
  const deletedIds = writes[0].deleteNodeIds.sort();
  assertEqual(
    deletedIds.join(','),
    'delete-batch-branch,delete-batch-child-one,delete-batch-child-two',
    'The delete transaction should include the complete subtree'
  );
  assert(writes[0].nodes.includes(win),
    'The delete transaction should persist the surviving parent');
});

test('NodeStore batches bulk additions into one transaction', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push([...nodes]);
    }
  };

  await tree.root.withPersistenceBatch(async (args) => {
    const branch = await tree.root.addChild(0, {
      id: 'add-batch-branch',
      label: 'Imported branch'
    }, args);
    await branch.addChild(0, {
      id: 'add-batch-child-one',
      url: 'https://example.com/one'
    }, args);
    await branch.addChild(1, {
      id: 'add-batch-child-two',
      url: 'https://example.com/two'
    }, args);
  }, { reason: 'importFile' });

  assertEqual(writes.length, 1,
    'Bulk additions should commit one database transaction');
  const savedIds = writes[0].map((node) => node.id).sort();
  assertEqual(
    savedIds.join(','),
    'add-batch-branch,add-batch-child-one,add-batch-child-two,root',
    'The batch should include every new node and changed parent'
  );
});

test('NodeStore serializes persistence across different nodes', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  let writesInFlight = 0;
  let maxWritesInFlight = 0;
  tree.db = {
    writeNodes: async () => {
      writesInFlight += 1;
      maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      writesInFlight -= 1;
    }
  };
  const first = await addChild(tree.root, {
    id: 'shared-lock-first',
    label: 'First'
  });
  const second = await addChild(tree.root, {
    id: 'shared-lock-second',
    label: 'Second'
  });

  await Promise.all([
    first.setNotes('First updated', '', { reason: 'test' }),
    second.setNotes('Second updated', '', { reason: 'test' })
  ]);

  assertEqual(maxWritesInFlight, 1,
    'Persistence on separate nodes should share one tree-scoped mutex');
});

test('NodeStore ignores stale saves after a node is deleted', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  let writeCount = 0;
  tree.db = {
    writeNodes: async () => {
      writeCount += 1;
    }
  };
  const node = await addChild(tree.root, {
    id: 'stale-node',
    url: 'https://example.com'
  });
  writeCount = 0;
  delete tree.nodes[node.id];

  await node.persistNodes([node]);

  assertEqual(writeCount, 0,
    'A stale async callback must not recreate a deleted record');
});

test('window merge persists cleared stale descendant tab bindings',
async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push(nodes.map((node) => ({ ...node.toDict() })));
    }
  };
  const windowNode = await addChild(tree.root, {
    id: 'merge-window',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const staleTab = await addChild(windowNode, {
    id: 'stale-descendant',
    tabId: 42,
    windowId: 1,
    loaded: false,
    wasLoaded: true,
    active: true,
    url: 'https://example.com/stale'
  });
  writes.length = 0;

  await windowNode.unload({ reason: 'mergeOpenWindowsIntoTree' });

  assertEqual(staleTab.tabId, undefined,
    'Merge cleanup should clear an unloaded descendant tab ID');
  assertEqual(staleTab.windowId, undefined,
    'Merge cleanup should clear an unloaded descendant window ID');
  assertEqual(staleTab.active, false,
    'Merge cleanup should clear stale active state');
  assertEqual(writes.length, 1,
    'Window and descendant cleanup should use one database transaction');
  assert(writes.flat().some((record) =>
    (record.id === staleTab.id)
      && (record.tabId === undefined)
      && (record.windowId === undefined)
  ), 'Cleared descendant bindings should be written to storage');
});

test('NodeStore replaces duplicate browser bindings atomically',
async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push(nodes.map((node) => ({ ...node.toDict() })));
    }
  };
  const windowNode = await addChild(tree.root, {
    id: 'binding-window',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const stale = await addChild(windowNode, {
    id: 'binding-stale',
    tabId: 42,
    windowId: 1,
    loaded: true,
    url: 'https://example.com/stale'
  });
  const replacement = await addChild(windowNode, {
    id: 'binding-replacement',
    loaded: false,
    url: 'https://example.com/replacement'
  });
  writes.length = 0;

  await replacement.setTabFields({
    tabId: 42,
    windowId: 1,
    loaded: true
  }, { reason: 'onTabCreated' });

  assertEqual(writes.length, 1,
    'Clearing the stale binding and saving its replacement should be atomic');
  const savedIds = writes[0].map((record) => record.id).sort();
  assertEqual(savedIds.join(','), 'binding-replacement,binding-stale',
    'The binding transaction should include both affected nodes');
  assertEqual(stale.tabId, undefined,
    'The stale node should lose the claimed browser ID');
});

test('window matching persists a new browser window binding', async () => {
  const tree = new Tree(NodeStore);
  tree.bkgd = { idGen: { newId: () => 'unused' } };
  const writes = [];
  tree.db = {
    writeNodes: async (nodes) => {
      writes.push(nodes.map((node) => ({ ...node.toDict() })));
    }
  };
  const windowNode = await addChild(tree.root, {
    id: 'matched-persisted-window',
    type: 'window',
    loaded: true
  });
  await addChild(windowNode, {
    id: 'matched-persisted-tab',
    url: 'https://example.com/matched',
    loaded: true
  });
  writes.length = 0;

  await tree.findMatchingWindow({
    id: 88,
    tabs: [{
      id: 10,
      url: 'https://example.com/matched',
      pinned: false
    }]
  });

  assert(writes.flat().some((record) =>
    (record.id === windowNode.id) && (record.windowId === 88)
  ), 'Matching a loaded window should persist its new browser ID');
});

test('Bkgd serializes structural browser events in memory', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();

  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => {
    firstStarted = resolve;
  });
  const order = [];
  tree.onTabMoved = async (tabId) => {
    order.push(`start-${tabId}`);
    if (tabId === 1) {
      firstStarted();
      await new Promise(resolve => {
        releaseFirst = resolve;
      });
    }
    order.push(`end-${tabId}`);
  };

  const first = bkgd.onTabMoved(1, {
    windowId: 1,
    fromIndex: 0,
    toIndex: 1
  });
  await firstStartedPromise;
  const second = bkgd.onTabMoved(2, {
    windowId: 1,
    fromIndex: 1,
    toIndex: 0
  });
  await Promise.resolve();

  assertEqual(order.join(','), 'start-1',
    'Second browser mutation should wait without a durable queue');
  releaseFirst();
  await Promise.all([first, second]);
  assertEqual(order.join(','), 'start-1,end-1,start-2,end-2',
    'Browser mutations should retain event order');
});

test('Bkgd serializes active-state application with deletion',
  async () => {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    let releaseActive;
    let activeStarted;
    const activeStartedPromise = new Promise(resolve => {
      activeStarted = resolve;
    });
    const order = [];
    tree.onTabActivated = async (windowId, tabId, runMutation) => {
      return await runMutation(async () => {
        order.push('active-start');
        activeStarted();
        await new Promise(resolve => {
          releaseActive = resolve;
        });
        order.push('active-end');
      });
    };
    tree.onTabRemoved = async () => {
      order.push('removed');
    };

    const active = bkgd.onTabActivated({ windowId: 1, tabId: 10 });
    await activeStartedPromise;
    const removed = bkgd.onTabRemoved(10, {
      windowId: 1,
      isWindowClosing: false
    });
    await Promise.resolve();

    assertEqual(order.join(','), 'active-start',
      'Deletion should wait for active-state persistence');
    releaseActive();
    await Promise.all([active, removed]);
    assertEqual(order.join(','), 'active-start,active-end,removed',
      'Active state and deletion should not overlap');
  }
);

test('Bkgd rechecks reorder suppression inside the mutation boundary',
  async () => {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    let moveCalls = 0;
    tree.onTabMoved = async () => {
      moveCalls += 1;
    };

    const unlock = await bkgd.browserMutationMutex.lock();
    const pendingMove = bkgd.onTabMoved(10, {
      windowId: 1,
      fromIndex: 0,
      toIndex: 1
    });
    await Promise.resolve();
    bkgd.tabReorderInProgress = true;
    bkgd.tabReorderStalled = false;
    unlock();
    await pendingMove;

    assertEqual(moveCalls, 0,
      'Queued reorder feedback should be ignored when its turn begins');
  }
);

test('TreeStore acknowledges messages after persistence completes', async () => {
  const tree = createTree({});
  let releaseMutation;
  const mutationGate = new Promise(resolve => {
    releaseMutation = resolve;
  });
  let mutationFinished = false;
  tree.onMessage = async () => {
    await mutationGate;
    mutationFinished = true;
  };

  let response;
  const handled = tree.onRuntimeMessage(
    { msg: 'tree_nodeMoved', sourceId: 'view-test' },
    {},
    value => { response = value; }
  );

  assertEqual(handled, true, 'Background should claim tree mutation messages');
  await Promise.resolve();
  assertEqual(response, undefined,
    'Background should not acknowledge before persistence completes');

  releaseMutation();
  await new Promise(resolve => setTimeout(resolve, 0));

  assertEqual(mutationFinished, true, 'Tree mutation should finish');
  assertEqual(response.result, 'ok persisted',
    'Background should acknowledge persisted state');
});

test('TreeStore returns mutation errors instead of false success', async () => {
  const tree = createTree({});
  const originalConsoleError = console.error;
  let response;
  try {
    console.error = () => {};
    const handled = tree.onRuntimeMessage(
      { msg: 'tree_missingHandler', sourceId: 'view-test' },
      {},
      value => { response = value; }
    );

    assertEqual(handled, true, 'Background should claim the mutation');
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    console.error = originalConsoleError;
  }

  assert(response?.error?.includes('Tree fn not found'),
    'Unknown mutations should return an explicit error');
});

test('tree_nodeAdded treats a retried node ID as idempotent', async () => {
  const tree = createTree({});
  tree.resolveTreeLoaded();
  const message = {
    msg: 'tree_nodeAdded',
    parentId: 'root',
    index: 0,
    node: {
      id: 'retried-add',
      label: 'one node'
    }
  };

  const first = await tree.tree_nodeAdded({ ...message });
  const second = await tree.tree_nodeAdded({ ...message });

  assertEqual(second, first, 'Retry should return the existing node');
  assertEqual(tree.root.nodes.length, 1,
    'Retry should not insert a duplicate row');
  assertEqual(tree.nodes['retried-add'], first,
    'Node cache should retain the original object');
});

test('emit rejects acknowledged tree mutation failures', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    api.runtime.sendMessage = async () => ({
      error: 'database commit failed'
    });
    let failure;
    try {
      await emit('tree_nodeChanged', { nodeId: 'n1' });
    } catch (err) {
      failure = err;
    }
    assert(failure, 'Tree mutation response should reject the caller');
    assert(failure.message.includes('database commit failed'),
      'Tree mutation rejection should preserve the background error');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('Bkgd converts async message failures into error responses', async () => {
  const bkgd = new Bkgd();
  bkgd.bkgd_testFailure = async () => {
    throw new Error('write failed');
  };

  const response = await new Promise(resolve => {
    const handled = bkgd.onMessage(
      { msg: 'bkgd_testFailure' },
      {},
      resolve
    );
    assertEqual(handled, true, 'Background should claim its message');
  });

  assert(response && response.error, 'Failure should return an error response');
  assert(response.error.includes('write failed'),
    'Error response should preserve the failure reason');
});

test('Bkgd returns one mutation result for concurrent request retries',
async () => {
  const bkgd = new Bkgd();
  let calls = 0;
  let release;
  let started;
  const startedPromise = new Promise(resolve => {
    started = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  bkgd.bkgd_nonIdempotentTest = async () => {
    calls += 1;
    started();
    await gate;
    return { result: `call-${calls}` };
  };
  const message = {
    msg: 'bkgd_nonIdempotentTest',
    sourceId: 'retry-source',
    requestId: 'retry-request'
  };
  const responses = [];

  const first = bkgd.onBkgdMessage(message, {}, (response) => {
    responses.push(response);
  });
  await startedPromise;
  const second = bkgd.onBkgdMessage(message, {}, (response) => {
    responses.push(response);
  });
  release();
  await Promise.all([first, second]);
  await bkgd.onBkgdMessage(message, {}, (response) => {
    responses.push(response);
  });

  assertEqual(calls, 1,
    'Concurrent and later retries must not replay the mutation handler');
  assertEqual(responses.length, 3,
    'Every delivery attempt should still receive the cached response');
  assert(responses.every((response) => response.result === 'call-1'),
    'All retries should observe the original mutation result');
});

test('Bkgd rejects malformed messages without throwing', async () => {
  const bkgd = new Bkgd();
  let response;

  const handled = bkgd.onMessage(null, {}, value => {
    response = value;
  });

  assertEqual(handled, undefined, 'Malformed message should not be claimed');
  assert(response && response.error,
    'Malformed message should receive an error response');
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
      applyTreeMutation: async (name, payload) => {
        calls.push({ name, payload });
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

    assertEqual(calls.length, 1, 'Should apply one mutation');
    assertEqual(calls[0].name, 'ensureUnloaded', 'Should finalize unload');
    assertEqual(calls[0].payload.nodeId, tab.id, 'Should target tab node');
    assertEqual(calls[0].payload.detail, 'manualUnload', 'Should tag manual unload');
    assertEqual(tab.tabClosedReason, undefined, 'Should clear tabClosedReason');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore restores Firefox tabs by session identity in reverse order', async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const originalSessions = api.sessions;
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
      nodesLoading: [],
      windowsLoading: [],
      idGen: { newId: () => 'unused' }
    };
    const tree = new TreeStore(bkgd);
    tree.db = {
      saveNode: async () => {},
      deleteNode: async () => {}
    };
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'saved-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const pinned = await addChild(win, {
      id: 'pinned-gmail',
      tabId: 10,
      windowId: 1,
      url: 'https://mail.google.com/',
      loaded: true,
      pinned: true
    });
    const first = await addChild(win, {
      id: 'first-duplicate',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/duplicate',
      loaded: true
    });
    const second = await addChild(win, {
      id: 'second-duplicate',
      tabId: 12,
      windowId: 1,
      url: 'https://example.com/duplicate',
      loaded: true
    });

    const tabValues = new Map([
      [20, pinned.id],
      [21, first.id],
      [22, second.id]
    ]);
    const windowValues = new Map([[9, win.id]]);
    api.sessions = {
      getTabValue: async (tabId) => tabValues.get(tabId),
      setTabValue: async (tabId, key, nodeId) => {
        tabValues.set(tabId, nodeId);
      },
      getWindowValue: async (windowId) => windowValues.get(windowId),
      setWindowValue: async (windowId, key, nodeId) => {
        windowValues.set(windowId, nodeId);
      }
    };

    const restoredWindow = await tree.onWindowCreated({
      id: 9,
      width: 1000,
      height: 700,
      left: 10,
      top: 20
    }, { reason: 'onWindowCreated' });
    assertEqual(restoredWindow, win,
      'Restored window should reuse its saved node');

    // Firefox can emit restored tab creation events in reverse strip order,
    // with only about:blank available at creation time.
    await tree.onTabCreated({
      id: 22,
      index: 2,
      windowId: 9,
      pinned: false,
      url: 'about:blank',
      title: 'example.com/duplicate'
    });
    await tree.onTabCreated({
      id: 21,
      index: 1,
      windowId: 9,
      pinned: false,
      url: 'about:blank',
      title: 'example.com/duplicate'
    });
    await tree.onTabCreated({
      id: 20,
      index: 0,
      windowId: 9,
      pinned: true,
      url: 'about:blank',
      title: 'mail.google.com'
    });

    assertEqual(tree.root.nodes.length, 1,
      'Restore should not create a duplicate window row');
    assertEqual(win.nodes.length, 3,
      'Restore should not create duplicate tab rows');
    assertEqual(win.nodes[0], pinned,
      'Pinned first tab should keep its saved tree position');
    assertEqual(win.nodes[1], first,
      'First duplicate URL should keep its saved identity');
    assertEqual(win.nodes[2], second,
      'Second duplicate URL should keep its saved identity');
    assertEqual(pinned.tabId, 20, 'Pinned tab should receive its new tab ID');
    assertEqual(first.tabId, 21, 'First tab should receive its new tab ID');
    assertEqual(second.tabId, 22, 'Second tab should receive its new tab ID');
    assertEqual(pinned.pinned, true, 'Pinned state should survive restore');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
    if (undefined === originalSessions) delete api.sessions;
    else api.sessions = originalSessions;
  }
});

test('TreeStore applies view load directly', async () => {
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
      applyTreeMutation: async (...args) => { calls.push(args); }
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
    assertEqual(calls[0][0], 'ensureLoaded', 'Should apply load directly');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('view load delegates browser creation through one tree message',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    const messages = [];
    api.runtime.sendMessage = async (msg) => {
      messages.push({ ...msg });
      return { result: 'ok persisted' };
    };
    class LoadNode extends Node {}
    const tree = new Tree(LoadNode);
    tree.bkgd = null;
    const win = await tree.root.addChild(0, {
      id: 'w1',
      type: 'window'
    }, { reason: 'test' });
    const tab = await win.addChild(0, {
      id: 't1',
      url: 'https://example.com',
      loaded: false
    }, { reason: 'test' });

    await tab.load({ reason: 'userAction' });

    assertEqual(
      messages.filter(msg => msg.msg === 'tree_nodeChanged').length,
      1,
      'View should send one persisted load mutation'
    );
    assertEqual(
      messages.filter(msg => msg.msg === 'bkgd_loadSavedNode').length,
      0,
      'View should not request a second browser tab creation'
    );
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('TreeStore applies view unload directly', async () => {
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
      applyTreeMutation: async (...args) => { calls.push(args); }
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
    assertEqual(calls[0][0], 'ensureUnloaded', 'Should apply unload directly');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore applies view move directly', async () => {
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
      applyTreeMutation: async (...args) => { calls.push(args); }
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
      actionReason: 'userAction',
      moveNodeOnly: true,
      nodeOnlyDestAdjusted: true
    });

    assertEqual(calls.length, 1, 'Should only call ensureMoved');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply move directly');
    assertEqual(calls[0][1].moveNodeOnly, true,
      'Should preserve node-only move semantics');
    assertEqual(calls[0][1].nodeOnlyDestAdjusted, true,
      'Should preserve the adjusted-destination marker');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore applies view delete directly', async () => {
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
      applyTreeMutation: async (...args) => { calls.push(args); }
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
      actionReason: 'userAction',
      mode: 'promoteKids'
    });

    assertEqual(calls.length, 1, 'Should only call ensureDeleted');
    assertEqual(calls[0][0], 'ensureDeleted', 'Should apply delete directly');
    assertEqual(calls[0][1].mode, 'promoteKids',
      'Should preserve atomic promote-delete mode');
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore persists child promotion in one transaction', async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const writes = [];
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

    const bkgd = {};
    const tree = new TreeStore(bkgd);
    tree.db = {
      writeNodes: async (nodes, deleteIds) => {
        writes.push({
          nodeIds: nodes.map((node) => node.id),
          deleteIds: [...deleteIds]
        });
      }
    };
    bkgd.tree = tree;
    tree.resolveTreeLoaded();
    const source = await addChild(tree.root, {
      id: 'persist-promote-source'
    });
    const first = await addChild(source, {
      id: 'persist-promote-first'
    });
    const second = await addChild(source, {
      id: 'persist-promote-second'
    });
    let openerUpdates = 0;
    first.updateOpenerTabId = async () => { openerUpdates += 1; };
    second.updateOpenerTabId = async () => { openerUpdates += 1; };
    writes.length = 0;

    await tree.tree_nodeChanged({
      nodeId: source.id,
      type: 'promoteKids',
      actionReason: 'userAction'
    });

    assertEqual(writes.length, 1,
      'All promoted records should commit together');
    assertEqual(source.nodes.length, 0,
      'The persisted source should no longer own the children');
    assertEqual(first.parent, tree.root,
      'The first persisted child should be promoted');
    assertEqual(second.parent, tree.root,
      'The second persisted child should be promoted');
    assertEqual(openerUpdates, 2,
      'Promoted tabs should refresh their native opener relationships');
    const persistedIds = new Set(writes[0].nodeIds);
    for (const node of [tree.root, source, first, second]) {
      assert(persistedIds.has(node.id),
        `The promotion transaction should include "${node.id}"`);
    }
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('ensureDeleted atomically promotes children before deleting wrapper', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const messages = [];
  try {
    api.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      return {};
    };
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const before = await addChild(tree.root, { id: 'before' });
    const wrapper = await addChild(tree.root, {
      id: 'restore',
      label: 'Recovered backup'
    });
    const first = await addChild(wrapper, { id: 'first' });
    const nested = await addChild(wrapper, { id: 'nested' });
    const grandchild = await addChild(nested, { id: 'grandchild' });
    const after = await addChild(tree.root, { id: 'after' });

    await bkgd.ensureDeleted({
      nodeId: wrapper.id,
      reason: 'userAction',
      mode: 'promoteKids'
    });

    assertEqual(tree.root.nodes.length, 4,
      'Wrapper should be replaced by its two children');
    assertEqual(tree.root.nodes[0], before, 'Previous sibling should remain');
    assertEqual(tree.root.nodes[1], first, 'First child should be promoted');
    assertEqual(tree.root.nodes[2], nested, 'Second child should be promoted');
    assertEqual(tree.root.nodes[3], after, 'Following sibling should remain');
    assertEqual(nested.nodes[0], grandchild,
      'Promoted branch descendants should survive');
    assert(! tree.nodes[wrapper.id], 'Wrapper should be deleted from cache');
    assertEqual(messages.length, 0,
      'Background atomic apply should not rebroadcast partial operations');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('native tab close atomically removes a parent in every open tree',
async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const originalSendMessage = api.runtime.sendMessage;
  const originalIsBkgd = emit.isBkgd;
  const originalBkgd = emit.bkgd;
  const messages = [];
  const operations = [];
  const writes = [];
  try {
    globalThis.indexedDB = {
      open: () => ({})
    };
    api.runtime.sendMessage = async (msg) => {
      operations.push('broadcast');
      messages.push({ ...msg });
      return {};
    };

    const bkgd = new Bkgd();
    const background = new TreeStore(bkgd);
    background.db = {
      writeNodes: async (nodes, deleteNodeIds) => {
        operations.push('persist');
        writes.push({
          nodes: nodes.map((node) => node.toDict()),
          deleteNodeIds: [...deleteNodeIds]
        });
      }
    };
    bkgd.tree = background;
    bkgd.ports = [{}];
    bkgd.resolveTreeLoaded();
    background.resolveTreeLoaded();
    emit.isBkgd = true;
    emit.bkgd = bkgd;

    const buildBranch = async (tree) => {
      const win = await addChild(tree.root, {
        id: 'native-close-window',
        type: 'window',
        windowId: 1,
        loaded: true
      });
      const before = await addChild(win, {
        id: 'native-close-before',
        tabId: 9,
        windowId: 1,
        loaded: true
      });
      const parent = await addChild(win, {
        id: 'native-close-parent',
        tabId: 10,
        windowId: 1,
        loaded: true,
        active: true
      });
      const child = await addChild(parent, {
        id: 'native-close-child',
        tabId: 11,
        windowId: 1,
        loaded: true
      });
      const after = await addChild(win, {
        id: 'native-close-after',
        tabId: 12,
        windowId: 1,
        loaded: true
      });
      return { win, before, parent, child, after };
    };

    const backgroundBranch = await buildBranch(background);
    const view = createTree(null);
    view.resolveTreeLoaded();
    const viewBranch = await buildBranch(view);
    operations.length = 0;
    writes.length = 0;
    messages.length = 0;

    await bkgd.onTabRemoved(10, {
      windowId: 1,
      isWindowClosing: false
    });

    assert(! background.nodes[backgroundBranch.parent.id],
      'The persisted tree should delete the browser-closed parent');
    assertEqual(backgroundBranch.child.parent, backgroundBranch.win,
      'The persisted tree should promote the surviving child');
    assertEqual(
      backgroundBranch.win.nodes.map((node) => node.id).join(','),
      [
        backgroundBranch.before.id,
        backgroundBranch.child.id,
        backgroundBranch.after.id
      ].join(','),
      'The child should replace its closed parent in place'
    );
    assertEqual(writes.length, 1,
      'Promotion and deletion should persist in one transaction');
    assert(writes[0].deleteNodeIds.includes(backgroundBranch.parent.id),
      'The transaction should delete the closed parent record');
    const persistedChild = writes[0].nodes.find(
      (node) => node.id === backgroundBranch.child.id
    );
    assertEqual(persistedChild.parent, backgroundBranch.win.id,
      'The transaction should not leave an orphan for Lost+Found');

    const treeMessages = messages.filter(
      (msg) => msg.msg?.startsWith('tree_')
    );
    assertEqual(treeMessages.length, 1,
      'A native close should broadcast one atomic tree mutation');
    assertEqual(treeMessages[0].msg, 'tree_nodeDeleted',
      'The sidebar should receive a deletion');
    assertEqual(treeMessages[0].mode, 'promoteKids',
      'The deletion should preserve the closed parent children');
    assertEqual(operations.join(','), 'persist,broadcast',
      'The durable mutation should complete before notifying open views');

    await view.tree_nodeDeleted(treeMessages[0]);

    assert(! view.nodes[viewBranch.parent.id],
      'The open view should not retain the closed parent as a ghost');
    assertEqual(viewBranch.child.parent, viewBranch.win,
      'The open view should promote the same surviving child');
    assertEqual(
      viewBranch.win.nodes.map((node) => node.id).join(','),
      backgroundBranch.win.nodes.map((node) => node.id).join(','),
      'The open view and persisted tree should remain synchronized'
    );
    assertEqual(
      view.root.findNodes((node) => node.active).length,
      0,
      'The deleted active tab should not remain selected in the view model'
    );
  } finally {
    globalThis.indexedDB = originalIndexedDb;
    api.runtime.sendMessage = originalSendMessage;
    emit.isBkgd = originalIsBkgd;
    emit.bkgd = originalBkgd;
  }
});

test('promoteChildren keeps its node and emits one atomic mutation',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const messages = [];
  try {
    api.runtime.sendMessage = async (msg) => {
      messages.push({ ...msg });
      return { result: 'ok persisted' };
    };
    const tree = createTree(null);
    const source = await addChild(tree.root, {
      id: 'promote-source',
      label: 'Source'
    });
    const first = await addChild(source, { id: 'promote-first' });
    const second = await addChild(source, { id: 'promote-second' });
    const tail = await addChild(tree.root, { id: 'promote-tail' });

    const changed = await source.promoteChildren({
      reason: 'userAction'
    });

    assertEqual(changed, true, 'Promotion should report a change');
    assertEqual(source.nodes.length, 0,
      'The source should no longer own its former children');
    assertEqual(
      tree.root.nodes.map((node) => node.id).join(','),
      'promote-source,promote-first,promote-second,promote-tail',
      'Children should be promoted after the retained source in order'
    );
    assertEqual(first.parent, tree.root,
      'The first child should move to the source parent');
    assertEqual(second.parent, tree.root,
      'The second child should move to the source parent');
    assertEqual(tail.parent, tree.root,
      'Following siblings should remain in place');
    const treeMessages = messages.filter((msg) =>
      msg.msg?.startsWith('tree_')
    );
    assertEqual(treeMessages.length, 1,
      'Promotion should broadcast one tree mutation');
    assertEqual(treeMessages[0].msg, 'tree_nodeChanged',
      'Promotion should use the node-change protocol');
    assertEqual(treeMessages[0].type, 'promoteKids',
      'The atomic mutation should identify child promotion');
    assert(! messages.some((msg) => msg.msg === 'tree_nodeMoved'),
      'Promotion should not emit one move per child');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('promoteChildren preserves loaded window containers', async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const messages = [];
  try {
    api.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      return { result: 'ok persisted' };
    };
    const tree = createTree(null);
    const windowNode = await addChild(tree.root, {
      id: 'loaded-promote-window',
      type: 'window',
      loaded: true,
      windowId: 10
    });
    const tabNode = await addChild(windowNode, {
      id: 'loaded-promote-tab',
      loaded: true,
      tabId: 11,
      windowId: 10
    });

    const changed = await windowNode.promoteChildren({
      reason: 'userAction'
    });

    assertEqual(changed, false,
      'A loaded window should refuse to detach its children');
    assertEqual(windowNode.nodes.length, 1,
      'The loaded window should retain its tab');
    assertEqual(windowNode.nodes[0], tabNode,
      'The loaded tab should stay under its browser window');
    assertEqual(tabNode.parent, windowNode,
      'The loaded tab parent should remain unchanged');
    assertEqual(messages.length, 0,
      'A refused promotion should not broadcast a mutation');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('moveNodeOnlyTo promotes children and preserves a later drop target',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const messages = [];
  try {
    api.runtime.sendMessage = async (msg) => {
      messages.push({ ...msg });
      return { result: 'ok persisted' };
    };
    const tree = createTree(null);
    const source = await addChild(tree.root, {
      id: 'node-only-source',
      label: 'Source'
    });
    const first = await addChild(source, { id: 'node-only-first' });
    const second = await addChild(source, { id: 'node-only-second' });
    const target = await addChild(tree.root, { id: 'node-only-target' });
    const originalDestIndex = target.indexOf() + 1;

    const moved = await source.moveNodeOnlyTo(
      tree.root,
      originalDestIndex,
      { reason: 'userAction' }
    );

    assertEqual(moved, true, 'Node-only move should report success');
    assertEqual(source.nodes.length, 0,
      'Only the source node should move to the target');
    assertEqual(
      tree.root.nodes.map((node) => node.id).join(','),
      'node-only-first,node-only-second,node-only-target,node-only-source',
      'Promoted children should replace the source before its later target'
    );
    assertEqual(first.parent, tree.root,
      'First child should remain at the old tree location');
    assertEqual(second.parent, tree.root,
      'Second child should remain at the old tree location');
    const treeMessages = messages.filter((msg) =>
      msg.msg?.startsWith('tree_')
    );
    assertEqual(treeMessages.length, 1,
      'Node-only movement should broadcast one tree mutation');
    assertEqual(treeMessages[0].msg, 'tree_nodeMoved',
      'Node-only movement should use the move protocol');
    assertEqual(treeMessages[0].moveNodeOnly, true,
      'The move should tell receivers to promote their local children');
    assertEqual(treeMessages[0].destIndex, originalDestIndex + 2,
      'The protocol should carry the post-promotion destination');
    assertEqual(treeMessages[0].nodeOnlyDestAdjusted, true,
      'The protocol should identify an already-adjusted destination');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('tree_nodeMoved applies node-only movement in sibling views',
async () => {
  const tree = createTree(null);
  tree.resolveTreeLoaded();
  const source = await addChild(tree.root, {
    id: 'sibling-view-source'
  });
  const child = await addChild(source, {
    id: 'sibling-view-child'
  });
  const target = await addChild(tree.root, {
    id: 'sibling-view-target'
  });

  await tree.tree_nodeMoved({
    nodeId: source.id,
    destParentId: tree.root.id,
    destIndex: target.indexOf() + 2,
    moveNodeOnly: true,
    nodeOnlyDestAdjusted: true
  });

  assertEqual(
    tree.root.nodes.map((node) => node.id).join(','),
    'sibling-view-child,sibling-view-target,sibling-view-source',
    'Sibling views should reproduce the originating node-only move'
  );
  assertEqual(child.parent, tree.root,
    'Sibling views should promote the source child');
  assertEqual(source.nodes.length, 0,
    'Sibling views should leave the moved source empty');

  await tree.tree_nodeMoved({
    nodeId: source.id,
    destParentId: tree.root.id,
    destIndex: target.indexOf() + 2,
    moveNodeOnly: true,
    nodeOnlyDestAdjusted: true
  });
  assertEqual(
    tree.root.nodes.map((node) => node.id).join(','),
    'sibling-view-child,sibling-view-target,sibling-view-source',
    'Replaying the atomic move should not shift the source again'
  );
});

test('moveNodeOnlyTo restores children when the final move is invalid',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  const messages = [];
  try {
    api.runtime.sendMessage = async (msg) => {
      messages.push(msg);
      return { result: 'ok persisted' };
    };
    const tree = createTree(null);
    const normalWindow = await addChild(tree.root, {
      id: 'rollback-normal-window',
      type: 'window',
      windowId: 1,
      loaded: true,
      incognito: false
    });
    const source = await addChild(normalWindow, {
      id: 'rollback-source',
      tabId: 10,
      windowId: 1,
      loaded: true,
      incognito: false
    });
    const child = await addChild(source, {
      id: 'rollback-child',
      tabId: 11,
      windowId: 1,
      loaded: true,
      incognito: false
    });
    const privateWindow = await addChild(tree.root, {
      id: 'rollback-private-window',
      type: 'window',
      windowId: 2,
      loaded: true,
      incognito: true
    });

    const moved = await source.moveNodeOnlyTo(
      privateWindow,
      0,
      { reason: 'userAction' }
    );

    assertEqual(moved, false,
      'An incognito-boundary move should fail');
    assertEqual(source.parent, normalWindow,
      'The source should remain in its original window');
    assertEqual(source.nodes.length, 1,
      'A failed node-only move should restore the original subtree');
    assertEqual(source.nodes[0], child,
      'The original child order should be restored');
    assertEqual(child.parent, source,
      'The child should be reattached to the source');
    assertEqual(messages.length, 0,
      'A failed move should not broadcast a partial promotion');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('moveNodeOnlyTo restores its old position after a late move failure',
async () => {
  const originalSendMessage = api.runtime.sendMessage;
  try {
    api.runtime.sendMessage = async () => ({ result: 'ok persisted' });
    const tree = createTree(null);
    const before = await addChild(tree.root, {
      id: 'late-rollback-before'
    });
    const source = await addChild(tree.root, {
      id: 'late-rollback-source'
    });
    const child = await addChild(source, {
      id: 'late-rollback-child'
    });
    const target = await addChild(tree.root, {
      id: 'late-rollback-target'
    });
    const originalMoveTo = source.moveTo.bind(source);
    source.moveTo = async (destParent, destIndex, args) => {
      const moved = await originalMoveTo(destParent, destIndex, args);
      if ('userAction' === args.reason) return false;
      return moved;
    };

    const moved = await source.moveNodeOnlyTo(
      tree.root,
      target.indexOf() + 1,
      { reason: 'userAction' }
    );

    assertEqual(moved, false, 'The simulated late failure should propagate');
    assertEqual(
      tree.root.nodes.map((node) => node.id).join(','),
      [before.id, source.id, target.id].join(','),
      'The source should return to its exact original sibling position'
    );
    assertEqual(source.nodes.length, 1,
      'The source should regain its promoted child');
    assertEqual(source.nodes[0], child,
      'The original child order should be restored after a late failure');
    assertEqual(child.parent, source,
      'The original child should be reattached to its source');
  } finally {
    api.runtime.sendMessage = originalSendMessage;
  }
});

test('ensureMoved delegates to direct tree move application', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  tree.createRootNode();
  const parent = await addChild(tree.root, { id: 'p1' });
  const dest = await addChild(tree.root, { id: 'p2' });
  const mover = await addChild(parent, { id: 'c1' });
  bkgd.tree = tree;

  let received = null;
  tree.applyMove = async (node, destParent, destIndex, args) => {
    received = { node, destParent, destIndex, args };
    return true;
  };

  const payload = {
    nodeId: mover.id,
    destParentId: dest.id,
    destIndex: 0
  };

  await bkgd.ensureMoved(payload);
  assertEqual(received.node, mover, 'Should pass the moved node');
  assertEqual(received.destParent, dest, 'Should pass the destination parent');
  assertEqual(received.destIndex, 0, 'Should pass the destination index');
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

test('browser node-only moves replay atomically in open tree views',
async () => {
  const originalQuery = api.tabs.query;
  const originalSendMessage = api.runtime.sendMessage;
  const originalIsBkgd = emit.isBkgd;
  const originalBkgd = emit.bkgd;
  const messages = [];
  try {
    emit.isBkgd = false;
    emit.bkgd = null;
    api.runtime.sendMessage = async (msg) => {
      messages.push({ ...msg });
      return {};
    };

    const buildTree = async (bkgd = null) => {
      const tree = createTree(bkgd);
      tree.resolveTreeLoaded();
      const win = await addChild(tree.root, {
        id: 'native-move-window',
        type: 'window',
        windowId: 1,
        loaded: true
      });
      const pinned = await addChild(win, {
        id: 'native-move-pinned',
        tabId: 9,
        windowId: 1,
        loaded: true,
        pinned: true
      });
      const parent = await addChild(win, {
        id: 'native-move-parent',
        tabId: 10,
        windowId: 1,
        loaded: true
      });
      const child = await addChild(parent, {
        id: 'native-move-child',
        tabId: 11,
        windowId: 1,
        loaded: true
      });
      const sibling = await addChild(win, {
        id: 'native-move-sibling',
        tabId: 12,
        windowId: 1,
        loaded: true
      });
      return { tree, win, pinned, parent, child, sibling };
    };

    const bkgd = new Bkgd();
    const background = await buildTree(bkgd);
    const view = await buildTree();
    bkgd.tree = background.tree;

    api.tabs.query = async () => ([
      { id: 9, index: 0, windowId: 1, pinned: true },
      { id: 11, index: 1, windowId: 1, pinned: false },
      { id: 12, index: 2, windowId: 1, pinned: false },
      { id: 10, index: 3, windowId: 1, pinned: false }
    ]);

    await bkgd.ensureMoved({
      nodeId: background.parent.id,
      destParentId: background.win.id,
      destIndex: 3,
      reason: 'onTabMoved',
      skipTabReorder: true,
      moveNodeOnly: true,
      browserWindowId: 1,
      browserIndex: 3,
      pinned: false,
      prevParentId: background.win.id
    });

    const parentMove = messages.find((msg) =>
      ('tree_nodeMoved' === msg.msg)
      && (background.parent.id === msg.nodeId)
    );
    assert(parentMove,
      'The background should broadcast the browser-originated move');
    assertEqual(parentMove.moveNodeOnly, true,
      'The broadcast should preserve node-only move semantics');
    assertEqual(parentMove.nodeOnlyDestAdjusted, true,
      'The broadcast destination should be marked post-promotion');

    await view.tree.tree_nodeMoved(parentMove);
    assertEqual(
      view.win.nodes.map((node) => node.id).join(','),
      background.win.nodes.map((node) => node.id).join(','),
      'An open view should reproduce the persisted parent-only move'
    );
    assertEqual(view.parent.nodes.length, 0,
      'The view should promote the moved parent tab children in place');

    messages.length = 0;
    api.tabs.query = async () => ([
      { id: 9, index: 0, windowId: 1, pinned: true },
      { id: 12, index: 1, windowId: 1, pinned: false },
      { id: 11, index: 2, windowId: 1, pinned: false },
      { id: 10, index: 3, windowId: 1, pinned: false }
    ]);
    await bkgd.ensureMoved({
      nodeId: background.child.id,
      destParentId: background.win.id,
      destIndex: 3,
      reason: 'onTabMoved',
      skipTabReorder: true,
      moveNodeOnly: true,
      browserWindowId: 1,
      browserIndex: 2,
      pinned: false,
      prevParentId: background.win.id
    });

    const childMove = messages.find((msg) =>
      ('tree_nodeMoved' === msg.msg)
      && (background.child.id === msg.nodeId)
    );
    assert(childMove,
      'A subsequent browser move should retain the existing child node');
    assertEqual(childMove.moveNodeOnly, true,
      'Every native tab move should retain node-only replay semantics');
    await view.tree.tree_nodeMoved(childMove);
    assertEqual(
      view.win.nodes.map((node) => node.id).join(','),
      background.win.nodes.map((node) => node.id).join(','),
      'The view should remain synchronized after moving the former child'
    );
    assertEqual(Object.keys(view.tree.nodes).length, 6,
      'Browser moves should not create duplicate nodes in the view');
    for (const tabId of [9, 10, 11, 12]) {
      for (const tree of [background.tree, view.tree]) {
        const matches = tree.root.findNodes(
          (node) => node.tabId === tabId
        );
        assertEqual(matches.length, 1,
          `Tab ${tabId} should keep one binding after both moves`);
      }
    }
  } finally {
    api.tabs.query = originalQuery;
    api.runtime.sendMessage = originalSendMessage;
    emit.isBkgd = originalIsBkgd;
    emit.bkgd = originalBkgd;
  }
});

test('ensureMoved idempotently applies an adjusted user node-only move',
async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  const source = await addChild(tree.root, {
    id: 'user-node-only-source'
  });
  const first = await addChild(source, {
    id: 'user-node-only-first'
  });
  const second = await addChild(source, {
    id: 'user-node-only-second'
  });
  const target = await addChild(tree.root, {
    id: 'user-node-only-target'
  });
  const tail = await addChild(tree.root, {
    id: 'user-node-only-tail'
  });

  const payload = {
    nodeId: source.id,
    destParentId: tree.root.id,
    destIndex: target.indexOf() + source.nodes.length + 1,
    reason: 'userAction',
    moveNodeOnly: true,
    nodeOnlyDestAdjusted: true,
    skipTabReorder: true
  };
  await bkgd.ensureMoved(payload);

  assertEqual(source.nodes.length, 0,
    'The background source should no longer own promoted children');
  assertEqual(
    tree.root.nodes.map((node) => node.id).join(','),
    [
      first.id,
      second.id,
      target.id,
      source.id,
      tail.id
    ].join(','),
    'The pre-promotion drop index should still resolve after the target'
  );
  assertEqual(first.parent, tree.root,
    'The first child should remain in the source location');
  assertEqual(second.parent, tree.root,
    'The second child should remain in the source location');

  await bkgd.ensureMoved(payload);
  assertEqual(
    tree.root.nodes.map((node) => node.id).join(','),
    [
      first.id,
      second.id,
      target.id,
      source.id,
      tail.id
    ].join(','),
    'Replaying the persisted move should leave the source in place'
  );
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

test('applyMove keeps only-child loaded window content under window', async () => {
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

    await tree.applyMove(
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

test('applyMove wraps loaded branch into new window', async () => {
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
      idGen: { newId: () => 'test-win' }
    };
    const tree = new TreeStore(bkgd);
    const writes = [];
    tree.db = {
      writeNodes: async (nodes) => {
        writes.push([...nodes]);
      }
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
    writes.length = 0;

    await tree.applyMove(
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
    assertEqual(writes.length, 1,
      'Wrapping and moving a loaded branch should use one transaction');
    const savedIds = writes[0].map((node) => node.id).sort();
    assertEqual(
      savedIds.join(','),
      'root,t2,test-win,w1',
      'The wrap transaction should persist the wrapper, mover, and parents'
    );
  } finally {
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('applyMove wraps unloaded branch with loaded descendant', async () => {
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

    await tree.applyMove(
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

test('applyMove avoids wrapping unloaded root move without open tabs', async () => {
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

    await tree.applyMove(
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

test('bkgd_loadSavedNode deduplicates requests until tab attachment',
async () => {
  const originalTabsCreate = api.tabs.create;
  const originalWindowsUpdate = api.windows.update;
  try {
    let createCalls = 0;
    api.tabs.create = async () => {
      createCalls += 1;
      return { id: 77 };
    };
    api.windows.update = async () => ({});

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w-pending-tab',
      type: 'window',
      loaded: true,
      windowId: 1
    });
    const tab = await addChild(windowNode, {
      id: 't-pending-tab',
      url: 'https://example.com/pending',
      loaded: false
    });
    tab.reorderAllTabsInThisWindow = async () => {};

    const first = await bkgd.bkgd_loadSavedNode({
      nodeId: tab.id,
      reason: 'userAction'
    });
    const second = await bkgd.bkgd_loadSavedNode({
      nodeId: tab.id,
      reason: 'userAction'
    });

    assertEqual(first.result, 'ok', 'First request should create the tab');
    assertEqual(second.result, 'ok pending',
      'Repeated request should report the pending browser load');
    assertEqual(createCalls, 1,
      'Repeated requests before onTabCreated must create only one tab');

    await tree.onTabCreated({
      id: 77,
      index: 0,
      windowId: 1,
      pinned: false,
      url: tab.url,
      title: 'Pending tab'
    });
    assertEqual(tab.browserLoadInProgress, false,
      'Tab attachment should release the transient load guard');
  } finally {
    api.tabs.create = originalTabsCreate;
    api.windows.update = originalWindowsUpdate;
  }
});

test('tab updates cannot block pending saved-tab creation events', async () => {
  const originalTabsCreate = api.tabs.create;
  const originalWindowsUpdate = api.windows.update;
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();
  const events = [];
  let deadline;
  try {
    api.tabs.create = async () => ({ id: 77 });
    api.windows.update = async () => ({});
    const win = await addChild(tree.root, {
      id: 'restore-event-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const live = await addChild(win, {
      id: 'restore-event-live',
      url: 'https://example.com/live',
      tabId: 10,
      windowId: 1,
      loaded: true
    });
    const saved = await addChild(win, {
      id: 'restore-event-saved',
      url: 'https://example.com/saved',
      wasLoaded: true
    });
    saved.reorderAllTabsInThisWindow = async () => {};
    await bkgd.bkgd_loadSavedNode({
      nodeId: saved.id,
      reason: 'userAction'
    });
    events.push(bkgd.onTabUpdated(10, { title: 'Live title' }, {
      id: 10, windowId: 1, url: live.url
    }));
    events.push(bkgd.onTabCreated({
      id: 77, windowId: 1, index: 1, url: saved.url
    }));
    const completed = await Promise.race([
      Promise.all(events).then(() => true),
      new Promise(resolve => {
        deadline = setTimeout(() => resolve(false), 200);
      })
    ]);
    assert(completed,
      'Updates must not hold the browser-event lock waiting for queued creations');
    assertEqual(saved.tabId, 77,
      'The created tab must bind to its saved node before the load timeout');
    assertEqual(live.title, 'Live title',
      'Unrelated live tab updates should still be applied');
    assertEqual(win.nodes.length, 2, 'Restore must not add a duplicate row');
    assertEqual(bkgd.nodesLoading.length, 0,
      'Creation should consume the pending match without a failsafe timeout');
  } finally {
    clearTimeout(deadline);
    // Release the old implementation's deadlock as well, so a failing
    // regression does not leave work or timers running into subsequent tests.
    bkgd.nodesLoadingMutexUnlock?.();
    bkgd.nodesLoadingMutexUnlock = null;
    await Promise.allSettled(events);
    for (const node of bkgd.nodesLoading) clearTimeout(node.pendingLoadTimer);
    api.tabs.create = originalTabsCreate;
    api.windows.update = originalWindowsUpdate;
  }
});

test('saved window restore retains node identity and pinned tree order',
async () => {
  const originalIndexedDb = globalThis.indexedDB;
  const originalTabs = { ...api.tabs };
  const originalWindows = { ...api.windows };
  const events = [];
  const bkgd = new Bkgd();
  let tree;
  let nextTabId = 100;
  try {
    globalThis.indexedDB = { open: () => ({}) };
    tree = new TreeStore(bkgd);
    tree.db = { writeNodes: async () => {} };
    bkgd.tree = tree;
    bkgd.idGen = { newId: () => `unexpected-${++nextTabId}` };
    bkgd.resolveTreeLoaded();
    tree.resolveTreeLoaded();
    const win = await addChild(tree.root, {
      id: 'restore-whole-window',
      type: 'window',
      wasLoaded: true
    });
    const pinned = await addChild(win, {
      id: 'restore-pinned',
      url: 'https://example.com/mail',
      pinned: true,
      wasLoaded: true
    });
    const parent = await addChild(win, {
      id: 'restore-parent',
      url: 'https://example.com/repeated',
      wasLoaded: true
    });
    const child = await addChild(parent, {
      id: 'restore-child',
      url: 'https://example.com/child',
      wasLoaded: true
    });
    const repeated = await addChild(win, {
      id: 'restore-repeated',
      url: parent.url,
      wasLoaded: true
    });
    const savedOnly = await addChild(win, {
      id: 'restore-not-previously-loaded',
      url: 'https://example.com/saved-only'
    });
    const expected = [pinned, parent, child, repeated];
    const browserTabs = [];
    let windowCreates = 0;
    const reindex = () => browserTabs.forEach((tab, index) => {
      tab.index = index;
    });
    const makeTab = (properties) => {
      const tab = {
        id: nextTabId++,
        windowId: 82,
        index: browserTabs.length,
        url: properties.url,
        title: properties.url,
        pinned: Boolean(properties.pinned),
        discarded: Boolean(properties.discarded)
      };
      browserTabs.push(tab);
      return tab;
    };
    api.tabs.query = async () => browserTabs.map((tab) => ({ ...tab }));
    api.tabs.get = async (id) => ({ ...browserTabs.find((tab) => tab.id === id) });
    api.tabs.update = async (id, changes) => {
      const tab = browserTabs.find((item) => item.id === id);
      Object.assign(tab, changes);
      events.push(bkgd.onTabUpdated(id, changes, { ...tab }));
      return { ...tab };
    };
    api.tabs.move = async (ids, details) => {
      const moving = (Array.isArray(ids) ? ids : [ids])
        .map((id) => browserTabs.find((tab) => tab.id === id));
      for (const tab of moving) browserTabs.splice(browserTabs.indexOf(tab), 1);
      browserTabs.splice(details.index, 0, ...moving);
      reindex();
      return moving;
    };
    api.windows.get = async () => ({ id: 82 });
    api.windows.update = async () => ({ id: 82 });
    api.windows.create = async (properties) => {
      windowCreates += 1;
      const tab = makeTab(properties);
      const window = { id: 82, tabs: [{ ...tab }] };
      events.push(bkgd.onWindowCreated(window));
      events.push(bkgd.onTabCreated({ ...tab }));
      return window;
    };
    api.tabs.create = async (properties) => {
      const tab = makeTab(properties);
      // Existing tabs keep emitting updates while a window is restored.
      // Some restored tabs also report an update before their create event.
      events.push(bkgd.onTabUpdated(browserTabs[0].id,
        { title: browserTabs[0].title }, { ...browserTabs[0] }));
      events.push(bkgd.onTabUpdated(tab.id,
        { title: tab.title }, { ...tab }));
      events.push(bkgd.onTabCreated({ ...tab }));
      return { ...tab };
    };

    await win.load({ reason: 'userAction' });
    // Handlers can cause pin updates and therefore append further events.
    for (let index = 0; index < events.length; index += 1) await events[index];
    await win.reorderAllTabsInThisWindow();
    for (let index = 0; index < events.length; index += 1) await events[index];

    assertEqual(windowCreates, 1, 'Restore should create exactly one window');
    assertEqual(Object.keys(tree.nodes).length, 7,
      'Restore should reattach saved nodes, not create duplicate rows');
    assertEqual(win.nodes.map((node) => node.id).join(','),
      [pinned, parent, repeated, savedOnly].map((node) => node.id).join(','),
      'The original sibling order should remain unchanged');
    assertEqual(child.parent, parent, 'Restore should preserve nested branches');
    assertEqual(savedOnly.loaded, false,
      'Saved tabs without wasLoaded should remain unloaded');
    assert(expected.every((node) => node.loaded && node.tabId),
      'Every previously loaded tab should reuse its saved node');
    assertEqual(browserTabs.map((tab) => tab.id).join(','),
      expected.map((node) => node.tabId).join(','),
      'Native tab order should match the saved tree, not reverse it');
    assert(browserTabs[0].pinned, 'The first restored tab should remain pinned');
    assertEqual(bkgd.nodesLoading.length, 0, 'No pending matches should remain');
  } finally {
    await Promise.allSettled(events);
    for (const node of Object.values(tree?.nodes || {})) {
      clearTimeout(node.pendingLoadTimer);
      clearTimeout(node.pendingWindowLoadTimer);
    }
    Object.assign(api.tabs, originalTabs);
    Object.assign(api.windows, originalWindows);
    // Restore optional API methods which were absent from the original stub.
    if (! originalTabs.create) delete api.tabs.create;
    if (! originalWindows.create) delete api.windows.create;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('bkgd_loadSavedNode reattaches Firefox extension pages by resolved URL',
async () => {
  const originalGetUrl = api.runtime.getURL;
  const originalTabsCreate = api.tabs.create;
  const originalWindowsUpdate = api.windows.update;
  try {
    let createProperties;
    api.runtime.getURL = (path) =>
      `moz-extension://test-extension${path}`;
    api.tabs.create = async (properties) => {
      createProperties = properties;
      return { id: 78 };
    };
    api.windows.update = async () => ({});

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();

    const windowNode = await addChild(tree.root, {
      id: 'w-extension-page',
      type: 'window',
      loaded: true,
      windowId: 1
    });
    const tab = await addChild(windowNode, {
      id: 't-extension-page',
      label: 'Checkboxes',
      title: 'Double click me',
      url: '/docs/checkboxes.html',
      loaded: false
    });
    tab.reorderAllTabsInThisWindow = async () => {};

    await bkgd.bkgd_loadSavedNode({
      nodeId: tab.id,
      reason: 'userAction'
    });

    assertEqual(
      createProperties.url,
      'moz-extension://test-extension/docs/checkboxes.html',
      'Relative extension pages should open with the current extension origin'
    );
    assertEqual(tab.pendingUrl, createProperties.url,
      'Pending matching should use the same resolved URL sent to Firefox');

    await tree.onTabCreated({
      id: 78,
      index: 0,
      windowId: 1,
      pinned: false,
      active: true,
      url: 'about:blank',
      title: 'test-extension/docs/checkboxes.html'
    });

    assertEqual(windowNode.nodes.length, 1,
      'Firefox pending-title form should not create a duplicate tree node');
    assertEqual(windowNode.nodes[0], tab,
      'The browser tab should remain attached to the original saved node');
    assertEqual(tab.tabId, 78,
      'The original saved node should receive the browser tab ID');
    assertEqual(tab.url, '/docs/checkboxes.html',
      'The stable relative URL should remain stored without Firefox UUID');
  } finally {
    if (undefined === originalGetUrl) delete api.runtime.getURL;
    else api.runtime.getURL = originalGetUrl;
    api.tabs.create = originalTabsCreate;
    api.windows.update = originalWindowsUpdate;
  }
});

test('bkgd_loadSavedNode keeps its pending match when focusing fails',
async () => {
  const originalTabsCreate = api.tabs.create;
  const originalWindowsUpdate = api.windows.update;
  try {
    api.tabs.create = async () => ({ id: 88 });
    api.windows.update = async () => {
      throw new Error('window closed while focusing');
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const windowNode = await addChild(tree.root, {
      id: 'w-focus-failure',
      type: 'window',
      loaded: true,
      windowId: 1
    });
    const tab = await addChild(windowNode, {
      id: 't-focus-failure',
      url: 'https://example.com/focus-failure',
      loaded: false
    });

    const result = await bkgd.bkgd_loadSavedNode({
      nodeId: tab.id,
      reason: 'userAction'
    });

    assertEqual(result.result, 'ok',
      'A focus-only failure should not mark tab creation as failed');
    assert(bkgd.nodesLoading.includes(tab),
      'The creation event should still be able to match the saved node');
    assertEqual(tab.browserLoadInProgress, true,
      'The pending guard should remain until attachment');

    if (tab.pendingLoadTimer) clearTimeout(tab.pendingLoadTimer);
    bkgd.nodesLoading.splice(bkgd.nodesLoading.indexOf(tab), 1);
    tab.browserLoadInProgress = false;
  } finally {
    api.tabs.create = originalTabsCreate;
    api.windows.update = originalWindowsUpdate;
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
    assertEqual(tab.pendingLoadTimer, undefined,
      'Matching browser event should clear the pending-load failsafe');

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

test('bkgd_loadSavedNode honors an imported Pinned branch', async () => {
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
    const pinnedBranch = await addChild(windowNode, {
      id: 'pinned-branch',
      label: 'Pinned'
    });
    const tab = await addChild(pinnedBranch, {
      id: 't1',
      url: 'https://example.com/pinned-branch',
      loaded: false,
      pinned: false
    });

    const pinnedDest = tree.getPinnedInsertDestination(windowNode, 0);
    assertEqual(pinnedDest.destParent, pinnedBranch,
      'First pinned tab should be inserted inside the Pinned branch');
    const movableDest = tree.getFirstMovableInsertDestination(windowNode);
    assertEqual(movableDest.destParent, windowNode,
      'Unpinned tabs should remain outside the Pinned branch');
    assertEqual(movableDest.destIndex, 1,
      'Unpinned tabs should be inserted after the Pinned branch');

    await bkgd.bkgd_loadSavedNode({ nodeId: tab.id, reason: 'userAction' });

    assertEqual(created.length, 1, 'Should create one browser tab');
    assertEqual(created[0].pinned, true,
      'A saved tab in the Pinned branch should open pinned');
    assertEqual(created[0].index, 0,
      'The first Pinned-branch tab should use pinned index zero');

    await tree.onTabCreated({
      id: 77,
      index: 0,
      windowId: 1,
      pinned: false,
      url: 'https://example.com/pinned-branch',
      title: 'Pinned branch tab'
    });
    assertEqual(tab.pinned, true,
      'An early unpinned creation event should preserve branch pin state');
  } finally {
    api.tabs.create = originalTabsCreate;
  }
});

test('moveTo synchronizes unloaded tabs with a Pinned branch', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window'
  });
  const pinnedBranch = await addChild(win, {
    id: 'pinned-branch',
    label: 'Pinned'
  });
  const pinnedTab = await addChild(pinnedBranch, {
    id: 'pinned-tab',
    url: 'https://example.com/pinned',
    pinned: true
  });
  const regularTab = await addChild(win, {
    id: 'regular-tab',
    url: 'https://example.com/regular',
    pinned: false
  });
  const moveArgs = {
    reason: 'test',
    emit: false,
    skipTabReorder: true
  };

  await regularTab.moveTo(
    pinnedBranch,
    pinnedBranch.nodes.length,
    moveArgs
  );
  assertEqual(regularTab.pinned, true,
    'Moving an unloaded tab into Pinned should persist pinned state');

  await pinnedTab.moveTo(win, 1, moveArgs);
  assertEqual(pinnedTab.pinned, false,
    'Moving an unloaded tab out of Pinned should clear pinned state');
});

test('moveTo synchronizes pins when another node reveals a Pinned branch',
async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window'
  });
  const blocker = await addChild(win, {
    id: 'blocker',
    label: 'Before pinned'
  });
  const pinnedBranch = await addChild(win, {
    id: 'pinned-branch',
    label: 'Pinned'
  });
  const tab = await addChild(pinnedBranch, {
    id: 'pinned-tab',
    url: 'https://example.com/pinned',
    pinned: false
  });
  const moveArgs = {
    reason: 'test',
    emit: false,
    skipTabReorder: true
  };

  await blocker.moveTo(win, win.nodes.length, moveArgs);
  assertEqual(tab.pinned, true,
    'Revealing Pinned as the first child should pin its tabs');

  await blocker.moveTo(win, 0, moveArgs);
  assertEqual(tab.pinned, false,
    'Hiding Pinned behind another node should clear its tabs');
});

test('moveTo synchronizes native pins when a heading reveals Pinned',
async () => {
  const tree = createTree({});
  const win = await addChild(tree.root, {
    id: 'w-native-pins',
    type: 'window',
    windowId: 1,
    loaded: true
  });
  const blocker = await addChild(win, {
    id: 'native-pin-blocker',
    label: 'Before pinned'
  });
  const pinnedBranch = await addChild(win, {
    id: 'native-pinned-branch',
    label: 'Pinned'
  });
  const tab = await addChild(pinnedBranch, {
    id: 'native-pinned-tab',
    tabId: 10,
    windowId: 1,
    url: 'https://example.com/native-pinned',
    loaded: true,
    pinned: false
  });
  let reorderCalls = 0;
  win.reorderAllTabsInThisWindow = async () => {
    reorderCalls += 1;
  };

  await blocker.moveTo(win, win.nodes.length, {
    reason: 'userAction',
    emit: false
  });

  assertEqual(tab.pinned, true,
    'Revealed Pinned branch should update persisted pin state');
  assertEqual(reorderCalls, 1,
    'A non-tab move should still synchronize the native browser strip');
});

test('renaming a Pinned branch clears persisted child pin state', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, {
    id: 'w1',
    type: 'window',
    windowId: 1,
    loaded: false
  });
  const pinnedBranch = await addChild(win, {
    id: 'pinned-branch',
    label: 'Pinned'
  });
  const tab = await addChild(pinnedBranch, {
    id: 't1',
    url: 'https://example.com/pinned-branch',
    loaded: false,
    pinned: true
  });

  await pinnedBranch.setNotes('Not pinned', '', { reason: 'userAction' });

  assertEqual(tab.pinned, false,
    'Children should no longer persist as pinned after branch rename');
});

test('tab reorder enforces Pinned branch state and strip order', async () => {
  const originalWindowsGet = api.windows.get;
  const originalTabsQuery = api.tabs.query;
  const originalTabsUpdate = api.tabs.update;
  const originalTabsMove = api.tabs.move;
  try {
    const tree = createTree({});
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const pinnedBranch = await addChild(win, {
      id: 'pinned-branch',
      label: 'Pinned'
    });
    const pinnedTab = await addChild(pinnedBranch, {
      id: 'pinned-tab',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/pinned',
      loaded: true,
      pinned: false
    });
    await addChild(win, {
      id: 'regular-tab',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/regular',
      loaded: true,
      pinned: false
    });

    const browserTabs = [
      { id: 10, index: 0, windowId: 1, pinned: false },
      { id: 11, index: 1, windowId: 1, pinned: false }
    ];
    const updates = [];
    const moves = [];
    api.windows.get = async () => ({ id: 1 });
    api.tabs.query = async () => browserTabs.map((tab) => ({ ...tab }));
    api.tabs.update = async (tabId, changes) => {
      updates.push({ tabId, changes: { ...changes } });
      const tab = browserTabs.find((item) => item.id === tabId);
      if (tab && undefined !== changes.pinned) tab.pinned = changes.pinned;
      return tab ? { ...tab } : {};
    };
    api.tabs.move = async (tabIds, moveInfo) => {
      moves.push({
        tabIds: Array.isArray(tabIds) ? [...tabIds] : [tabIds],
        moveInfo: { ...moveInfo }
      });
      return {};
    };

    await win.reorderAllTabsInThisWindow();

    assertEqual(pinnedTab.pinned, true,
      'Pinned branch child should persist its browser pin state');
    assertEqual(updates.length, 1,
      'Should update only the browser tab whose pin state differs');
    assertEqual(updates[0].tabId, 10,
      'Should pin the Pinned branch child');
    assertEqual(updates[0].changes.pinned, true,
      'Should request native browser pinning');
    assertEqual(moves.length, 2,
      'Should order pinned and movable strips separately');
    assertEqual(moves[0].tabIds.join(','), '10',
      'Should place pinned tabs at the start of the browser strip');
    assertEqual(moves[0].moveInfo.index, 0,
      'Pinned strip should start at browser index zero');
    assertEqual(moves[1].tabIds.join(','), '11',
      'Should order unpinned tabs independently');
    assertEqual(moves[1].moveInfo.index, 1,
      'Movable strip should start after the pinned prefix');
  } finally {
    api.windows.get = originalWindowsGet;
    api.tabs.query = originalTabsQuery;
    api.tabs.update = originalTabsUpdate;
    api.tabs.move = originalTabsMove;
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

test('bkgd_loadSavedWindow deduplicates requests until window attachment',
async () => {
  const originalWindowsCreate = api.windows.create;
  const originalTabsGet = api.tabs.get;
  try {
    let createCalls = 0;
    api.windows.create = async () => {
      createCalls += 1;
      return { id: 101 };
    };
    api.tabs.get = async (tabId) => ({
      id: tabId,
      windowId: 101
    });

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    tree.createRootNode();
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const windowNode = await addChild(tree.root, {
      id: 'w-pending-window',
      type: 'window',
      loaded: false
    });
    await addChild(windowNode, {
      id: 't-pending-window',
      tabId: 42,
      windowId: 2,
      loaded: true,
      url: 'https://example.com/window'
    });
    windowNode.reorderAllTabsInThisWindow = async () => {};

    const message = {
      windowNodeId: windowNode.id,
      nodeId: windowNode.id
    };
    const first = await bkgd.bkgd_loadSavedWindow(message);
    const second = await bkgd.bkgd_loadSavedWindow(message);

    assertEqual(first.result, 'ok', 'First request should create the window');
    assertEqual(second.result, 'ok pending',
      'Repeated request should report the pending browser load');
    assertEqual(createCalls, 1,
      'Repeated requests before onWindowCreated must create one window');

    await tree.onWindowCreated({
      id: 101,
      state: 'normal',
      incognito: false,
      width: 800,
      height: 600,
      left: 0,
      top: 0
    }, { reason: 'onWindowCreated' });
    assertEqual(windowNode.browserLoadInProgress, false,
      'Window attachment should release the transient load guard');
  } finally {
    api.windows.create = originalWindowsCreate;
    api.tabs.get = originalTabsGet;
  }
});

test('onWindowCreated matches concurrent pending windows by their tabs',
async () => {
  const bkgd = { windowsLoading: [] };
  const tree = createTree(bkgd);
  const firstPending = await addChild(tree.root, {
    id: 'pending-first',
    type: 'window',
    loaded: false
  });
  const secondPending = await addChild(tree.root, {
    id: 'pending-second',
    type: 'window',
    loaded: false
  });
  await addChild(secondPending, {
    id: 'pending-second-tab',
    tabId: 42,
    windowId: 202,
    loaded: true,
    url: 'https://example.com/second'
  });
  firstPending.reorderAllTabsInThisWindow = async () => {};
  secondPending.reorderAllTabsInThisWindow = async () => {};
  bkgd.windowsLoading.push(firstPending, secondPending);

  const attached = await tree.onWindowCreated({
    id: 202,
    state: 'normal',
    incognito: false,
    width: 800,
    height: 600,
    left: 0,
    top: 0
  }, { reason: 'onWindowCreated' });

  assertEqual(attached, secondPending,
    'A reverse-order event should attach the window containing its live tab');
  assertEqual(firstPending.windowId, undefined,
    'An unrelated pending window must remain unbound');
  assertEqual(secondPending.windowId, 202,
    'The matching pending window should adopt the browser ID');
  assertEqual(bkgd.windowsLoading.length, 1,
    'Only the matched pending window should leave the queue');
  assertEqual(bkgd.windowsLoading[0], firstPending,
    'The unmatched pending window should retain its queue position');
});

test('onWindowCreated queries tab IDs to match reverse pending events',
async () => {
  const originalQuery = api.tabs.query;
  try {
    const bkgd = { windowsLoading: [] };
    const tree = createTree(bkgd);
    const firstPending = await addChild(tree.root, {
      id: 'query-pending-first',
      type: 'window',
      loaded: false
    });
    const secondPending = await addChild(tree.root, {
      id: 'query-pending-second',
      type: 'window',
      loaded: false
    });
    await addChild(secondPending, {
      id: 'query-pending-tab',
      tabId: 62,
      windowId: 1,
      loaded: true,
      url: 'https://example.com/query-match'
    });
    firstPending.reorderAllTabsInThisWindow = async () => {};
    secondPending.reorderAllTabsInThisWindow = async () => {};
    bkgd.windowsLoading.push(firstPending, secondPending);
    api.tabs.query = async ({ windowId }) => (
      windowId === 404 ? [{ id: 62, windowId }] : []
    );

    const attached = await tree.onWindowCreated({
      id: 404,
      state: 'normal',
      incognito: false,
      width: 800,
      height: 600,
      left: 0,
      top: 0
    }, { reason: 'onWindowCreated' });

    assertEqual(attached, secondPending,
      'Browser tab identity should resolve reverse onWindowCreated order');
    assertEqual(firstPending.windowId, undefined,
      'Query matching must not consume the unrelated first pending window');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('onTabAttached matches concurrent pending windows by tab ancestry',
async () => {
  const originalGet = api.tabs.get;
  const originalQuery = api.tabs.query;
  try {
    const bkgd = { windowsLoading: [] };
    const tree = createTree(bkgd);
    const firstPending = await addChild(tree.root, {
      id: 'attach-pending-first',
      type: 'window',
      loaded: false
    });
    const secondPending = await addChild(tree.root, {
      id: 'attach-pending-second',
      type: 'window',
      loaded: false
    });
    const tab = await addChild(secondPending, {
      id: 'attach-pending-tab',
      tabId: 52,
      windowId: 1,
      loaded: true,
      url: 'https://example.com/attached'
    });
    const provisionalWindow = await addChild(tree.root, {
      id: 'attach-provisional-window',
      type: 'window',
      windowId: 303,
      loaded: true
    });
    secondPending.setActiveTab = async () => {};
    bkgd.windowsLoading.push(firstPending, secondPending);
    api.tabs.get = async () => ({
      id: tab.tabId,
      windowId: 303,
      pinned: false
    });
    api.tabs.query = async () => ([]);

    await tree.onTabAttached(tab.tabId, {
      newWindowId: 303,
      newPosition: 0
    });

    assertEqual(firstPending.windowId, undefined,
      'The first queued window must not be selected merely by position');
    assertEqual(secondPending.windowId, 303,
      'The tab ancestor should identify the destination pending window');
    assertEqual(tab.parent, secondPending,
      'An already-positioned tab should stay under its saved window');
    assertEqual(tree.nodes[provisionalWindow.id], undefined,
      'The superseded empty provisional window should be removed');
  } finally {
    api.tabs.get = originalGet;
    api.tabs.query = originalQuery;
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

  const result1 = await tree.findMatchingWindow(realWindow);
  const match1 = result1.winNode;
  assert(match1, 'Should match a window node');

  const exclude = new Set([match1.id]);
  const result2 = await tree.findMatchingWindow(realWindow, exclude);
  const match2 = result2.winNode;
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

  const result = await tree.findMatchingWindow(realWindow);
  const match = result.winNode;

  assert(match, 'Should match saved window');
  assertEqual(pinned.tabId, 1,
    'Pinned browser tab should pre-attach to pinned saved duplicate');
  assertEqual(regular.tabId, 2,
    'Unpinned browser tab should pre-attach to unpinned saved duplicate');
});

test('findMatchingWindow matches Firefox pending titles without schemes',
async () => {
  const tree = createTree(null);
  const windowNode = await addChild(tree.root, {
    id: 'pending-title-window',
    type: 'window'
  });
  const savedTab = await addChild(windowNode, {
    id: 'pending-title-tab',
    url: 'https://mail.google.com',
    loaded: true
  });

  const result = await tree.findMatchingWindow({
    id: 105,
    tabs: [{
      id: 15,
      url: 'about:blank',
      title: 'mail.google.com',
      pinned: false
    }]
  });

  assertEqual(result.winNode, windowNode,
    'A pending Firefox title should match its saved URL');
  assertEqual(savedTab.tabId, 15,
    'The pending browser tab should attach to the saved node');
});

test('findMatchingWindow recognizes structural Pinned branch state', async () => {
  const tree = createTree(null);
  const win = await addChild(tree.root, { id: 'w1', type: 'window' });
  const pinnedBranch = await addChild(win, {
    id: 'pinned-branch',
    label: 'Pinned'
  });
  const pinned = await addChild(pinnedBranch, {
    id: 'pinned-tab',
    url: 'https://example.com/pinned',
    loaded: true,
    pinned: false
  });
  const regular = await addChild(win, {
    id: 'regular-tab',
    url: 'https://example.com/regular',
    loaded: true,
    pinned: false
  });

  const result = await tree.findMatchingWindow({
    id: 102,
    tabs: [
      {
        id: 1,
        url: 'https://example.com/pinned',
        pinned: true
      },
      {
        id: 2,
        url: 'https://example.com/regular',
        pinned: false
      }
    ]
  });

  assertEqual(result.winNode, win,
    'Structural pin state should participate in window matching');
  assertEqual(pinned.tabId, 1,
    'Pinned browser tab should attach inside the Pinned branch');
  assertEqual(regular.tabId, 2,
    'Regular browser tab should attach outside the Pinned branch');
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

  const result = await tree.findMatchingWindow(realWindow);
  const match = result.winNode;

  assertEqual(match.id, rightWin.id,
    'Window match should prefer pinned order when URLs tie');
  assertEqual(rightPinned.tabId, 1,
    'Pinned browser tab should attach to pinned node in selected window');
  assertEqual(rightRegular.tabId, 2,
    'Unpinned browser tab should attach to unpinned node in selected window');
});

test('findMatchingWindow respects duplicate URL multiplicity', async () => {
  const tree = createTree(null);
  const shortWindow = await addChild(tree.root, {
    id: 'short-duplicate-window',
    type: 'window',
    label: 'metadata-heavy candidate'
  });
  await addChild(shortWindow, {
    id: 'short-duplicate-tab',
    url: 'https://mail.example.com',
    loaded: true,
    pinned: false
  });

  const fullWindow = await addChild(tree.root, {
    id: 'full-duplicate-window',
    type: 'window'
  });
  for (let index = 0; index < 3; index += 1) {
    await addChild(fullWindow, {
      id: `full-duplicate-tab-${index}`,
      url: 'https://mail.example.com',
      loaded: true,
      pinned: true
    });
  }

  const result = await tree.findMatchingWindow({
    id: 104,
    tabs: [
      { id: 1, url: 'https://mail.example.com', pinned: false },
      { id: 2, url: 'https://mail.example.com', pinned: false }
    ]
  });

  assertEqual(result.winNode, fullWindow,
    'Two restored duplicates should not fully match one saved occurrence');
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

test('mergeOpenWindowsIntoTree uses the primary duplicate as opener',
async () => {
  const originalGetAll = api.windows.getAll;
  const originalConsoleWarn = console.warn;
  try {
    console.warn = () => {};
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    const win = await addChild(tree.root, {
      id: 'merge-opener-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const staleOpener = await addChild(win, {
      id: 'merge-stale-opener',
      tabId: 10,
      windowId: 1,
      loaded: false,
      url: 'https://example.com/opener'
    });
    const primaryOpener = await addChild(win, {
      id: 'merge-primary-opener',
      tabId: 10,
      windowId: 1,
      loaded: true,
      active: true,
      url: 'https://example.com/opener'
    });
    api.windows.getAll = async () => [{
      id: 1,
      focused: true,
      tabs: [{
        id: 10,
        index: 0,
        windowId: 1,
        active: true,
        pinned: false,
        title: 'Primary opener',
        url: 'https://example.com/opener'
      }, {
        id: 11,
        index: 1,
        windowId: 1,
        active: false,
        pinned: false,
        openerTabId: 10,
        title: 'Opened child',
        url: 'https://example.com/new-child'
      }]
    }];

    await bkgd.mergeOpenWindowsIntoTree();

    const child = tree.getNodeByTabId(11);
    assertEqual(child.parent, primaryOpener,
      'A new tab should nest under the selected live duplicate opener');
    assertEqual(staleOpener.tabId, undefined,
      'Startup merge should clear the stale duplicate binding immediately');
  } finally {
    console.warn = originalConsoleWarn;
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

test('mergeOpenWindowsIntoTree consumes duplicate URL candidates once', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;

    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 94,
      loaded: true
    });
    const first = await addChild(win, {
      id: 'first',
      url: 'https://same.example.com',
      loaded: false
    });
    const second = await addChild(win, {
      id: 'second',
      url: 'https://same.example.com',
      loaded: false
    });
    tree.getWindowNodeFromSession = async (windowId) => {
      return windowId === 94 ? win : null;
    };
    tree.getTabNodeFromSession = async (tabId) => {
      if (tabId === 131) return second;
      if (tabId === 132) return first;
      return null;
    };

    api.windows.getAll = async () => ([
      {
        id: 94,
        focused: true,
        tabs: [
          {
            id: 130,
            index: 0,
            pinned: true,
            url: 'https://mail.google.com/',
            title: 'Pinned Gmail',
            active: false
          },
          {
            id: 131,
            index: 1,
            pinned: false,
            url: 'https://same.example.com',
            title: 'First duplicate',
            active: true
          },
          {
            id: 132,
            index: 2,
            pinned: false,
            url: 'https://same.example.com',
            title: 'Second duplicate',
            active: false
          }
        ]
      }
    ]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(first.tabId, 132,
      'First saved duplicate should follow its Firefox session identity');
    assertEqual(second.tabId, 131,
      'Second saved duplicate should follow its Firefox session identity');
    assert(first.tabId !== second.tabId,
      'Duplicate URLs should consume distinct saved candidates');
    assertEqual(win.getLoadedAndUnloadedTabs().length, 3,
      'Only the unmatched pinned Gmail tab should create a row');
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

test('mergeOpenWindowsIntoTree fallback skips an earlier URL claim', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    const win = await addChild(tree.root, {
      id: 'fallback-after-url-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const changed = await addChild(win, {
      id: 'fallback-after-url-changed',
      url: 'https://example.com/old',
      loaded: false
    });
    const exact = await addChild(win, {
      id: 'fallback-after-url-exact',
      url: 'https://example.com/exact',
      loaded: false
    });
    api.windows.getAll = async () => ([{
      id: 1,
      focused: true,
      tabs: [{
        id: 10,
        index: 0,
        windowId: 1,
        url: 'https://example.com/exact',
        title: 'Exact',
        pinned: false
      }, {
        id: 11,
        index: 1,
        windowId: 1,
        url: 'https://example.com/changed',
        title: 'Changed',
        pinned: false
      }]
    }]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(exact.tabId, 10,
      'The first browser tab should keep its exact URL match');
    assertEqual(changed.tabId, 11,
      'Fallback should consume the remaining saved candidate');
    assertEqual(win.getLoadedAndUnloadedTabs().length, 2,
      'A claimed positional slot should not create a duplicate row');
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

test('mergeOpenWindowsIntoTree indexes saved candidates once per window',
async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    const win = await addChild(tree.root, {
      id: 'indexed-merge-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const tabs = [];
    for (let index = 0; index < 4; index += 1) {
      const id = index + 10;
      const url = `https://example.com/${index}`;
      await addChild(win, {
        id: `indexed-merge-tab-${index}`,
        tabId: id,
        windowId: 1,
        url,
        loaded: true
      });
      tabs.push({
        id,
        index,
        windowId: 1,
        url,
        title: `Tab ${index}`,
        active: index === 0,
        pinned: false
      });
    }
    const getCandidates = win.getLoadedAndUnloadedTabs.bind(win);
    let candidateSnapshots = 0;
    win.getLoadedAndUnloadedTabs = () => {
      candidateSnapshots += 1;
      return getCandidates();
    };
    let sessionReadsInFlight = 0;
    let maxSessionReadsInFlight = 0;
    tree.getTabNodeFromSession = async () => {
      sessionReadsInFlight += 1;
      maxSessionReadsInFlight = Math.max(
        maxSessionReadsInFlight,
        sessionReadsInFlight
      );
      await Promise.resolve();
      sessionReadsInFlight -= 1;
      return null;
    };
    api.windows.getAll = async () => ([{
      id: 1,
      focused: true,
      tabs
    }]);

    await bkgd.mergeOpenWindowsIntoTree();

    assertEqual(candidateSnapshots, 1,
      'Startup merge should not rebuild the saved candidate list per tab');
    assert(maxSessionReadsInFlight > 1,
      'Independent Firefox session lookups should run concurrently');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('runReconcile handles a window selected by content matching', async () => {
  const originalGetAll = api.windows.getAll;
  try {
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const win = await addChild(tree.root, {
      id: 'reconcile-content-window',
      type: 'window',
      loaded: true
    });
    const tabNode = await addChild(win, {
      id: 'reconcile-content-tab',
      url: 'https://example.com/matched',
      loaded: true
    });
    api.windows.getAll = async () => ([{
      id: 71,
      focused: false,
      tabs: [{
        id: 72,
        index: 0,
        windowId: 71,
        url: 'https://example.com/matched',
        active: false,
        pinned: false
      }]
    }]);

    const result = await runReconcile.call(bkgd, { reason: 'test' });

    assertEqual(result.changed, true,
      'Attaching a content-matched window should count as reconcile work');
    assertEqual(win.windowId, 71,
      'Content matching should attach the selected saved window');
    assertEqual(tabNode.tabId, 72,
      'Reconcile should continue with the window node inside the match result');
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

test('runReconcile repairs pinned state for existing and new tabs', async () => {
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
      loaded: true,
      active: false
    });
    const pinnedBranch = await addChild(win, {
      id: 'pinned-branch',
      label: 'Pinned'
    });
    const existing = await addChild(win, {
      id: 't1',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/existing',
      loaded: true,
      pinned: false
    });

    api.windows.getAll = async () => ([{
      id: 1,
      focused: true,
      tabs: [
        {
          id: 10,
          index: 0,
          windowId: 1,
          url: 'https://example.com/existing',
          title: 'Existing',
          pinned: true
        },
        {
          id: 11,
          index: 1,
          windowId: 1,
          url: 'https://example.com/new',
          title: 'New',
          pinned: true
        }
      ]
    }]);

    await runReconcile.call(bkgd, { reason: 'test' });

    assertEqual(existing.pinned, true,
      'Should repair pinned state on an attached tab');
    assertEqual(existing.parent, pinnedBranch,
      'Should move an existing pinned tab into the Pinned branch');
    assertEqual(win.active, true,
      'Should repair focused state on an attached window');
    const discovered = tree.getNodeByTabId(11);
    assert(discovered, 'Should create a node for a newly discovered tab');
    assertEqual(discovered.pinned, true,
      'Should preserve pinned state on a newly discovered tab');
    assertEqual(discovered.parent, pinnedBranch,
      'Should create a newly discovered pinned tab in the Pinned branch');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('runReconcile repairs structural placement when pin state matches',
async () => {
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
    const pinnedBranch = await addChild(win, {
      id: 'pinned-branch',
      label: 'Pinned'
    });
    const misplaced = await addChild(win, {
      id: 't1',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/pinned',
      loaded: true,
      pinned: true
    });

    api.windows.getAll = async () => ([{
      id: 1,
      focused: true,
      tabs: [{
        id: 10,
        index: 0,
        windowId: 1,
        url: 'https://example.com/pinned',
        title: 'Pinned',
        pinned: true
      }]
    }]);

    await runReconcile.call(bkgd, { reason: 'test' });

    assertEqual(misplaced.parent, pinnedBranch,
      'Already-pinned tab should still move into the Pinned branch');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('runReconcile keeps live tabs under the selected duplicate window',
async () => {
  const originalGetAll = api.windows.getAll;
  try {
    api.windows.getAll = async () => [{
      id: 1,
      focused: true,
      state: 'normal',
      incognito: false,
      tabs: [{
        id: 10,
        index: 0,
        windowId: 1,
        active: true,
        pinned: false,
        title: 'Live tab',
        url: 'https://example.com/live'
      }]
    }];

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const primaryWindow = await addChild(tree.root, {
      id: 'primary-window',
      type: 'window',
      windowId: 1,
      loaded: true,
      active: true
    });
    const staleWindow = await addChild(tree.root, {
      id: 'stale-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const staleSavedTab = await addChild(staleWindow, {
      id: 'stale-saved-tab',
      windowId: 1,
      loaded: false,
      wasLoaded: true,
      url: 'https://example.com/saved'
    });
    const tab = await addChild(primaryWindow, {
      id: 'live-tab',
      tabId: 10,
      windowId: 1,
      loaded: true,
      active: true,
      url: 'https://example.com/live',
      title: 'Live tab'
    });

    await runReconcile.call(bkgd, { reason: 'manual' });

    assertEqual(tab.parent, primaryWindow,
      'A stale duplicate windowId must not steal the live tab');
    assertEqual(staleWindow.windowId, undefined,
      'The stale duplicate window binding should be cleared');
    assertEqual(staleWindow.loaded, false,
      'The stale duplicate should no longer claim to be open');
    assertEqual(staleWindow.wasLoaded, true,
      'Detaching a duplicate window should preserve restore intent');
    assertEqual(staleSavedTab.windowId, undefined,
      'Unloaded saved tabs should not retain stale runtime window IDs');
    assertEqual(staleSavedTab.parent, staleWindow,
      'Clearing a runtime binding must preserve saved tree data');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('runReconcile uses the primary duplicate as a new tab opener',
async () => {
  const originalGetAll = api.windows.getAll;
  try {
    api.windows.getAll = async () => [{
      id: 1,
      focused: true,
      state: 'normal',
      incognito: false,
      tabs: [{
        id: 10,
        index: 0,
        windowId: 1,
        active: true,
        pinned: false,
        title: 'Primary opener',
        url: 'https://example.com/opener'
      }, {
        id: 11,
        index: 1,
        windowId: 1,
        active: false,
        pinned: false,
        openerTabId: 10,
        title: 'Opened child',
        url: 'https://example.com/child'
      }]
    }];

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const staleWindow = await addChild(tree.root, {
      id: 'opener-stale-window',
      type: 'window',
      windowId: 2,
      loaded: true
    });
    await addChild(staleWindow, {
      id: 'opener-stale-tab',
      tabId: 10,
      windowId: 2,
      loaded: true,
      url: 'https://example.com/opener'
    });
    const primaryWindow = await addChild(tree.root, {
      id: 'opener-primary-window',
      type: 'window',
      windowId: 1,
      loaded: true,
      active: true
    });
    const primaryOpener = await addChild(primaryWindow, {
      id: 'opener-primary-tab',
      tabId: 10,
      windowId: 1,
      loaded: true,
      active: true,
      url: 'https://example.com/opener'
    });

    await runReconcile.call(bkgd, { reason: 'manual' });

    const child = tree.getNodeByTabId(11);
    assert(child, 'The newly-discovered browser tab should be added');
    assertEqual(child.parent, primaryOpener,
      'The new tab should nest under the live primary opener');
  } finally {
    api.windows.getAll = originalGetAll;
  }
});

test('runReconcile clears stale bindings from nodes with no URL',
async () => {
  const originalGetAll = api.windows.getAll;
  try {
    api.windows.getAll = async () => [];
    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const stale = await addChild(tree.root, {
      id: 'blank-url-stale-tab',
      tabId: 99,
      windowId: 1,
      loaded: false,
      active: true
    });

    await runReconcile.call(bkgd, { reason: 'manual' });

    assertEqual(stale.tabId, undefined,
      'A missing URL must not protect a stale browser tab ID');
    assertEqual(stale.windowId, undefined,
      'A missing URL must not protect a stale browser window ID');
    assertEqual(stale.active, false,
      'Detached blank-URL nodes should not remain active');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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

    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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
      'Suppressed extension move should not apply a move');
    assertEqual(win.nodes[0], first,
      'Suppressed extension move should not change tree order');
    assertEqual(win.nodes[1], moved,
      'Suppressed extension move should leave moved tab in tree position');
  } finally {
    api.tabs.get = originalGet;
    globalThis.indexedDB = originalIndexedDb;
  }
});

test('TreeStore onTabUpdated pinned fallback applies move', async () => {
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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
    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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

    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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

    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
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
    assertEqual(calls.length, 1, 'Should apply one move');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
      windowsLoading: [],
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

    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
      windowsLoading: [],
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

    assertEqual(calls.length, 1, 'Should apply one move');
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
      applyTreeMutation: async (...args) => { calls.push(args); },
      windowsLoading: [],
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

    assertEqual(calls.length, 1, 'Should apply one move');
    assertEqual(calls[0][0], 'ensureMoved', 'Should apply ensureMoved directly');
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

test('onWindowFocusChanged preserves state when Firefox loses OS focus',
async () => {
  const originalGet = api.windows.get;
  let getCalls = 0;
  try {
    api.windows.get = async () => {
      getCalls += 1;
      throw new Error('WINDOW_ID_NONE must not be queried');
    };

    const bkgd = new Bkgd();
    const tree = createTree(bkgd);
    bkgd.tree = tree;
    bkgd.resolveTreeLoaded();
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true,
      active: true
    });

    await bkgd.onWindowFocusChanged(-1);

    assertEqual(win.active, true,
      'Alt+Tab away should preserve the last active browser window');
    assertEqual(getCalls, 0,
      'WINDOW_ID_NONE should not trigger browser-window work');
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
    bkgd.cfg.localBackupInterval = 1;
    bkgd.cfg.localBackupLastTimeCompleted = 0;
    bkgd.cfg.backupOnStartup = true;
    bkgd.resolveConfigLoaded();
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
    bkgd.cfg.localBackupInterval = 1;
    bkgd.cfg.localBackupLastTimeCompleted = 0;
    bkgd.cfg.backupOnStartup = false;
    bkgd.resolveConfigLoaded();
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

test('downloadBackupNow resolves on browser download completion', async () => {
  const originalDownloads = api.downloads;
  try {
    let onChanged;
    let removedListener = null;
    api.downloads = {
      download: async () => 42,
      onChanged: {
        addListener: (listener) => { onChanged = listener; },
        removeListener: (listener) => { removedListener = listener; }
      }
    };
    const tree = createTree(null);
    tree.cfg.clientId = 'test';
    tree.cfg.humanFriendlyBackups = false;
    tree.resolveTreeLoaded();
    let resolved = false;

    const backup = tree.downloadBackupNow().then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    assertEqual(tree.localBackupInProgress, true,
      'Backup should remain in progress after download starts');
    assertEqual(resolved, false,
      'Backup promise should wait for the onChanged completion event');

    onChanged({ id: 42, state: { current: 'complete' } });
    const succeeded = await backup;

    assertEqual(succeeded, true, 'Completed download should report success');
    assertEqual(tree.localBackupInProgress, false,
      'Completion should clear the in-progress guard');
    assertEqual(removedListener, onChanged,
      'Completion should remove the download listener');
  } finally {
    if (undefined === originalDownloads) delete api.downloads;
    else api.downloads = originalDownloads;
  }
});

test('downloadBackupNow reports success when timestamp storage fails',
async () => {
  const originalDownloads = api.downloads;
  const originalStorageSet = api.storage.local.set;
  try {
    let onChanged;
    api.downloads = {
      download: async () => 43,
      onChanged: {
        addListener: (listener) => { onChanged = listener; },
        removeListener: () => {}
      }
    };
    api.storage.local.set = async () => {
      throw new Error('storage unavailable');
    };
    const tree = createTree(null);
    tree.cfg.clientId = 'test';
    tree.cfg.humanFriendlyBackups = false;
    tree.resolveTreeLoaded();
    let status = '';
    tree.setStatus = (message) => { status = message; };

    const backup = tree.downloadBackupNow();
    await Promise.resolve();
    await Promise.resolve();
    onChanged({ id: 43, state: { current: 'complete' } });
    const succeeded = await backup;

    assertEqual(succeeded, true,
      'A completed file download remains a successful backup');
    assert(status.startsWith('Saved '),
      'The user should see that the backup file was saved');
  } finally {
    api.storage.local.set = originalStorageSet;
    if (undefined === originalDownloads) delete api.downloads;
    else api.downloads = originalDownloads;
  }
});

test('backup import rejects invalid files with an explicit error', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();

  const response = await bkgd.bkgd_importBackupFile({
    data: { nodes: {} },
    filename: 'invalid.json'
  });

  assert(response.error, 'Invalid imports should return an error field');
  assert(response.status.startsWith('Import error:'),
    'Invalid imports should not be presented as successful');
  assertEqual(response.total, 0,
    'Invalid imports should not report a negative node count');
});

test('backup import skips graph cycles without mutating source data',
async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();
  const backup = {
    $schema: jsonSchema,
    metadata: {
      sessionStartDate: 1,
      exportDate: 2
    },
    nodes: {
      root: {
        id: 'root',
        label: 'Imported',
        loaded: true,
        active: true,
        nodes: ['child']
      },
      child: {
        id: 'child',
        url: 'https://example.com/imported',
        nodes: ['root']
      }
    }
  };
  const before = JSON.stringify(backup);

  const response = await bkgd.bkgd_importBackupFile({
    data: backup,
    filename: 'cycle.json'
  });

  assertEqual(response.error, undefined,
    'A recoverable cycle should not abort the whole import');
  assertEqual(tree.root.nodes.length, 1,
    'The imported root should be created exactly once');
  assertEqual(tree.root.nodes[0].nodes.length, 1,
    'The non-cyclic child should still be imported');
  assertEqual(tree.root.nodes[0].nodes[0].nodes.length, 0,
    'The cycle edge should be skipped');
  assertEqual(JSON.stringify(backup), before,
    'Import should not rewrite the caller-owned backup object');
});

test('favicon backfill commits changed nodes in one transaction', async () => {
  const bkgd = new Bkgd();
  const tree = createTree(bkgd);
  bkgd.tree = tree;
  bkgd.resolveTreeLoaded();
  await addChild(tree.root, {
    id: 'favicon-one',
    url: 'https://one.example/path'
  });
  await addChild(tree.root, {
    id: 'favicon-two',
    url: 'https://two.example/path'
  });
  let batches = [];
  tree.persistNodes = async (nodes) => {
    batches.push([...nodes]);
  };

  const response = await bkgd.bkgd_backfillFavicons({});

  assertEqual(response.updated, 2, 'Both missing favicons should be updated');
  assertEqual(batches.length, 1,
    'Backfill should use one IndexedDB transaction');
  assertEqual(batches[0].length, 2,
    'The transaction should contain every changed node');
});

test('onAlarm waits for the scheduled backup to finish', async () => {
  const bkgd = new Bkgd();
  let releaseBackup;
  const backupGate = new Promise(resolve => {
    releaseBackup = resolve;
  });
  let backupFinished = false;
  bkgd.tree = {
    downloadBackupNow: async () => {
      await backupGate;
      backupFinished = true;
    }
  };
  bkgd.resolveTreeLoaded();

  let alarmFinished = false;
  const alarmPromise = bkgd.onAlarm({
    name: bkgd.localBackupAlarmName
  }).then(() => {
    alarmFinished = true;
  });
  await Promise.resolve();

  assertEqual(alarmFinished, false,
    'Alarm handler should remain pending while backup is running');
  releaseBackup();
  await alarmPromise;
  assertEqual(backupFinished, true,
    'Alarm handler should resolve after the backup');
});

test('extension icon awaits side-panel open state', async () => {
  const originalIsOpen = api.sidePanel.isOpen;
  const originalOpen = api.sidePanel.open;
  const originalClose = api.sidePanel.close;
  try {
    let opened = 0;
    let closed = 0;
    api.sidePanel.isOpen = async () => false;
    api.sidePanel.open = async () => { opened += 1; };
    api.sidePanel.close = async () => { closed += 1; };
    const bkgd = new Bkgd();

    await bkgd.onExtensionIconClicked({ windowId: 7 });

    assertEqual(opened, 1, 'Closed side panel should be opened');
    assertEqual(closed, 0, 'Closed side panel should not be closed again');
    assertEqual(bkgd.chromeSidepanelIsOpen[7], true,
      'Fallback state should reflect the completed toggle');
  } finally {
    if (undefined === originalIsOpen) delete api.sidePanel.isOpen;
    else api.sidePanel.isOpen = originalIsOpen;
    if (undefined === originalOpen) delete api.sidePanel.open;
    else api.sidePanel.open = originalOpen;
    if (undefined === originalClose) delete api.sidePanel.close;
    else api.sidePanel.close = originalClose;
  }
});

test('global toggle-load command is forwarded to the active TreeView',
async () => {
  const originalGetLastFocused = api.windows.getLastFocused;
  const originalSendMessage = api.runtime.sendMessage;
  const originalIsBkgd = emit.isBkgd;
  const originalBkgd = emit.bkgd;
  let sent;
  try {
    api.windows.getLastFocused = async () => ({ id: 42 });
    api.runtime.sendMessage = async (message) => {
      sent = message;
      return {};
    };
    emit.isBkgd = false;
    emit.bkgd = null;
    const bkgd = new Bkgd();

    await bkgd.onCommand('toggleLoad', { id: 7 });

    assertEqual(sent.msg, 'treeview_onCommand',
      'The command should target the TreeView');
    assertEqual(sent.action, 'toggleLoad',
      'The combined command name should be preserved');
    assertEqual(sent.windowId, 42,
      'The command should target the focused browser window');
  } finally {
    if (undefined === originalGetLastFocused) {
      delete api.windows.getLastFocused;
    } else {
      api.windows.getLastFocused = originalGetLastFocused;
    }
    api.runtime.sendMessage = originalSendMessage;
    emit.isBkgd = originalIsBkgd;
    emit.bkgd = originalBkgd;
  }
});

test('onTabActivated applies the event tab ID without query debounce',
async () => {
  const originalQuery = api.tabs.query;
  try {
    let queryCalls = 0;
    api.tabs.query = async () => {
      queryCalls += 1;
      throw new Error('tabs.onActivated should not need tabs.query');
    };
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'direct-active-window',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const previous = await addChild(win, {
      id: 'direct-active-previous',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/previous',
      loaded: true,
      active: true
    });
    const next = await addChild(win, {
      id: 'direct-active-next',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/next',
      loaded: true,
      active: false
    });
    let mutationCalls = 0;
    const runMutation = async (handler) => {
      mutationCalls += 1;
      return await handler();
    };

    await tree.onTabActivated(1, 11, runMutation);
    await tree.onTabActivated(1, 10, runMutation);

    assertEqual(queryCalls, 0,
      'The activation event should not perform another browser query');
    assertEqual(mutationCalls, 2,
      'Each rapid activation should retain its mutation boundary');
    assertEqual(previous.active, true,
      'The second event should reactivate its tab immediately');
    assertEqual(next.active, false,
      'The second event should deactivate the intervening tab immediately');
    assertEqual(win.setActiveTabTimer, null,
      'Event-driven activation should not leave a debounce timer');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('setActiveTab resolves after the fallback debounced state update',
async () => {
  const originalQuery = api.tabs.query;
  try {
    const tree = createTree(null);
    const win = await addChild(tree.root, {
      id: 'w1',
      type: 'window',
      windowId: 1,
      loaded: true
    });
    const oldActive = await addChild(win, {
      id: 't1',
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/old',
      loaded: true,
      active: true
    });
    const newActive = await addChild(win, {
      id: 't2',
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/new',
      loaded: true,
      active: false
    });
    let queryFinished = false;
    api.tabs.query = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      queryFinished = true;
      return [{ id: 11 }];
    };

    const changed = await win.setActiveTab({ reason: 'test' });

    assertEqual(queryFinished, true,
      'Awaiting setActiveTab should wait for the browser query');
    assertEqual(changed, true, 'Active state should report a change');
    assertEqual(oldActive.active, false, 'Old active tab should be cleared');
    assertEqual(newActive.active, true, 'New active tab should be selected');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('setActiveTab treats a disappearing browser window as a no-op',
async () => {
  const originalQuery = api.tabs.query;
  try {
    api.tabs.query = async () => {
      throw new Error('Invalid window ID');
    };
    const tree = createTree(null);
    const windowNode = await addChild(tree.root, {
      id: 'gone-window',
      type: 'window',
      windowId: 99,
      loaded: true
    });

    const changed = await windowNode.setActiveTab({
      reason: 'onTabActivated'
    });

    assertEqual(changed, false,
      'A window teardown race should resolve without rejecting callers');
  } finally {
    api.tabs.query = originalQuery;
  }
});

test('NodeView applies onWindowRemoved active state before rendering',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  tree.cfg.cursorFollowsActiveTab = false;
  const node = await tree.root.addChild(0, {
    id: 'removed-window-node',
    type: 'window',
    active: true
  }, { reason: 'test' });

  await node.setActive(false, {
    reason: 'onWindowRemoved',
    onWindowRemoved: true
  });

  assertEqual(node.active, false,
    'The view model should not retain stale active window state');
});

test('NodeView updates active classes without rebuilding row content',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  tree.cfg.cursorFollowsActiveTab = false;
  const node = await tree.root.addChild(0, {
    id: 'active-row-node',
    tabId: 10,
    windowId: 1,
    url: 'https://example.com',
    loaded: true,
    active: false
  }, { reason: 'test' });
  const classes = new Set(['loaded']);
  const row = {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name))
    }
  };
  node.$row = row;
  let renderCalls = 0;
  node.$render = () => {
    renderCalls += 1;
  };

  await node.setActive(true, { reason: 'tree_nodeChanged' });

  assertEqual(node.$row, row,
    'An active-state update should preserve the existing row element');
  assertEqual(renderCalls, 0,
    'An active-state update should not reconstruct row content');
  assert(classes.has('active'),
    'The existing row should receive the active class');

  await node.setActive(false, { reason: 'tree_nodeChanged' });

  assertEqual(renderCalls, 0,
    'Deactivation should also preserve the rendered row content');
  assert(! classes.has('active'),
    'The existing row should drop the active class');
});

test('TreeView expansion overrides redraw only the changed subtree',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  const parent = await tree.root.addChild(0, {
    id: 'override-parent',
    label: 'Parent',
    expanded: false
  }, { reason: 'test' });
  const child = await parent.addChild(0, {
    id: 'override-child',
    label: 'Child',
    expanded: false
  }, { reason: 'test' });
  const redraws = [];
  for (const node of [parent, child]) {
    node.setExpanded = async (expanded, args) => {
      redraws.push({ node, expanded, args });
      return true;
    };
  }

  await tree.expandOverride(child, true);

  assertEqual(redraws.length, 1,
    'Expanding a collapsed path should redraw it once');
  assertEqual(redraws[0].node, parent,
    'The highest changed ancestor should render the affected subtree');
  assertEqual(redraws[0].expanded, true,
    'The override should render the subtree expanded');

  redraws.length = 0;
  await tree.expandOverride(child, true);
  assertEqual(redraws.length, 0,
    'Reapplying an existing override should not redraw unchanged rows');

  await tree.expandOverride(child, null);
  assertEqual(redraws.length, 1,
    'Removing an override should redraw the changed subtree once');
  assertEqual(redraws[0].node, parent,
    'Override removal should also redraw only the highest changed node');
  assertEqual(redraws[0].expanded, false,
    'Removing the override should restore stored collapsed state');
});

test('TreeView cursor falls back safely when its node disappeared',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  tree.updateDetailsBox = () => {};
  tree.scrollNodeIntoView = () => {};
  tree.hideDetailsBox = () => {};

  await tree.setCursor(undefined, { instant: true });

  assertEqual(tree.cursor, tree.root,
    'A missing cursor node should fall back to the current view root');
  tree.cursor = null;
  assertEqual(tree.whichCursor({ type: 'keydown' }), null,
    'Keyboard handling should tolerate an unset cursor');
});

test('TreeView sibling navigation skips subtrees and climbs to parents',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  const before = await tree.root.addChild(0, {
    id: 'cursor-before'
  }, { reason: 'test' });
  const branch = await tree.root.addChild(1, {
    id: 'cursor-branch',
    expanded: true
  }, { reason: 'test' });
  const first = await branch.addChild(0, {
    id: 'cursor-first',
    expanded: true
  }, { reason: 'test' });
  await first.addChild(0, {
    id: 'cursor-deep'
  }, { reason: 'test' });
  const second = await branch.addChild(1, {
    id: 'cursor-second'
  }, { reason: 'test' });
  const after = await tree.root.addChild(2, {
    id: 'cursor-after'
  }, { reason: 'test' });
  tree.setCursor = async (node) => {
    tree.cursor = node;
  };

  tree.cursor = second;
  await tree.action_cursorPrevSibling({ type: 'keydown' });
  assertEqual(tree.cursor, first,
    'Ctrl+Up should select the previous sibling, not its descendant');

  await tree.action_cursorPrevSibling({ type: 'keydown' });
  assertEqual(tree.cursor, branch,
    'Ctrl+Up from the first child should select its parent');

  await tree.action_cursorPrevSibling({ type: 'keydown' });
  assertEqual(tree.cursor, before,
    'Ctrl+Up should resume with the parent previous sibling');

  tree.cursor = branch;
  await tree.action_cursorNextSibling({ type: 'keydown' });
  assertEqual(tree.cursor, after,
    'Ctrl+Down should skip an expanded branch and all descendants');

  tree.cursor = first;
  await tree.action_cursorNextSibling({ type: 'keydown' });
  assertEqual(tree.cursor, second,
    'Ctrl+Down should select the immediate next sibling');

  await tree.action_cursorNextSibling({ type: 'keydown' });
  assertEqual(tree.cursor, after,
    'Ctrl+Down should climb until an ancestor has a next sibling');

  await tree.action_cursorNextSibling({ type: 'keydown' });
  assertEqual(tree.cursor, after,
    'Ctrl+Down should stop at the final node instead of wrapping');
});

test('TreeView recognizes modifier-assisted node-only drags',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  tree.nodeIdMimeType = 'application/x-tktsto-node-id';
  tree.nodeOnlyMoveMimeType = 'application/x-tktsto-move-node-only';
  const source = await tree.root.addChild(0, {
    id: 'drag-node-only-source'
  }, { reason: 'test' });
  await source.addChild(0, {
    id: 'drag-node-only-child'
  }, { reason: 'test' });
  const target = await tree.root.addChild(1, {
    id: 'drag-node-only-target'
  }, { reason: 'test' });
  tree.mouseNodeNonRoot = target;
  tree.$mouseRow = {};
  tree.$mouseRowWid = 100;
  tree.$mouseRowX = 0;

  assertEqual(
    tree.getMouseBinding('Ctrl+MousePressLeft'),
    'mousePressLeft',
    'Ctrl should modify a mouse action without disabling its handler'
  );
  assertEqual(
    tree.getMouseBinding('Ctrl+MouseDragStart'),
    'mouseDragStart',
    'Ctrl-drag should still dispatch the normal drag-start handler'
  );
  assertEqual(
    tree.getMouseBinding('Shift+MousePressLeft'),
    undefined,
    'Unrelated mouse modifiers should retain their existing behavior'
  );
  assertEqual(
    tree.getMouseBinding('Ctrl+MouseDblClickLeft'),
    undefined,
    'Ctrl fallback should be limited to the node-only drag lifecycle'
  );

  const drop = tree.getMouseDragTarget({
    ctrlKey: false,
    dataTransfer: {
      types: [tree.nodeIdMimeType, tree.nodeOnlyMoveMimeType],
      getData: (type) => (
        type === tree.nodeIdMimeType ? source.id : ''
      )
    }
  });

  assertEqual(drop.source, 'internal',
    'The custom drag payload should remain an internal move');
  assertEqual(drop.sourceNode, source,
    'The custom drag payload should identify its source node');
  assertEqual(drop.moveNodeOnly, true,
    'The custom MIME marker should preserve node-only behavior');
});

test('TreeView cancels a delayed scroll superseded by a newer cursor',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  tree.resolveTreeViewLoaded();
  tree.viewScope = 'session';
  tree.viewRoot = tree.root;
  const oldCursor = await tree.root.addChild(0, {
    id: 'old-cursor',
    label: 'Unloaded tab'
  }, { reason: 'test' });
  const newCursor = await tree.root.addChild(1, {
    id: 'new-cursor',
    label: 'Newly active tab'
  }, { reason: 'test' });
  for (const node of [oldCursor, newCursor]) {
    node.addCursor = () => {};
    node.removeCursor = () => {};
  }
  tree.updateDetailsBox = () => {};
  tree.hideDetailsBox = () => {};
  const scrolledNodes = [];
  tree.scrollNodeIntoView = (node) => {
    scrolledNodes.push(node);
  };

  const staleCursorUpdate = tree.setCursor(oldCursor, {
    scrollDelay: 5
  });
  await tree.setCursor(newCursor, { instant: true });
  await staleCursorUpdate;

  assertEqual(tree.cursor, newCursor,
    'The newer active-tab cursor should remain selected');
  assertEqual(scrolledNodes.length, 1,
    'The superseded click must not perform its delayed scroll');
  assertEqual(scrolledNodes[0], newCursor,
    'Only the newer active-tab cursor should be scrolled into view');
});

test('TreeView deletion defaults unwrap expanded and confirm collapsed branches',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  const prompts = [];
  tree.inputDialog = async (details) => {
    prompts.push(details);
    return { button: 'Cancel' };
  };

  const expandedStyle = await tree.chooseDeleteBranchStyle({
    isExpanded: () => true
  }, 3);
  const collapsedStyle = await tree.chooseDeleteBranchStyle({
    isExpanded: () => false
  }, 3);

  assertEqual(expandedStyle, 'one',
    'Expanded branches should delete only their parent by default');
  assertEqual(collapsedStyle, null,
    'Cancelling the default collapsed confirmation should abort deletion');
  assertEqual(prompts.length, 1,
    'Only collapsed deletion should prompt under the default policies');
  assertEqual(prompts[0].buttons.join(','), 'Cancel,OK',
    'Collapsed deletion should use a confirmation prompt');
});

test('TreeView deletion prompts remain available by configuration',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  const prompts = [];
  tree.cfg.deleteExpandedBranchStyle = 'ask';
  tree.cfg.deleteCollapsedBranchStyle = 'ask';
  tree.inputDialog = async (details) => {
    prompts.push(details);
    return {
      button: details.buttons.includes('One') ? 'One' : 'Cancel'
    };
  };

  const expandedStyle = await tree.chooseDeleteBranchStyle({
    isExpanded: () => true
  }, 4);
  const collapsedStyle = await tree.chooseDeleteBranchStyle({
    isExpanded: () => false
  }, 4);

  assertEqual(expandedStyle, 'one',
    'Expanded prompt should return the chosen deletion scope');
  assertEqual(collapsedStyle, null,
    'Cancelling a collapsed deletion should abort it');
  assertEqual(prompts.length, 2,
    'Each ask policy should display its corresponding prompt');
});

test('TreeView keeps input disabled until all overlapping dialogs settle',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  let resolveFirst;
  let resolveSecond;
  const first = tree.runDialog(
    () => new Promise(resolve => { resolveFirst = resolve; }),
    []
  );
  const second = tree.runDialog(
    () => new Promise(resolve => { resolveSecond = resolve; }),
    []
  );

  assertEqual(tree.dialogActive, true,
    'Starting dialogs should disable regular input');
  resolveFirst('first');
  await first;
  assertEqual(tree.dialogActive, true,
    'Finishing one dialog must not re-enable input under another dialog');
  resolveSecond('second');
  await second;
  assertEqual(tree.dialogActive, false,
    'Input should resume after the final dialog settles');
});

test('TreeView only treats zero mouse coordinates as leaving the viewport',
async () => {
  const doc = {
    activeElement: { blur: () => {} }
  };
  const tree = new TreeView({
    isInert: true,
    document: doc,
    window: null
  });
  tree.viewRoot = tree.root;
  const event = {
    type: 'mousemove',
    target: null,
    x: 0,
    y: 5,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false
  };

  tree.dragScrollSpeed = 10;
  await tree.mouseEvent('Unknown', event);
  assertEqual(tree.dragScrollSpeed, 10,
    'Touching only the left edge should not stop drag scrolling');
  assertEqual(event.processedName, '',
    'Unsupported DOM events should not become a literal undefined binding');

  event.y = 0;
  await tree.mouseEvent('Unknown', event);
  assertEqual(tree.dragScrollSpeed, 0,
    'A synthetic zero-coordinate leave event should stop drag scrolling');
});

test('TreeView opens internal links without an initialized cursor or tab',
async () => {
  const originalGetUrl = api.runtime.getURL;
  const originalGetCurrent = api.windows.getCurrent;
  const originalQuery = api.tabs.query;
  const originalCreate = api.tabs.create;
  let createProperties;
  try {
    api.runtime.getURL = (path) => `extension://test${path}`;
    api.windows.getCurrent = async () => ({ id: 7 });
    api.tabs.query = async () => ([]);
    api.tabs.create = async (details) => {
      createProperties = details;
      return { id: 70, ...details };
    };
    const tree = new TreeView({
      isInert: true,
      document: null,
      window: null
    });
    tree.viewScope = 'session';
    tree.cursor = null;

    await tree.openLinkInNewTab('/docs/index.html', true);

    assertEqual(createProperties.windowId, 7,
      'The current window should be used when no cursor window exists');
    assertEqual(createProperties.openerTabId, undefined,
      'No opener should be assigned when the browser reports no active tab');
  } finally {
    api.runtime.getURL = originalGetUrl;
    api.windows.getCurrent = originalGetCurrent;
    api.tabs.query = originalQuery;
    api.tabs.create = originalCreate;
  }
});

test('TreeView keeps task editing available for existing checkboxes', () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  const makeButton = () => ({
    style: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {}
    }
  });
  tree.cfg.treeViewZoomLevel = 1;
  tree.window = { scrollY: 0 };
  tree.$mouseRow = {
    getBoundingClientRect: () => ({ top: 0 })
  };
  tree.$hoverMenu = makeButton();
  tree.$hoverMenuToggleLoad = makeButton();
  tree.$hoverMenuTask = makeButton();
  tree.$hoverMenuMark = makeButton();
  tree.$hoverMenuWindow = makeButton();
  tree.$hoverMenuDelete = makeButton();
  tree.mouseNode = {
    hasCheckbox: () => true,
    isRoot: () => false,
    isLoaded: () => false,
    hasLoadedTabs: () => false,
    isUnloadedTab: () => false,
    isUnloadedWindow: () => false,
    isBatchLoadable: () => false,
    isMarkable: () => false,
    isDeletable: () => true
  };

  tree.showHoverMenu();

  assertEqual(tree.$hoverMenuTask.style.display, 'inline-block',
    'The T action should remain visible so an existing checkbox can be edited');
});

test('TreeView renders one state-based hover load control', () => {
  const appended = [];
  const doc = {
    createElement: () => {
      const classes = new Set();
      return {
        style: {},
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          toggle: (name, force) => {
            if (force) classes.add(name);
            else classes.delete(name);
          },
          contains: (name) => classes.has(name)
        },
        addEventListener: () => {}
      };
    }
  };
  const tree = new TreeView({
    isInert: true,
    document: doc,
    window: null
  });
  tree.$hoverMenu = {
    append: (button) => appended.push(button)
  };

  tree.$renderHoverMenu();

  assertEqual(appended.length, 6,
    'The hover menu should render one load toggle plus five other actions');
  assertEqual(tree.$hoverMenuToggleLoad, appended[0],
    'The first hover action should be the state-based load toggle');
  assertEqual(tree.$hoverMenuLoad, undefined,
    'A second directional load control should not be created');
  assertEqual(tree.$hoverMenuUnload, undefined,
    'A second directional unload control should not be created');
});

test('TreeView applies canonical and legacy toggle-load bindings', () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });

  tree.applyKeyBindings({
    loadNode: '',
    unloadNode: 'q',
    forceToggleLoad: 'Shift+Q'
  });

  assertEqual(tree.keyBindings.Q, 'toggleLoad',
    'The stored key should dispatch the combined action');
  assertEqual(tree.keyBindings.U, undefined,
    'A custom combined key should replace its default');
  assertEqual(tree.getKeyBindingForAction('toggleLoad'), 'Q',
    'Button labels should see the effective combined binding');
  assertEqual(tree.keyBindings['Shift+Q'], 'forceToggleLoad',
    'Existing smart-toggle overrides should remain assigned');

  tree.$hoverMenuToggleLoad = {};
  tree.updateHoverMenuLabels();
  assertEqual(tree.$hoverMenuToggleLoad.innerText, 'Q',
    'The single hover toggle should show the combined shortcut');
});

test('TreeView toggle-load chooses direction from loaded content',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  let action;
  tree.action_loadNode = async () => { action = 'load'; };
  tree.action_unloadNode = async () => { action = 'unload'; };

  tree.whichCursor = () => ({
    isLoaded: () => false,
    hasLoadedTabs: () => false
  });
  await tree.action_toggleLoad({ type: 'keydown' });
  assertEqual(action, 'load',
    'A closed node or branch should load');

  tree.whichCursor = () => ({
    isLoaded: () => false,
    hasLoadedTabs: () => true
  });
  await tree.action_toggleLoad({ type: 'keydown' });
  assertEqual(action, 'unload',
    'A branch containing open tabs should unload');

  tree.whichCursor = () => ({
    isLoaded: () => true,
    hasLoadedTabs: () => false
  });
  await tree.action_toggleLoad({ type: 'keydown' });
  assertEqual(action, 'unload',
    'An open leaf should unload');
});

test('TreeView unload follows expansion state without prompting', async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  const calls = [];
  let collapsed = false;
  let prompts = 0;
  const makeTab = (id) => ({
    id,
    unload: async (args) => {
      calls.push({ id, args });
      return true;
    }
  });
  const firstChild = makeTab('first-child');
  const secondChild = makeTab('second-child');
  const cursor = {
    id: 'cursor',
    isCollapsed: () => collapsed,
    hasLoadedTabs: () => true,
    isWindow: () => false,
    isLoadedTab: () => true,
    getLoadedTabs: () => [firstChild, secondChild],
    unload: async (args) => {
      calls.push({ id: 'cursor', args });
      return true;
    },
    toLine: () => 'cursor'
  };
  tree.whichCursor = () => cursor;
  tree.setStatus = () => {};
  tree.inputDialog = async () => {
    prompts += 1;
    return { button: 'All' };
  };

  await tree.action_unloadNode({ type: 'keydown' });
  assertEqual(calls.map((call) => call.id).join(','), 'cursor',
    'An expanded branch should unload only the selected node');
  assertEqual(calls[0].args.wasLoaded, undefined,
    'A single-node unload should retain ordinary unload semantics');

  calls.length = 0;
  collapsed = true;
  await tree.action_unloadNode({ type: 'keydown' });
  assertEqual(
    calls.map((call) => call.id).join(','),
    'second-child,first-child,cursor',
    'A collapsed branch should unload descendants bottom-up, then the cursor'
  );
  assert(calls.every((call) => call.args.wasLoaded === true),
    'Collapsed branch tabs should remain available for branch restore');
  assertEqual(prompts, 0,
    'Neither expanded nor collapsed unload should open a choice dialog');
});

test('TreeView smart load restores missing tabs before normal toggle',
async () => {
  const tree = new TreeView({
    isInert: true,
    document: null,
    window: null
  });
  const alreadyLoaded = {
    id: 'loaded',
    isWasLoadedTab: () => false
  };
  const firstMissing = {
    id: 'first-missing',
    isWasLoadedTab: () => true
  };
  const secondMissing = {
    id: 'second-missing',
    isWasLoadedTab: () => true
  };
  const cursor = {
    findNodes: (filter) => [
      alreadyLoaded,
      firstMissing,
      secondMissing
    ].filter(filter),
    isWasLoadedTab: () => false
  };
  let loadedQueue;
  let toggles = 0;
  tree.whichCursor = () => cursor;
  tree.loadTabQueue = async (queue) => {
    loadedQueue = queue;
  };
  tree.action_toggleLoad = async () => {
    toggles += 1;
  };

  await tree.action_forceToggleLoad({ type: 'keydown' });

  assertEqual(
    loadedQueue.map((node) => node.id).join(','),
    'second-missing,first-missing',
    'Smart load should restore only missing wasLoaded tabs in load order'
  );
  assertEqual(toggles, 0,
    'Missing restore tabs should take priority over toggling loaded content');

  cursor.findNodes = () => [];
  loadedQueue = null;
  await tree.action_forceToggleLoad({ type: 'keydown' });

  assertEqual(loadedQueue, null,
    'A complete branch should not start another restore batch');
  assertEqual(toggles, 1,
    'A complete branch should fall through to the normal toggle');
});

test('TreeView reuses loaded config and batches window settings',
async () => {
  const originalGet = api.storage.local.get;
  let getCalls = 0;
  try {
    api.storage.local.get = async (defaults) => {
      getCalls += 1;
      const result = { ...defaults };
      result['TreeView.detailsState.window-1'] = 0;
      return result;
    };
    const tree = new TreeView({
      isInert: true,
      document: null,
      window: null
    });
    tree.cfg.keyBindings = { toggleLoad: 'Ctrl+L' };
    tree.updateKeyBindings();

    assertEqual(getCalls, 0,
      'Applying key bindings should use the config already loaded at startup');
    assertEqual(tree.getKeyBindingForAction('toggleLoad'), 'Ctrl+L',
      'The cached user binding should be applied');

    tree.windowNode = { id: 'window-1' };
    const values = await tree.getWindowConfigs({
      viewScope: 'session',
      detailsState: 1
    });

    assertEqual(getCalls, 1,
      'Per-window settings should be fetched in one storage request');
    assertEqual(values.viewScope, 'session',
      'Missing settings should retain their supplied defaults');
    assertEqual(values.detailsState, 0,
      'Falsey per-window settings should be retained');

    await tree.getWindowConfig('detailsState', 1);
    assertEqual(getCalls, 1,
      'Cached per-window settings should not trigger another storage read');
  } finally {
    api.storage.local.get = originalGet;
  }
});

test('ThemedPage falls back before creating theme links', async () => {
  const originalDocument = globalThis.document;
  const elements = new Map();
  const appended = [];
  const doc = {
    head: {
      appendChild: (element) => {
        appended.push(element);
        if (element.id) elements.set(element.id, element);
      }
    },
    body: {
      classList: { add: () => {} }
    },
    createElement: (tagName) => ({ tagName }),
    getElementById: id => elements.get(id) || null,
    querySelector: () => null
  };
  try {
    globalThis.document = doc;
    const page = new ThemedPage('/view/sidepanel');
    page.cfg.theme = 'Removed Theme';

    page.initElements();

    assertEqual(elements.get('theme-base').href, '/themes/tk.css',
      'Invalid theme should use the default base stylesheet');
    assertEqual(elements.get('theme-variant').href, '/themes/tk-night.css',
      'Invalid theme should use the default variant stylesheet');
    assertEqual(appended.length, 5,
      'Theme initialization should create the expected elements');
  } finally {
    if (undefined === originalDocument) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});

test('PresetOption keeps presets and custom values in one config key',
async () => {
  function control(values = []) {
    const listeners = {};
    const classes = new Set();
    return {
      value: '',
      options: values.map((value) => ({ value })),
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name)
      },
      addEventListener: (name, listener) => {
        listeners[name] = listener;
      },
      dispatch: async (name, event = {}) => {
        return await listeners[name]?.(event);
      }
    };
  }

  const select = control(['0.85rem', '1.15rem', '1.5rem']);
  const custom = control();
  const elements = new Map([
    ['fontSize', select],
    ['fontSizeCustom', custom]
  ]);
  const saved = [];
  const cfg = {
    fontSize: '17px',
    async set(key, value) {
      this[key] = value;
      saved.push([key, value]);
    }
  };
  const option = new PresetOption({
    cfg,
    $doc: {
      getElementById: (id) => elements.get(id) || null
    }
  }, {
    cfgKey: 'fontSize',
    customElementId: 'fontSizeCustom',
    fallbackValue: '1.15rem',
    debounceTime: 0
  });

  option.init();
  assertEqual(select.value, '1.15rem',
    'A custom stored value should leave the selector on its default');
  assertEqual(custom.value, '17px',
    'A custom stored value should remain editable');

  select.value = '1.5rem';
  await select.dispatch('change');
  assertEqual(cfg.fontSize, '1.5rem',
    'Choosing a preset should save it');
  assertEqual(custom.value, '',
    'Choosing a preset should clear the custom override');

  custom.value = ' 20px ';
  await custom.dispatch('input');
  assertEqual(cfg.fontSize, '20px',
    'Typing a custom value should save the trimmed override');

  custom.value = '';
  await custom.dispatch('blur');
  assertEqual(cfg.fontSize, '1.5rem',
    'Clearing the custom value should restore the selected preset');
  assertEqual(saved.length, 3,
    'Each completed user change should produce one config write');
});

test('backup cleaner validates candidate content before deleting duplicates',
  async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const crypto = await import('node:crypto');
    const childProcess = await import('node:child_process');
    const url = await import('node:url');
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tktsto-cleaner-')
    );
    try {
      const inputPath = path.join(tempDir, 'backup.json');
      const auditPath = path.join(tempDir, 'audit.json');
      const outputPath = path.join(tempDir, 'cleaned.json');
      const backup = {
        nodes: {
          root: { id: 'root', nodes: ['one', 'two'] },
          one: {
            id: 'one',
            type: 'tab',
            url: 'https://example.com',
            nodes: []
          },
          two: {
            id: 'two',
            type: '',
            url: 'https://example.com',
            nodes: []
          }
        }
      };
      const makeAudit = (bytes) => ({
        source: {
          file: path.basename(inputPath),
          sha256: crypto.createHash('sha256')
            .update(bytes)
            .digest('hex')
        },
        counts: { nodes: 3 },
        sameContentSiblingSubtrees: { candidates: [] },
        sameUrlBoringSiblingLeaves: {
          candidates: [{
            keeperId: 'one',
            duplicateIds: ['two']
          }]
        }
      });
      const inputBytes = JSON.stringify(backup);
      fs.writeFileSync(inputPath, inputBytes);
      fs.writeFileSync(auditPath, JSON.stringify(makeAudit(inputBytes)));

      const cleanerPath = url.fileURLToPath(
        new URL('../../bin/clean-backup-duplicates.mjs', import.meta.url)
      );
      const result = childProcess.spawnSync(
        process.execPath,
        [cleanerPath, inputPath, auditPath, outputPath],
        { encoding: 'utf8' }
      );

      assert(result.status !== 0,
        'Cleaner should reject a candidate the analyzer could not produce');
      assert(result.stderr.includes('Leaf candidate content differs'),
        'Cleaner should explain that candidate content differs');
      assert(! fs.existsSync(outputPath),
        'Cleaner should not write output after rejecting the audit');

      const overwriteResult = childProcess.spawnSync(
        process.execPath,
        [cleanerPath, inputPath, auditPath, inputPath],
        { encoding: 'utf8' }
      );
      assert(overwriteResult.status !== 0,
        'Cleaner should refuse to use the source as its output');
      assert(overwriteResult.stderr.includes('overwrite the source backup'),
        'Cleaner should explain the destructive path conflict');
      assertEqual(fs.readFileSync(inputPath, 'utf8'), inputBytes,
        'Refused cleanup must leave the source bytes unchanged');

      backup.nodes.two.type = 'tab';
      const validBytes = JSON.stringify(backup);
      fs.writeFileSync(inputPath, validBytes);
      fs.writeFileSync(auditPath, JSON.stringify(makeAudit(validBytes)));
      const validResult = childProcess.spawnSync(
        process.execPath,
        [cleanerPath, inputPath, auditPath, outputPath],
        { encoding: 'utf8' }
      );
      assertEqual(validResult.status, 0,
        'Cleaner should accept a genuine analyzer candidate');
      const cleaned = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assertEqual(Object.keys(cleaned.nodes).length, 2,
        'Cleaner should remove exactly one duplicate leaf');
      assertEqual(cleaned.nodes.root.nodes.join(','), 'one',
        'Cleaner should retain the selected keeper');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
);

test('reorder error includes the requested node ID', async () => {
  const bkgd = new Bkgd();
  bkgd.tree = { nodes: {} };
  bkgd.resolveTreeLoaded();

  const response = await bkgd.bkgd_reorderAllTabsInThisWindow({
    nodeId: 'missing-node'
  });

  assert(response.error.includes('missing-node'),
    'Missing-node error should interpolate the requested ID');
});

test('reorder debounce preserves requests for different windows',
async () => {
  const bkgd = new Bkgd();
  const calls = [];
  const firstWindow = {
    id: 'reorder-window-one',
    getWindowNode: () => firstWindow,
    reorderAllTabsInThisWindow: async () => {
      calls.push(firstWindow.id);
    }
  };
  const secondWindow = {
    id: 'reorder-window-two',
    getWindowNode: () => secondWindow,
    reorderAllTabsInThisWindow: async () => {
      calls.push(secondWindow.id);
    }
  };
  bkgd.tree = {
    nodes: {
      [firstWindow.id]: firstWindow,
      [secondWindow.id]: secondWindow
    }
  };
  bkgd.tabReorderDebounceTime = 0;
  bkgd.resolveTreeLoaded();

  await Promise.all([
    bkgd.bkgd_reorderAllTabsInThisWindow({ nodeId: firstWindow.id }),
    bkgd.bkgd_reorderAllTabsInThisWindow({ nodeId: secondWindow.id })
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));

  assertEqual(calls.sort().join(','),
    [firstWindow.id, secondWindow.id].sort().join(','),
    'Debouncing one window must not discard another window request');
});

test('reorder debounce reruns when a request arrives during execution',
async () => {
  const bkgd = new Bkgd();
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => {
    firstStarted = resolve;
  });
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const forces = [];
  const windowNode = {
    id: 'reorder-window-rerun',
    getWindowNode: () => windowNode,
    reorderAllTabsInThisWindow: async ({ force }) => {
      forces.push(force);
      if (forces.length === 1) {
        firstStarted();
        await firstGate;
      }
    }
  };
  bkgd.tree = { nodes: { [windowNode.id]: windowNode } };
  bkgd.tabReorderDebounceTime = 0;
  bkgd.resolveTreeLoaded();

  await bkgd.bkgd_reorderAllTabsInThisWindow({
    nodeId: windowNode.id
  });
  await firstStartedPromise;
  const pending = await bkgd.bkgd_reorderAllTabsInThisWindow({
    nodeId: windowNode.id,
    force: true
  });
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 20));

  assertEqual(pending.result, 'ok pending',
    'An in-flight duplicate should be acknowledged as pending');
  assertEqual(forces.join(','), 'false,true',
    'An in-flight request should run again and preserve force');
});

async function runTests() {
  const mods = await Promise.all([
    import('/api.js'),
    import('/bkgd/bkgd.js'),
    import('/bkgd/reconcile.js'),
    import('/bkgd/treestore.js'),
    import('/common/tree.js'),
    import('/common/node.js'),
    import('/common/common.js'),
    import('/themes/themes.js'),
    import('/bkgd/idb.js'),
    import('/bkgd/nodestore.js'),
    import('/view/treeview.js'),
    import('/options/options.js'),
    import('/common/events.js'),
    import('/common/keybindings.js')
  ]);
  api = mods[0].api;
  compareBrowserVersions = mods[0].compareBrowserVersions;
  Bkgd = mods[1].Bkgd;
  runReconcile = mods[2].runReconcile;
  TreeStore = mods[3].TreeStore;
  Tree = mods[4].Tree;
  Node = mods[5].Node;
  emit = mods[6].emit;
  ThemedPage = mods[7].ThemedPage;
  IDB = mods[8].IDB;
  NodeStore = mods[9].NodeStore;
  TreeView = mods[10].TreeView;
  PresetOption = mods[11].PresetOption;
  buildEventName = mods[12].buildEventName;
  normalizeKeyBinding = mods[12].normalizeKeyBinding;
  defaultKeyBindings = mods[13].defaultKeyBindings;
  normalizeKeyBindingOverrides =
    mods[13].normalizeKeyBindingOverrides;
  jsonSchema = mods[6].jsonSchema;
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

  const { registerNativeContextTests } = await import('./native-context.test.mjs');
  await registerNativeContextTests({
    test, assert, assertEqual, api, Bkgd, Tree, Node, NodeStore, createTree, addChild
  });

  const { registerReliabilityTests } = await import('./reliability.test.mjs');
  await registerReliabilityTests({
    test, assert, assertEqual, api, emit, Bkgd, Tree, TreeStore, Node, NodeStore,
    TreeView, createTree, addChild, jsonSchema, IDB
  });

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
