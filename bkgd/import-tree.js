// Stage complete validated imports, then publish only committed nodes.
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
import { emit, warn } from '/common/common.js';
import { Mutex } from '/common/mutex.js';

export async function commitImportedGraph(tree, graph) {
  const liveRoot = tree.root;
  const staged = new Map(), allocated = new Set();
  for (const oldId of graph.order) {
    const record = graph.records[oldId];
    const parent = oldId === graph.rootId ? liveRoot : staged.get(record.parent);
    const node = new tree.NodeClass(tree, parent);
    let id;
    for (let attempt = 0; attempt < 10; attempt++) {
      id = await (liveRoot.newNodeId ? liveRoot.newNodeId() : tree.newNodeId());
      if (typeof id === 'string' && id && ! Object.hasOwn(tree.nodes, id) && ! allocated.has(id)) break;
      id = null;
    }
    if (! id) throw new Error('Could not allocate a unique imported node ID');
    allocated.add(id);
    for (const key of tree.dictable) {
      if (key !== 'id' && Object.hasOwn(record, key)) node[key] = record[key];
    }
    node.id = id;
    staged.set(oldId, node);
    if (parent !== liveRoot) parent.nodes.push(node);
  }
  const importedRoot = staged.get(graph.rootId);
  if (! importedRoot) throw new Error('Imported graph has no root');
  // Existing dirty data must be saved before beginning a separate import.
  await liveRoot.flushPendingPersistence?.();
  tree.persistenceMutex ??= new Mutex();
  const unlock = await tree.persistenceMutex.lock();
  try {
    if (tree.root !== liveRoot) throw new Error('The destination tree changed during import');
    for (const id of allocated) {
      if (Object.hasOwn(tree.nodes, id)) throw new Error('An imported node ID was taken concurrently');
    }
    const rootRecord = liveRoot.toDict();
    rootRecord.nodes = [...rootRecord.nodes, importedRoot.id];
    rootRecord.ctime = Math.min(liveRoot.ctime, importedRoot.ctime);
    rootRecord.mtime = Date.now();
    if (tree.db) {
      if (! tree.db.writeNodes) throw new Error('Atomic import requires transactional storage');
      // Detached records are deliberately not put in the dirty-write queue.
      // A failed transaction must not leave a partially imported live tree.
      await tree.db.writeNodes([
        { id: liveRoot.id, toDict: () => rootRecord }, ...staged.values()
      ], []);
    }
    // No await or user-controlled code between publishing cache and ancestry.
    // Merge with the CURRENT root: a concurrent edit queued behind our DB
    // transaction retains its own changes and persists this new child too.
    for (const node of staged.values()) tree.nodes[node.id] = node;
    liveRoot.nodes.push(importedRoot);
    liveRoot.ctime = Math.min(liveRoot.ctime, importedRoot.ctime);
    liveRoot.mtime = Math.max(liveRoot.mtime, rootRecord.mtime);
  } finally { unlock(); }
  // A lost notification does not undo a committed import or invite duplicates.
  try { await emit('tree_refreshAll', {}, { retry: false }); }
  catch (err) { warn('Import committed; sidebar refresh failed', err); }
  return importedRoot;
}
