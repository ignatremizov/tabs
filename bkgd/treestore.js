// bkgd/treestore.js: TreeStore class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import { debug, log, warn, error } from '/common/common.js';
import { NodeStore } from './nodestore.js';
import { Tree } from '/common/tree.js';
import { IDB } from '/bkgd/idb.js';


export class TreeStore extends Tree {

  constructor (bkgd) {
    super(NodeStore);
    this.bkgd = bkgd;
    this.needsTutorial = false;
    this.db = new IDB();
    this.db.init();
  }

  async init () {
    super.init();
    // load the nodes from storage
    await this.loadTreeFromDB();
  }

  async loadTreeFromDB () {
    this.createRootNode();

    // try to load the root node by itself
    // if it doesn't exist in the DB, then save the root node
    // (to make sure root is the first node in the DB)
    const saved = await this.db.loadNode(this.root.id);
    if (! saved) {
      log(`TreeStore.createRootNode couldn't load root, fresh install?`);
      await this.db.saveNode(this.root);
      this.needsTutorial = true;
    }

    let nodeIds;

    // TODO: load latest snapshot if it's clean
    //const dirty = await api.storage.local.get(
    //  { isLatestSnapshotDirty: true });
    //if (! dirty) {
    //  console.time('db.loadCurrentSnapshot');
    //  nodeIds = await this.db.loadSnapshot('local');
    //  console.timeEnd('db.loadCurrentSnapshot');
    //} else
    {
      // load the slow way, one node at a time
      console.time('db.loadAllNodes');
      nodeIds = await this.db.loadAllNodes();
      console.timeEnd('db.loadAllNodes');
    }

    const numIds = Object.keys(nodeIds).length;
    debug(`loaded ${numIds} nodes`);
    if (! nodeIds['root'])
      return error(`loadTreeFromDB(): no root node in DB`);

    // restore session from serialized data
    console.time('TreeStore.rebuildNodeFromSerializedHash');
    const numLoaded = this.rebuildNodeFromSerializedHash(
      this.root, nodeIds);
    console.timeEnd('TreeStore.rebuildNodeFromSerializedHash');
    log(`loadTreeFromDB(): loaded ${numLoaded}/${numIds} nodes`);

    // if there's stale data in the DB
    // (happens sometimes during development)
    // re-attach all orphaned nodes
    if (numLoaded !== numIds) {
      await this.reattachOrphanedNodes(nodeIds);
    }
  }

  async reattachOrphanedNodes (nodeIds) {
    const newParentName = 'lost+found';
    let numToReattach = 1;  // start with 1 for the lost+found node

    // first, find or create a 'lost+found/' node to hold others
    let lostFound;
    for (const node of this.root.nodes) {
      if (newParentName === node.label) {
        lostFound = node;
        break;
      }
    }
    if (! lostFound) {
      log(`fsck: making new ${newParentName} node`);
      lostFound = await this.root.addChild(this.root.nodes.length,
        { label: newParentName, note: 'orphaned nodes found during fsck' },
        { reason: 'reattachOrphanedNodes' });
    }
    const lfDict = lostFound.toDict();
    const modifiedNodes = [lostFound.id];

    // warn about nodes not attached to the tree
    // and list some human-readable info about them
    for (const nodeId of Object.keys(nodeIds)) {
      let n = nodeIds[nodeId];
      if (undefined === this.nodes[nodeId]) {
        numToReattach ++;
        let summary = `${n.label} ~ ${n.title} [${n.url}]`;
        log(`fsck: detached node: ${summary}`, n);
      }
    }

    // second, attach orphans to lost+found
    // (entire branches may have been detached, and attaching the top-most
    //  node of each detached branch should recover the whole thing)
    for (const nodeId of Object.keys(nodeIds)) {
      const parentId = nodeIds[nodeId].parent;
      const n = nodeIds[nodeId];
      const p = nodeIds[parentId];
      // attach to lost+found if:
      // - parent ID not in the database
      // - node is its own parent
      // - parent doesn't recognize child
      if ((undefined === p)  // parent ID not in database
        || ((parentId === nodeId) && ('root' !== nodeId))  // is own parent
        || (! p.nodes.includes(nodeId))  // parent doesn't expect this child
      ) {
        log('fsck: attaching orphan to lost+found:', nodeIds[nodeId]);
        nodeIds[nodeId].parent = lostFound.id;
        nodeIds[nodeId].loaded = false;
        nodeIds[nodeId].wasLoaded = false;
        lfDict.nodes.push(nodeId);
        modifiedNodes.push(nodeId);
      }
    }

    // actually attach the orphaned nodes now
    nodeIds[lostFound.id] = lfDict;
    const numAttached = this.rebuildNodeFromSerializedHash(lostFound, nodeIds);

    // write changes to database
    for (const nodeId of modifiedNodes) {
      const node = this.nodes[nodeId];
      await this.db.saveNode(node);
    }

    // summary
    warn(`fsck: reattachOrphanedNodes() attached ${numAttached} orphans under ${newParentName}`);
    if (numToReattach !== numAttached) {
      warn(`fsck: attached ${numAttached} nodes but expected ${numToReattach}`);
    }
  }

