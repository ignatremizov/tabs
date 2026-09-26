// Durable, bounded recovery for explicit outline deletions, not browser closes.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
import { api } from '/api.js';
import { emit, warn } from '/common/common.js';
import { validateNodeGraph, isRecord, treeDataLimits } from '/common/serialized-tree.js';
import { historyKey, historyBytes, historyPolicy, historyPruneIds,
  deletionFingerprint } from '/common/deletion-history.js';
import { runReconcile } from '/bkgd/reconcile.js';

const bindings = ['tabId', 'oldTabId', 'windowId', 'groupId', 'groupWindowId',
  'restoreError', 'discarded', 'frozen', 'hidden'];
const label = node => String(node.label || node.title || node.url ||
  (node.type === 'window' ? 'Window' : 'Untitled note')).slice(0, 240);
const copy = value => structuredClone(value);

function savedRecord(node) {
  const record = copy(node.toDict ? node.toDict() : node);
  for (const field of bindings) delete record[field];
  record.wasLoaded = Boolean(record.wasLoaded || record.loaded);
  record.loaded = false; record.active = false; record.marked = false;
  return record;
}

function location(node) {
  const names = [];
  for (let at = node; at && ! at.isRoot() && names.length < 12; at = at.parent) {
    names.unshift(label(at));
  }
  return names.join(' / ') || 'Session';
}

export class DeletionHistory {
  constructor(bkgd) { this.bkgd = bkgd; }
  get tree() { return this.bkgd.tree; }

  async locked(operation) {
    await this.bkgd.treeLoaded;
    const tree = this.tree;
    const unlock = await tree.onMessageMutex.lock();
    try {
      return await this.bkgd.runSerializedBrowserMutation(async () => {
        const run = async () => {
          // A pending browser restore may still retain Node references. Do not
          // remove its destinations or wait for creation events under our lock.
          if (this.bkgd.activeBrowserCreates || this.bkgd.nodesLoading.length
            || this.bkgd.windowsLoading.length) {
            throw new Error('Tabs are still being restored. Wait for them to finish and try again.');
          }
          await tree.root.flushPendingPersistence();
          const release = await tree.persistenceMutex.lock();
          // Most mutations already use the message/browser/context locks.
          // This short barrier also catches delayed direct NodeStore work
          // (for example, a deferred callback with an old Node reference).
          let resume;
          tree.historyBarrier = new Promise(resolve => { resume = resolve; });
          try { return await operation(); }
          finally { delete tree.historyBarrier; release(); resume(); }
        };
        return this.bkgd.tabGroups?.supported
          ? this.bkgd.tabGroups.withOutlineMutation(run) : run();
      });
    } finally { unlock(); }
  }

  notify(treeChanged = false) {
    // Publication has already committed. Lost UI delivery must not replay it.
    const messages = treeChanged ? ['tree_refreshAll', 'tree_historyChanged'] : ['tree_historyChanged'];
    for (const name of messages) {
      emit(name, {}, { retry: false }).catch(() => {
        warn('Deletion history committed; an outline view needs to reconnect');
      });
    }
  }

  async list() {
    await this.bkgd.treeLoaded;
    // Pruning/listing uses IndexedDB's serialization, not browser mutation
    // locks. It cannot change the active outline or open/close a browser tab.
    await this.tree.db.commitHistoryChange();
    const { rows, policy } = await this.tree.db.loadHistoryState();
    const entries = rows.filter(row => row.status === 'deleted')
      .sort((a, b) => b.deletedAt - a.deletedAt || b.key.localeCompare(a.key))
      .map(row => ({ id: row.key, deletedAt: row.deletedAt, bytes: row.bytes,
        label: String(row.summary?.label || 'Untitled branch'),
        location: String(row.summary?.location || 'Session'),
        nodeCount: row.summary?.nodeCount || 0, tabCount: row.summary?.tabCount || 0,
        branchCount: row.summary?.branchCount || 0 }));
    return { entries, policy, bytes: entries.reduce((sum, row) => sum + row.bytes, 0) };
  }

  async configure(value) {
    const policy = historyPolicy(value);
    await this.bkgd.treeLoaded;
    await this.tree.db.commitHistoryChange({ policy });
    this.notify();
    return this.list();
  }

  async prune() {
    await this.bkgd.treeLoaded;
    const result = await this.tree.db.commitHistoryChange();
    if (result.pruned) this.notify();
  }

