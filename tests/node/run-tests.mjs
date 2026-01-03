// tests/node/run-tests.mjs: Node-based test runner for core modules
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

globalThis.__TKTSTO_TEST__ = true;

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
    alarms: { onAlarm: { addListener: () => {} } },
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
let Bkgd;
let Tree;
let Node;
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

  const match1 = tree.findMatchingWindow(realWindow);
  assert(match1, 'Should match a window node');

  const exclude = new Set([match1.id]);
  const match2 = tree.findMatchingWindow(realWindow, exclude);
  assert(match2, 'Should match a second window node');
  assert(match2.id !== match1.id, 'Exclude list should prevent reuse');
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

async function runTests() {
  const mods = await Promise.all([
    import('/api.js'),
    import('/bkgd/bkgd.js'),
    import('/common/tree.js'),
    import('/common/node.js')
  ]);
  api = mods[0].api;
  Bkgd = mods[1].Bkgd;
  Tree = mods[2].Tree;
  Node = mods[3].Node;
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