  async tree_nodeChanged (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    if (msg.type === 'load') {
      const actionReason = msg.actionReason || 'tree_nodeChanged';
      return this.bkgd.enqueueIntent('ensureLoaded', {
        nodeId: msg.nodeId,
        reason: actionReason,
        when: msg.when
      }, 'view');
    }
    if (msg.type === 'unload') {
      const actionReason = msg.actionReason || 'tree_nodeChanged';
      const payload = {
        nodeId: msg.nodeId,
        reason: actionReason,
        when: msg.when,
        wasLoaded: msg.wasLoaded
      };
      if (undefined !== msg.keepTabsOnClose) {
        payload.keepTabsOnClose = msg.keepTabsOnClose;
      }
      return this.bkgd.enqueueIntent('ensureUnloaded', {
        ...payload
      }, 'view');
    }

    return super.tree_nodeChanged(msg, sender, sendResponse);
  }

  async tree_nodeDeleted (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const actionReason = msg.actionReason || 'tree_nodeDeleted';
    return this.bkgd.enqueueIntent('ensureDeleted', {
      nodeId: msg.nodeId,
      reason: actionReason,
      when: msg.when
    }, 'view');
  }

  async tree_nodeMoved (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const actionReason = msg.actionReason || 'tree_nodeMoved';
    return this.bkgd.enqueueIntent('ensureMoved', {
      nodeId: msg.nodeId,
      destParentId: msg.destParentId,
      destIndex: msg.destIndex,
      openWindowOnRootMove: msg.openWindowOnRootMove,
      prevParentId: msg.prevParentId,
      reason: actionReason,
      when: msg.when
    }, 'view');
  }

  async applyMoveForIntent (node, destParent, destIndex, msg, op = null) {
    // if moving to root, optionally wrap in a new window
    if (destParent.isRoot() && (! node.isWindow()) && (! node.parent.isRoot())) {
      let shouldOpenWindow = false;
      if (msg.openWindowOnRootMove === true) {
        shouldOpenWindow = true;
      } else {
        const config = await api.storage.local.get({
          openWindowOnRootMove: false
        });
        shouldOpenWindow = config.openWindowOnRootMove;
      }
      const openTabs = (
        node.tabId
        || node.findNodes(
          (n) => (n.tabId && (! n.isWindow())),
          (n) => (! n.isWindow())
        ).length > 0
      );
      let isWholeWindowContent = false;
      const windowNode = node.getWindowNode(false);
      if (windowNode && windowNode.nodes.length === 1
        && windowNode.nodes[0] === node) {
        isWholeWindowContent = true;
      }
      if (shouldOpenWindow && openTabs && (! isWholeWindowContent)) {
        if (op && op.cursor && op.cursor.windowNodeId) {
          const existingWindow = this.nodes[op.cursor.windowNodeId];
          if (existingWindow) {
            if (node.parent !== existingWindow) {
              await node.moveTo(existingWindow, 0, { reason: 'userAction' });
            }
            if (! existingWindow.isLoaded()) {
              await this.bkgd.bkgd_loadSavedWindow({
                windowNodeId: existingWindow.id,
                nodeId: node.id
              });
            }
            return true;
          }
        }
        if (node.parent && node.parent.isWindow()
          && node.parent.parent && node.parent.parent.isRoot()) {
          if (op && this.bkgd.opsQueue) {
            await this.bkgd.opsQueue.updateCursor(op.opId, {
              windowNodeId: node.parent.id
            });
          }
          return true;
        }
        const newWindowNode = await this.root.addChild(destIndex,
          { type: 'window' },
          { reason: 'userAction' });
        if (op && this.bkgd.opsQueue) {
          await this.bkgd.opsQueue.updateCursor(op.opId, {
            windowNodeId: newWindowNode.id
          });
        }
        await node.moveTo(newWindowNode, 0, { reason: 'userAction' });
        await this.bkgd.bkgd_loadSavedWindow({
          windowNodeId: newWindowNode.id,
          nodeId: node.id
        });
        return true;
      }
    }

    // fall back to default behavior
    const moveMsg = { ...msg };
    moveMsg.reason = moveMsg.reason || 'tree_nodeMoved';
    const moved = await node.moveTo(destParent, destIndex, moveMsg);

    // clean up empty, boring window nodes after moving their last child out
    if (moveMsg.prevParentId) {
      const prevParent = this.nodes[moveMsg.prevParentId];
      if (prevParent && prevParent.isWindow()
        && (prevParent.nodes.length === 0)
        && (! prevParent.shouldUnloadNotDelete())
        && (! prevParent.isLoaded())
        && (! prevParent.hasLoadedTabs())) {
        await prevParent.deleteSelf({ reason: 'userAction' });
      }
    }

    return moved;
  }