  async purge(ids) {
    if (! Array.isArray(ids) || ! ids.length || ids.length > 1000) {
      throw new TypeError('Choose specific deletion-history entries to remove');
    }
    ids.forEach(historyKey);
    await this.bkgd.treeLoaded;
    await this.tree.db.commitHistoryChange({ purge: [...new Set(ids)] });
    this.notify();
    return { purged: ids.length };
  }

  async delete({ entryId, items, privateConfirmed = false }) {
    historyKey(entryId);
    if (! Array.isArray(items) || ! items.length || items.length > 1000) {
      throw new TypeError('Invalid deletion selection');
    }
    return this.locked(async () => {
      const tree = this.tree;
      const state = await tree.db.loadHistoryState();
      const previous = state.rows.find(row => row.key === entryId);
      // IDs identify an action, not its current nodes. Retrying a delivered
      // request after restart must never delete a subsequently restored node.
      if (previous) return { entryId, alreadyApplied: true, deleted: [] };
      const selected = new Map();
      for (const item of items) {
        if (! isRecord(item) || ! ['branch', 'promoteKids'].includes(item.mode)
          || typeof item.fingerprint !== 'string' || ! /^[0-9a-f]{64}$/.test(item.fingerprint)) {
          throw new TypeError('Invalid deletion request');
        }
        const node = tree.nodes[item.nodeId];
        if (! node || node.isRoot()) throw new Error('The selection changed. Refresh the outline and try again.');
        if (selected.has(node.id)) continue;
        if (await deletionFingerprint(node, item.mode) !== item.fingerprint) {
          throw new Error('The selected branch was edited in another view. Review it before deleting.');
        }
        selected.set(node.id, { node, mode: item.mode });
      }
      // Drop nested selections already covered by a whole-branch deletion.
      for (const [id, { node }] of selected) {
        for (let parent = node.parent; parent && ! parent.isRoot(); parent = parent.parent) {
          if (selected.get(parent.id)?.mode === 'branch') { selected.delete(id); break; }
        }
      }
      const removed = new Map();
      for (const { node, mode } of selected.values()) {
        const stack = [node];
        while (stack.length) {
          const next = stack.pop();
          if (removed.has(next.id)) continue;
          if (removed.size >= treeDataLimits.nodes - 1 || next.browserLoadInProgress) {
            throw new Error('The selection is too large or is still being restored. Nothing was deleted.');
          }
          removed.set(next.id, next);
          if (mode === 'branch') stack.push(...next.nodes);
        }
      }
      const privateData = [...removed.values()].some(node => node.incognito
        || node.cookieStoreId === 'firefox-private' || node.getWindowNode(false)?.incognito);
      if (privateData && ! privateConfirmed) {
        return { requiresPrivateConfirmation: true };
      }
      const records = Object.create(null);
      records.root = { id: 'root', parent: 'root', nodes: [] };
      const roots = [];
      for (const node of removed.values()) {
        const record = savedRecord(node);
        record.nodes = node.nodes.filter(child => removed.has(child.id)).map(child => child.id);
        if (! removed.has(node.parent.id)) {
          record.parent = 'root'; records.root.nodes.push(node.id);
          const group = node.getNativeGroupNode();
          roots.push({ id: node.id, parentId: node.parent.id, index: node.indexOf(),
            previousId: node.parent.nodes[node.indexOf() - 1]?.id || null,
            nextId: node.parent.nodes[node.indexOf() + 1]?.id || null,
            location: location(node.parent),
            group: group && ! removed.has(group.id) ? savedRecord(group) : null });
        }
        records[node.id] = record;
      }
      validateNodeGraph(records);
      const updates = new Map();
      const getUpdate = node => {
        if (! updates.has(node.id)) updates.set(node.id, copy(node.toDict()));
        return updates.get(node.id);
      };
      const promote = node => {
        if (! removed.has(node.id)) return [node];
        return selected.get(node.id)?.mode === 'promoteKids'
          ? node.nodes.flatMap(promote) : [];
      };
      for (const node of removed.values()) {
        if (removed.has(node.parent.id)) continue;
        const parent = node.parent, record = getUpdate(parent);
        const children = parent.nodes.flatMap(promote);
        record.nodes = children.map(child => child.id); record.mtime = Date.now();
        for (const child of children) {
          if (child.parent !== parent) getUpdate(child).parent = parent.id;
        }
      }
      const now = Date.now();
      // Private-window records never acquire a second persistent copy. An
      // explicit confirmation permits an atomic deletion with a data-free
      // receipt, not recoverable private history.
      const row = privateData
        ? { key: entryId, deletedAt: now, status: 'restored', bytes: 128,
            result: { privateDeletion: true } }
        : { key: entryId, deletedAt: now, status: 'deleted',
            data: JSON.stringify({ schema: 1, records, roots }),
            summary: { label: label(selected.values().next().value.node),
              location: roots[0].location, nodeCount: removed.size,
              branchCount: roots.length, tabCount: [...removed.values()].filter(node => node.url).length } };
      row.bytes = historyBytes(row) + 32;
      historyPruneIds([...state.rows, row], state.policy, now, row.key);
      const nativeTabs = [...removed.values()].filter(node => node.loaded && Number.isInteger(node.tabId))
        .map(node => node.tabId);
      const ungroup = [];
      for (const {node, mode} of selected.values()) {
        if (node.nativeGroup && mode === 'promoteKids' && Number.isInteger(node.groupId)
          && api.tabs?.query && api.tabs?.ungroup) {
          const tabs = await api.tabs.query({groupId: node.groupId});
          ungroup.push(...tabs.filter(tab => ! nativeTabs.includes(tab.id)).map(tab => tab.id));
        }
      }
      await tree.db.commitHistoryChange({ nodes: [...updates.values()],
        deleteNodeIds: [...removed.keys()], add: row, now });
      // No await between durable commit and publication of the new live tree.
      this.publish(updates, new Map(), removed);
      this.notify(true);
      let closeFailures = 0, groupFailures = 0;
      if (ungroup.length) {
        try { await api.tabs.ungroup(ungroup); }
        catch { groupFailures++; }
      }
      for (const id of nativeTabs) {
        try { await api.tabs.remove(id); }
        catch { closeFailures++; }
      }
      // Closing tabs is intentionally after durability. A surviving browser
      // tab is reconciled normally; a close failure cannot erase its history.
      if (closeFailures || groupFailures) {
        const timer = setTimeout(() => this.bkgd.runSerializedBrowserMutation(
          () => runReconcile.call(this.bkgd, {reason:'historyCloseRecovery'})
        ).catch(() => warn('Some browser changes could not finish; retry outline reconciliation')), 0);
        timer.unref?.();
      }
      return { entryId, deleted: [...selected].map(([nodeId, item]) => ({nodeId, mode:item.mode})),
        count: removed.size, privateDeletion: privateData, closeFailures, groupFailures };
    });
  }

