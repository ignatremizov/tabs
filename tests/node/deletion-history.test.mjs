// Persistent deletion recovery regressions.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
import { historyDefaults, historyPolicy, historyPruneIds, historyBytes,
  historyKey, deletionFingerprint } from '/common/deletion-history.js';

export async function registerDeletionHistoryTests(h) {
  const { test, assert, assertEqual: eq, api, Bkgd, Tree, TreeStore, NodeStore, addChild } = h;
  async function fixture(run) {
    const bkgd = new Bkgd(), tree = new Tree(NodeStore);
    bkgd.tree = tree; tree.bkgd = bkgd;
    let next = 0; bkgd.idGen = {newId: () => `history-node-${++next}`};
    const records = new Map(), rows = new Map(), closed = [];
    let policy = {...historyDefaults};
    tree.runPersistenceBatch = TreeStore.prototype.runPersistenceBatch.bind(tree);
    tree.db = {
      writeNodes: async (nodes, deletes = []) => {
        for (const node of nodes) records.set(node.id, structuredClone(node.toDict()));
        for (const id of deletes) records.delete(id);
      },
      loadHistoryState: async () => ({rows:structuredClone([...rows.values()]), policy}),
      commitHistoryChange: async ({nodes=[],deleteNodeIds=[],add,consume,purge=[],policy:limits,now=Date.now()} = {}) => {
        const draft = new Map(structuredClone([...rows]));
        policy = limits || policy;
        if (add) {assert(!draft.has(add.key));draft.set(add.key,structuredClone(add));}
        if (consume) {
          const old=draft.get(consume.key);
          assert(old?.status==='deleted' && old.data===consume.expectedData);
          draft.set(old.key,{key:old.key,deletedAt:old.deletedAt,status:'restored',bytes:128,result:structuredClone(consume.result)});
        }
        for (const id of [...purge,...historyPruneIds([...draft.values()],policy,now,add?.key)]) draft.delete(id);
        rows.clear(); for(const [id,row] of draft) rows.set(id,row);
        for(const node of nodes) records.set(node.id,structuredClone(node));
        for(const id of deleteNodeIds) records.delete(id);
        return {};
      }
    };
    bkgd.resolveTreeLoaded(); tree.resolveTreeLoaded(); tree.reorderTabsOnCreate=false;
    const before=api.tabs.remove;
    api.tabs.remove=async id=>{closed.push(id);};
    const item=async (node,mode='branch')=>({nodeId:node.id,mode,fingerprint:await deletionFingerprint(node,mode)});
    const remove=async (node,mode='branch',extra={})=>bkgd.deletionHistory.delete({entryId:`deletion-${++next}`,items:[await item(node,mode)],...extra});
    try { await run({tree,bkgd,records,rows,closed,item,remove,add:async(parent,fields)=>addChild(parent,fields)}); }
    finally {api.tabs.remove=before;clearTimeout(bkgd.tabGroups.syncTimer);}
  }
  const rejects = fn => { try { fn(); } catch { return true; } return false; };
  test('history limits reject invalid, disabled, and unbounded retention values', () => {
    eq(historyPolicy().entries, 200);
    for (const value of [null, [], { ...historyDefaults, days: 0 },
      { ...historyDefaults, entries: 1001 }, { ...historyDefaults, bytes: NaN },
      { ...historyDefaults, days: '30' }, { ...historyDefaults, unexpected: true }]) {
      assert(rejects(() => historyPolicy(value)));
    }
    for (const id of ['', '__proto__', '../entry', 'a'.repeat(161)]) {
      assert(rejects(() => historyKey(id)));
    }
    eq(historyKey('delete-123'), 'delete-123');
  });
  test('history pruning retains newest actions and handles equal timestamps', () => {
    const rows = [1, 2, 3].map(i => ({key: `entry-${i}`, deletedAt: 100,
      status: 'deleted', bytes: 100}));
    const pruned = historyPruneIds(rows, { ...historyDefaults, entries: 1 }, 100, 'entry-1');
    assert(!pruned.includes('entry-1')); eq(pruned.length, 2);
  });
  test('history pruning enforces both age and bytes, never deleting an oversized new action', () => {
    const now = 40 * 86400000;
    const rows = [{key: 'old', deletedAt: 0, bytes: 1, status: 'deleted'},
      {key: 'large', deletedAt: now, bytes: 1048577, status: 'deleted'}];
    assert(rejects(() => historyPruneIds(rows, { ...historyDefaults, bytes: 1048576 }, now, 'large')));
    const pruned = historyPruneIds(rows, historyDefaults, now);
    eq(pruned.join(','), 'old');
  });
  test('consumed history receipts are bounded without crowding out recoverable actions', () => {
    const rows = [1,2,3].map(i => ({key: `receipt-${i}`, deletedAt: i,
      status: 'restored', bytes: 0}));
    rows.push({key: 'recoverable', deletedAt: 0, status: 'deleted', bytes: 100});
    const pruned = historyPruneIds(rows, {...historyDefaults, entries: 1}, 4);
    eq(pruned.length, 2); assert(!pruned.includes('recoverable'));
    assert(historyBytes({text: '🔒'}) > JSON.stringify({text: '🔒'}).length);
  });
  test('history branch deletion commits complete records before removing memory or closing tabs', () => fixture(async ({tree,bkgd,records,rows,closed,remove,add}) => {
    const parent=await add(tree.root,{label:'Keep'});
    const branch=await add(parent,{label:'Research',nativeGroup:true,groupId:8,groupTitle:'Research',groupColor:'blue'});
    const tab=await add(branch,{url:'https://example.test/work',loaded:true,tabId:33,windowId:4,
      cookieStoreId:'firefox-container-2',containerProfileId:'same-profile',containerName:'Work',note:'Remember',checkbox:'🔒'});
    const annotation=await add(tab,{note:'Nested saved context'});
    const write=tree.db.commitHistoryChange;
    tree.db.commitHistoryChange=async change=>{
      assert(tree.nodes[branch.id]===branch && tree.nodes[tab.id]===tab);eq(closed.length,0);
      await write(change);
    };
    const result=await remove(branch); eq(result.count,3);eq(rows.size,1);eq(closed.join(','),'33');
    assert(!tree.nodes[branch.id] && !records.has(annotation.id));eq(parent.nodes.length,0);
    const saved=JSON.parse([...rows.values()][0].data).records;
    eq(saved[tab.id].note,'Remember');eq(saved[tab.id].checkbox,'🔒');eq(saved[tab.id].containerProfileId,'same-profile');
    eq(saved[tab.id].loaded,false);eq(saved[tab.id].wasLoaded,true);
    assert(!('tabId' in saved[tab.id]) && !('groupId' in saved[branch.id]));
  }));
  test('failed history transaction leaves memory, storage, and browser tabs untouched', () => fixture(async ({tree,records,rows,closed,remove,add}) => {
    const branch=await add(tree.root,{label:'Original',url:'https://example.test',loaded:true,tabId:7});
    tree.db.commitHistoryChange=async()=>{throw new Error('Synthetic quota failure');};
    let failed=false;try{await remove(branch);}catch{failed=true;}
    assert(failed && tree.nodes[branch.id]===branch && records.has(branch.id));eq(rows.size,0);eq(closed.length,0);
  }));
  test('restored history keeps nesting and containers without live bindings or opening pages', () => fixture(async ({tree,bkgd,closed,remove,add}) => {
    const parent=await add(tree.root,{label:'Original parent'});
    const before=await add(parent,{label:'Before'}), branch=await add(parent,{label:'Branch'});
    const tab=await add(branch,{url:'https://example.test',loaded:true,tabId:9,windowId:1,cookieStoreId:'firefox-container-9',containerProfileId:'origin'});
    const after=await add(parent,{label:'After'});
    const result=await remove(branch);const count=closed.length;
    const restore=await bkgd.deletionHistory.restore(result.entryId);
    eq(restore.restored,2);eq(restore.fallbackCount,0);eq(parent.nodes.map(n=>n.id).join(','),[before.id,branch.id,after.id].join(','));
    eq(tree.nodes[tab.id].parent.id,branch.id);eq(tree.nodes[tab.id].cookieStoreId,'firefox-container-9');
    assert(!tree.nodes[tab.id].loaded && !tree.nodes[tab.id].tabId);eq(closed.length,count);
    const again=await bkgd.deletionHistory.restore(result.entryId);assert(again.alreadyRestored);eq(parent.nodes.length,3);
  }));
  test('batch deletion records one action and deduplicates nested selected roots', () => fixture(async ({tree,bkgd,rows,item,add}) => {
    const a=await add(tree.root,{label:'A'}), b=await add(a,{label:'B'}), c=await add(tree.root,{label:'C'});
    const result=await bkgd.deletionHistory.delete({entryId:'batch',items:await Promise.all([a,b,c].map(n=>item(n)))});
    eq(result.count,3);eq(rows.size,1);eq(result.deleted.length,2);
    await bkgd.deletionHistory.restore('batch');eq(tree.root.nodes.map(n=>n.label).join(','),'A,C');eq(tree.nodes[b.id].parent.id,a.id);
  }));
  test('node-only deletion recovers only the removed node without stealing promoted children', () => fixture(async ({tree,bkgd,remove,add}) => {
    const node=await add(tree.root,{label:'Parent'}), child=await add(node,{label:'Survivor'});
    const result=await remove(node,'promoteKids');eq(result.count,1);eq(child.parent,tree.root);
    await child.setNotes('Newer child edit','',{reason:'test'});
    await bkgd.deletionHistory.restore(result.entryId);
    eq(child.parent,tree.root);eq(child.label,'Newer child edit');eq(tree.nodes[node.id].nodes.length,0);
  }));
  test('missing parent and native group restore into saved recovery structure', () => fixture(async ({tree,bkgd,remove,add}) => {
    const group=await add(tree.root,{label:'Research',nativeGroup:true,groupTitle:'Research',groupColor:'green',groupId:88});
    const parent=await add(group,{label:'Gone'}), tab=await add(parent,{url:'https://example.test',cookieStoreId:'firefox-container-7',containerProfileId:'scope'});
    const result=await remove(tab);await remove(group);
    const restored=await bkgd.deletionHistory.restore(result.entryId);eq(restored.fallbackCount,1);
    eq(tree.nodes[tab.id].getNativeGroupNode().label,'Research');assert(!tree.nodes[tab.id].getNativeGroupNode().groupId);
    eq(tree.nodes[tab.id].getNativeGroupNode().parent.label,'Recovered deletions');
  }));
  test('restoration allocates new identities on collision and never overwrites newer nodes', () => fixture(async ({tree,bkgd,remove,add}) => {
    const node=await add(tree.root,{label:'Old'});const result=await remove(node);
    const replacement=await add(tree.root,{id:node.id,label:'Newer'});
    const restored=await bkgd.deletionHistory.restore(result.entryId);eq(replacement.label,'Newer');
    assert(restored.rootIds[0]!==node.id);eq(tree.nodes[restored.rootIds[0]].label,'Old');
  }));
  test('stale confirmation rejects note and structural changes, but not volatile title updates', () => fixture(async ({tree,bkgd,item,add}) => {
    const node=await add(tree.root,{label:'Original',title:'Page 1'}), first=await item(node);
    await add(node,{note:'New child'});
    let failed=false;try{await bkgd.deletionHistory.delete({entryId:'stale',items:[first]});}catch{failed=true;}
    assert(failed && tree.nodes[node.id]);
    const fresh=await item(node); node.title='Page 2';node.atime++;
    await bkgd.deletionHistory.delete({entryId:'fresh',items:[fresh]});assert(!tree.nodes[node.id]);
  }));
  test('private deletions require confirmation and retain no private browsing copy', () => fixture(async ({tree,bkgd,rows,item,add}) => {
    const node=await add(tree.root,{url:'https://private.example.test',incognito:true,note:'Private'});
    const request={entryId:'private-action',items:[await item(node)]};
    const first=await bkgd.deletionHistory.delete(request);assert(first.requiresPrivateConfirmation && tree.nodes[node.id]);
    const result=await bkgd.deletionHistory.delete({...request,privateConfirmed:true});assert(result.privateDeletion);
    assert(!JSON.stringify([...rows]).includes('private.example') && !JSON.stringify([...rows]).includes('Private'));
    const retry=await bkgd.deletionHistory.delete({...request,privateConfirmed:true});assert(retry.alreadyApplied);
  }));
  test('failed restore leaves the deletion entry and original outline intact', () => fixture(async ({tree,bkgd,rows,remove,add}) => {
    const node=await add(tree.root,{label:'Keep recoverable'});const result=await remove(node);
    tree.db.commitHistoryChange=async()=>{throw new Error('Synthetic write failure');};
    let failed=false;try{await bkgd.deletionHistory.restore(result.entryId);}catch{failed=true;}
    assert(failed && !tree.nodes[node.id] && rows.get(result.entryId).status==='deleted');
  }));

  test('out-of-order batch selections restore siblings in their original order', () => fixture(async ({tree,bkgd,item,add}) => {
    const nodes=[];for(const label of ['A','B','C','D','E','F'])nodes.push(await add(tree.root,{label}));
    await bkgd.deletionHistory.delete({entryId:'reverse-batch',items:await Promise.all([4,1,3,2,0].map(i=>item(nodes[i])))});
    await bkgd.deletionHistory.restore('reverse-batch');eq(tree.root.nodes.map(n=>n.label).join(''),'ABCDEF');
  }));
  test('restoration reuses a surviving group without leaving an unused recovery folder', () => fixture(async ({tree,bkgd,remove,add}) => {
    const group=await add(tree.root,{label:'Group',nativeGroup:true});
    const parent=await add(group,{label:'Parent'}), tab=await add(parent,{url:'https://example.test'});
    const first=await remove(tab);await remove(parent);
    await bkgd.deletionHistory.restore(first.entryId);
    eq(tree.nodes[tab.id].parent,group);eq(tree.root.nodes.length,1);
  }));
  test('delayed callbacks wait for history publication and cannot revive a removed parent', () => fixture(async ({tree,bkgd,remove,add}) => {
    const parent=await add(tree.root,{label:'Deleted parent'});
    const write=tree.db.commitHistoryChange;
    let entered,release;const started=new Promise(r=>{entered=r;});const blocked=new Promise(r=>{release=r;});
    tree.db.commitHistoryChange=async value=>{entered();await blocked;return write(value);};
    const deletion=remove(parent);await started;
    const late=parent.addChild(0,{label:'Late orphan'},{reason:'test'});
    await Promise.resolve();assert(parent.nodes.length===0);
    release();await deletion;eq(await late,false);
    assert(!Object.values(tree.nodes).some(node=>node.label==='Late orphan'));
  }));

  test('pruned receipts cannot let a stale deletion request delete its restored nodes again', () => fixture(async ({tree,bkgd,item,add}) => {
    const node=await add(tree.root,{label:'Recovered generation'});
    const request={entryId:'original-delete',items:[await item(node)]};
    await bkgd.deletionHistory.delete(request);await bkgd.deletionHistory.restore(request.entryId);
    await tree.db.commitHistoryChange({purge:[request.entryId]});
    let failed=false;try{await bkgd.deletionHistory.delete(request);}catch{failed=true;}
    assert(failed && tree.nodes[node.id]);eq(tree.nodes[node.id].recoveryId,request.entryId);
  }));

}