  async onTabRemoved (tabId, removeInfo) {
    const tabNode = this.getNodeByTabId(tabId);
    if (! tabNode) return;
    if ('unload' === tabNode.tabClosedReason) {
      tabNode.tabClosedReason = undefined;
      return this.bkgd.enqueueIntent('ensureUnloaded', {
        nodeId: tabNode.id,
        reason: 'onTabRemoved',
        detail: 'manualUnload'
      }, 'browserEvent');
    }
    let isWindowClosing = removeInfo && removeInfo.isWindowClosing;
    const windowNode = tabNode.getWindowNode();
    if (! isWindowClosing && windowNode && this.windowsClosing) {
      if (this.windowsClosing.has(windowNode.windowId)) {
        isWindowClosing = true;
        this.windowsClosing.delete(windowNode.windowId);
      }
    }
    if (isWindowClosing && windowNode && windowNode.keepTabsOnClose) {
      return this.bkgd.enqueueIntent('ensureUnloaded', {
        nodeId: tabNode.id,
        reason: 'onWindowRemoved'
      }, 'browserEvent');
    }

    if (isWindowClosing && windowNode) {
      const tabIsBoringLeaf = (! tabNode.shouldUnloadNotDelete())
        && (! tabNode.hasKids());
      const isOnlyWindowChild = (1 === windowNode.nodes.length)
        && (windowNode.nodes[0] === tabNode);
      if (tabIsBoringLeaf && isOnlyWindowChild) {
        await this.bkgd.enqueueIntent('ensureDeleted', {
          nodeId: tabNode.id,
          reason: 'onTabRemoved'
        }, 'browserEvent');
        if (windowNode.shouldUnloadNotDelete()) {
          await this.bkgd.enqueueIntent('ensureUnloaded', {
            nodeId: windowNode.id,
            reason: 'onWindowRemoved'
          }, 'browserEvent');
        } else {
          await this.bkgd.enqueueIntent('ensureDeleted', {
            nodeId: windowNode.id,
            reason: 'onTabRemoved'
          }, 'browserEvent');
        }
        return;
      }
    }
    if (isWindowClosing) {
      return this.bkgd.enqueueIntent('ensureUnloaded', {
        nodeId: tabNode.id,
        reason: 'onWindowRemoved'
      }, 'browserEvent');
    }
    if (tabNode.shouldUnloadNotDelete()) {
      return this.bkgd.enqueueIntent('ensureUnloaded', {
        nodeId: tabNode.id,
        reason: 'onTabRemoved'
      }, 'browserEvent');
    }
    if (tabNode.hasKids()) {
      return this.bkgd.enqueueIntent('ensureDeleted', {
        nodeId: tabNode.id,
        reason: 'onTabRemoved',
        mode: 'promoteKids'
      }, 'browserEvent');
    }
    return this.bkgd.enqueueIntent('ensureDeleted', {
      nodeId: tabNode.id,
      reason: 'onTabRemoved'
    }, 'browserEvent');
  }