  publish(updates, added, removed = new Map()) {
    const tree = this.tree;
    for (const [id, node] of added) tree.nodes[id] = node;
    for (const [id] of removed) delete tree.nodes[id];
    for (const [id, record] of updates) {
      const node = tree.nodes[id];
      // Patch only structural fields on existing objects; queued unrelated
      // title/favicon updates must not be reverted by an older snapshot.
      node.nodes = record.nodes.map(child => tree.nodes[child]);
      node.parent = tree.nodes[record.parent];
      node.mtime = Math.max(node.mtime, record.mtime || 0);
    }
    for (const node of removed.values()) {
      clearTimeout(node.setActiveTabTimer);
      for (const resolve of node.setActiveTabWaiters || []) resolve();
      node.setActiveTabWaiters = []; node.parent = null;
      tree.pendingMoves.delete(node.id);
    }
    tree.markedNodes = tree.markedNodes.filter(value => tree.nodes[typeof value === 'string' ? value : value.id]);
    // The ID generator's cache follows tree.nodes (we never replace that map).
  }

  async restore(entryId) {
    historyKey(entryId);
    return this.locked(async () => {
      const tree = this.tree;
      const {rows, policy} = await tree.db.loadHistoryState();
      const row = rows.find(item => item.key === entryId);
      if (! row || historyPruneIds(rows, policy).includes(entryId)) {
        throw new Error('This entry expired or was permanently removed. Check an exported backup.');
      }
      if (row.status === 'restored') return { ...row.result, alreadyRestored: true };
      const data = JSON.parse(row.data);
      if (! isRecord(data) || data.schema !== 1 || ! Array.isArray(data.roots)) {
        throw new Error('Invalid recovery data. The entry has been preserved.');
      }
      const graph = validateNodeGraph(data.records);
      if (data.roots.length !== graph.records.root.nodes.length
        || new Set(data.roots.map(root => root.id)).size !== data.roots.length
        || ! data.roots.every(root => graph.records.root.nodes.includes(root.id)
          && typeof root.parentId === 'string' && Number.isSafeInteger(root.index) && root.index >= 0)) {
        throw new Error('Invalid recovery locations. The entry has been preserved.');
      }
      const updates = new Map(), added = new Map(), ids = new Map(), allocated = new Set();
      const allocate = original => {
        if (original && ! tree.nodes[original] && ! added.has(original)
          && ! allocated.has(original)) { allocated.add(original); return original; }
        for (let attempt = 0; attempt < 10; attempt++) {
          const id = this.bkgd.idGen.newId();
          if (typeof id === 'string' && id && ! Object.hasOwn(tree.nodes, id)
            && ! allocated.has(id)) { allocated.add(id); return id; }
        }
        throw new Error('Could not allocate unique recovered node IDs');
      };
      const make = (record, original = null) => {
        const node = new tree.NodeClass(tree, null), saved = savedRecord(record);
        for (const key of tree.dictable) if (Object.hasOwn(saved, key)) node[key] = saved[key];
        node.recoveryId = entryId;
        node.id = allocate(original); added.set(node.id, node);
        return node;
      };
      const patch = node => {
        if (! updates.has(node.id)) updates.set(node.id, copy(node.toDict()));
        return updates.get(node.id);
      };
      const append = (node, parent, index = null) => {
        const parentRecord = patch(parent), record = patch(node);
        record.parent = parent.id;
        parentRecord.nodes.splice(index ?? parentRecord.nodes.length, 0, node.id);
        parentRecord.mtime = Date.now();
      };
      for (const oldId of graph.order) {
        if (oldId !== 'root') ids.set(oldId, make(graph.records[oldId], oldId).id);
      }
      for (const oldId of graph.order) {
        if (oldId === 'root') continue;
        const node = added.get(ids.get(oldId)), record = graph.records[oldId];
        const update = patch(node);
        update.nodes = record.nodes.map(id => ids.get(id));
        update.parent = ids.get(record.parent) || tree.root.id;
      }
      let recovered = null;
      const groups = new Map();
      let fallbackCount = 0;
      // Restore sibling roots in their original order. Arbitrary mark/click
      // order must not make absent sibling anchors reorder a recovered batch.
      const rootOrder = data.roots.slice().sort((a, b) =>
        a.parentId.localeCompare(b.parentId) || a.index - b.index);
      for (const root of rootOrder) {
        const node = added.get(ids.get(root.id));
        let parent = tree.nodes[root.parentId];
        if (root.group && parent?.getNativeGroupNode()?.id !== root.group.id) parent = null;
        if (! parent) {
          fallbackCount++;
          let group = null;
          if (root.group) {
            const groupRecord = savedRecord(root.group);
            validateNodeGraph({root:{id:'root',parent:'root',nodes:['group']},
              group:{...groupRecord,id:'group',parent:'root',nodes:[]}});
            if (! groupRecord.nativeGroup) throw new Error('Invalid saved group metadata');
            const existing = tree.nodes[root.group.id];
            group = existing?.nativeGroup ? existing : groups.get(root.group.id);
          }
          // A surviving native-group note is already a suitable recovery
          // location; do not create an unused empty folder beside it.
          if (group) parent = group;
          else {
            if (! recovered) {
              recovered = make({ label: 'Recovered deletions', expanded: true,
                note: 'The original location no longer exists. Recovered pages remain saved.' });
              append(recovered, tree.root);
            }
            parent = recovered;
            if (root.group) {
              group = make({...savedRecord(root.group),nodes:[]}, root.group.id);
              groups.set(root.group.id, group); append(group, recovered);
              parent = group;
            }
          }
        }
        const siblings = patch(parent).nodes;
        const next = siblings.indexOf(root.nextId), prev = siblings.indexOf(root.previousId);
        const index = next >= 0 ? next : prev >= 0 ? prev + 1 : Math.min(root.index, siblings.length);
        append(node, parent, index);
      }
      // Validate final depth/size and ownership before writing anything. Only
      // changed records, not a full-session copy, go into the transaction.
      const combined = tree.serializeNodes();
      for (const [id, record] of updates) combined[id] = record;
      validateNodeGraph(combined);
      const result = { entryId, restored: ids.size, fallbackCount,
        // Root IDs suffice for navigation and bounded idempotence receipts.
        rootIds: data.roots.map(root => ids.get(root.id)) };
      await tree.db.commitHistoryChange({ nodes: [...updates.values()],
        consume: { key: entryId, expectedData: row.data, result } });
      this.publish(updates, added);
      this.notify(true);
      return result;
    });
  }
}