  async onTabMoved (tabId, moveInfo) {
    const windowNode = this.root.getWindowId(moveInfo.windowId);
    if (! windowNode) {
      return error(`Tree.onTabMoved() can't find windowId="${moveInfo.windowId}"`);
    }
    const tabNode = this.getNodeByTabId(tabId);
    if (! tabNode) {
      return error(`Tree.onTabMoved() can't find tabId="${tabId}"`);
    }
    debug(`Tree.onTabMoved(): ${tabNode.toLine()}`);
    async function enqueueMove(destParent, destIndex) {
      return await this.bkgd.enqueueIntent('ensureMoved', {
        nodeId: tabNode.id,
        destParentId: destParent.id,
        destIndex: destIndex,
        reason: 'onTabMoved',
        prevParentId: tabNode.parent ? tabNode.parent.id : null
      }, 'browserEvent');
    }
    const tabList = windowNode.getLoadedTabs();
    if (tabList.length < 1) {
      debug('Tree.onTabMoved(): new window?', moveInfo.fromIndex, moveInfo.toIndex);
      return await enqueueMove.call(this, windowNode, 0);
    }
    if (moveInfo.toIndex >= tabList.length) {
      const prevNode = tabList[moveInfo.toIndex - 1];
      const destParent = prevNode.parent;
      const destIndex = prevNode.indexOf() + 1;
      debug('Tree.onTabMoved(): past end of window', moveInfo.fromIndex, moveInfo.toIndex);
      return await enqueueMove.call(this, destParent, destIndex);
    }
    if (tabNode === tabList[moveInfo.toIndex]) {
      debug('Tree.onTabMoved(): tab already at correct index', moveInfo.fromIndex, moveInfo.toIndex);
      return;
    }
    if (moveInfo.toIndex < moveInfo.fromIndex) {
      const prevNode = tabList[moveInfo.toIndex];
      const destParent = prevNode.parent;
      const destIndex = prevNode.indexOf();
      debug('Tree.onTabMoved(): moving left', moveInfo.fromIndex, moveInfo.toIndex);
      return await enqueueMove.call(this, destParent, destIndex);
    }
    const nextNode = tabList[moveInfo.toIndex + 1];
    if (nextNode) {
      const destParent = nextNode.parent;
      const destIndex = nextNode.indexOf();
      debug('Tree.onTabMoved(): moving right', moveInfo.fromIndex, moveInfo.toIndex);
      return await enqueueMove.call(this, destParent, destIndex);
    }
    const lastNode = tabList[tabList.length - 1];
    const destParent = lastNode.parent;
    const destIndex = lastNode.indexOf() + 1;
    debug('Tree.onTabMoved(): right-most tab', moveInfo.fromIndex, moveInfo.toIndex);
    return await enqueueMove.call(this, destParent, destIndex);
  }

  async onTabAttached (tabId, attachInfo) {
    const newIndex = attachInfo.newPosition;
    const windowId = attachInfo.newWindowId;
    debug(`Tree.onTabAttached(${tabId}) -> ${windowId}, ${newIndex}`);

    const tabNode = this.getNodeByTabId(tabId);
    if (! tabNode) return warn(`Tree.onTabAttached(${tabId}): no tab found`);

    let windowNode;
    const found = this.root.findNodes((node) =>
      { return node.isWindow() && (node.windowId === windowId); });
    if (found.length > 0) { windowNode = found[0]; }
    else if (this.bkgd.windowsLoading.length > 0) {
      windowNode = this.bkgd.windowsLoading[0];
      windowNode.windowId = windowId;
    }
    else {
      const destParent = this.root;
      const destIndex = destParent.nodes.length;
      windowNode = await destParent.addChild(destIndex, {
        type: 'window',
        windowId: windowId
      }, { reason: 'onTabAttached' });
      debug('Tree.onTabAttached(new window)');
    }

    const tabList = windowNode.getLoadedTabs();
    let destParent;
    let destIndex;
    let skip = false;
    if (tabNode === tabList[newIndex]) {
      debug('Tree.onTabAttached(): already correct:', tabNode.toLine());
      skip = true;
    }
    else if (0 === tabList.length) {
      destParent = windowNode;
      destIndex = 0;
    }
    else if (newIndex >= tabList.length) {
      const lastNode = tabList[tabList.length - 1];
      destParent = lastNode.parent;
      destIndex = lastNode.indexOf() + 1;
    }
    else {
      const nextNode = tabList[newIndex];
      destParent = nextNode.parent;
      destIndex = nextNode.indexOf();
    }
    if (! skip) {
      debug('Tree.onTabAttached(): moving', tabNode.toLine(), destParent.toLine(), destIndex);
      await this.bkgd.enqueueIntent('ensureMoved', {
        nodeId: tabNode.id,
        destParentId: destParent.id,
        destIndex: destIndex,
        reason: 'onTabAttached',
        prevParentId: tabNode.parent ? tabNode.parent.id : null
      }, 'browserEvent');
    }

    debug(`onTabAttached(): active tab: auto`);
    await windowNode.setActiveTab({ reason: 'onTabAttached' });
  }
}
