// bkgd/treestore.js: TreeStore class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';

import { debug, log, warn, error } from '/common/common.js';
import { NodeStore } from './nodestore.js';
import { Tree } from '/common/tree.js';
import { IDB } from '/bkgd/idb.js';


export class TreeStore extends Tree {

  constructor (bkgd) {
    super(NodeStore);
    this.bkgd = bkgd;
    this.needsTutorial = false;
    this.tabNodeSessionKey = 'tktstoTabNodeId';
    this.windowNodeSessionKey = 'tktstoWindowNodeId';
    this.db = new IDB();
    this.db.init();
  }

  async init () {
    await super.init();
    // load the nodes from storage
    await this.loadTreeFromDB();
  }

  async runPersistenceBatch (mutator, args) {
    return await this.root.withPersistenceBatch(
      (operationArgs) => mutator(operationArgs),
      args
    );
  }

  async persistNodes (nodes, deleteNodeIds = []) {
    return await this.root.persistWithLock(nodes, deleteNodeIds);
  }

  async getSessionNode (browserId, key, expectedType) {
    const getter = expectedType === 'window'
      ? api.sessions && api.sessions.getWindowValue
      : api.sessions && api.sessions.getTabValue;
    if (! getter || (undefined === browserId) || (null === browserId)) {
      return null;
    }

    let nodeId;
    try {
      nodeId = await getter.call(api.sessions, browserId, key);
    } catch (err) {
      debug(`TreeStore.getSessionNode(${browserId}) failed: ${err}`);
      return null;
    }
    const node = this.nodes[nodeId];
    if (! node) return null;
    if (expectedType === 'window') return node.isWindow() ? node : null;
    return node.isWindow() ? null : node;
  }

  async getTabNodeFromSession (tabId) {
    return await this.getSessionNode(
      tabId,
      this.tabNodeSessionKey,
      'tab'
    );
  }

  async getWindowNodeFromSession (windowId) {
    return await this.getSessionNode(
      windowId,
      this.windowNodeSessionKey,
      'window'
    );
  }

  async rememberTabNode (node, tabId = node && node.tabId) {
    if (! node || node.isWindow() || (! api.sessions)
      || (! api.sessions.setTabValue)
      || (undefined === tabId) || (null === tabId)) {
      return;
    }
    try {
      await api.sessions.setTabValue(
        tabId,
        this.tabNodeSessionKey,
        node.id
      );
    } catch (err) {
      debug(`TreeStore.rememberTabNode(${tabId}) failed: ${err}`);
    }
  }

  async rememberWindowNode (node, windowId = node && node.windowId) {
    if (! node || (! node.isWindow()) || (! api.sessions)
      || (! api.sessions.setWindowValue)
      || (undefined === windowId) || (null === windowId)) {
      return;
    }
    try {
      await api.sessions.setWindowValue(
        windowId,
        this.windowNodeSessionKey,
        node.id
      );
    } catch (err) {
      debug(`TreeStore.rememberWindowNode(${windowId}) failed: ${err}`);
    }
  }

  async onWindowCreated (window, args = {}) {
    const savedWindowNode = await this.getWindowNodeFromSession(window.id);
    let alreadyOpen = false;
    if (savedWindowNode
      && (undefined !== savedWindowNode.windowId)
      && (null !== savedWindowNode.windowId)
      && (savedWindowNode.windowId !== window.id)) {
      const boundNode = await this.getWindowNodeFromSession(
        savedWindowNode.windowId
      );
      alreadyOpen = boundNode === savedWindowNode;
    }
    if (savedWindowNode && (! alreadyOpen)) {
      debug(`TreeStore.onWindowCreated(): restoring nodeId=${savedWindowNode.id}`);
      let attached = false;
      try {
        await savedWindowNode.setTabFields({
          type: 'window',
          windowId: window.id,
          loaded: true,
          geometry: [window.width, window.height, window.left, window.top]
        }, { reason: args.reason || 'onWindowCreated' });
        await this.rememberWindowNode(savedWindowNode, window.id);
        attached = true;
        return savedWindowNode;
      } finally {
        this.finishPendingWindowLoad(savedWindowNode, attached);
      }
    }

    const windowNode = await super.onWindowCreated(window, args);
    await this.rememberWindowNode(windowNode, window.id);
    return windowNode;
  }

  async onTabCreated (tab) {
    const candidate = await this.getTabNodeFromSession(tab.id);
    const savedTabNode = candidate && this.browserTabContextMatches(candidate, tab, true)
      ? candidate : null;
    if (savedTabNode) {
      // A duplicated live tab may inherit session values.  Only reclaim the
      // saved node when its previous binding does not still identify a live
      // tab carrying the same node ID.
      let alreadyOpen = false;
      if ((undefined !== savedTabNode.tabId)
        && (null !== savedTabNode.tabId)
        && (savedTabNode.tabId !== tab.id)) {
        const boundNode = await this.getTabNodeFromSession(savedTabNode.tabId);
        alreadyOpen = boundNode === savedTabNode;
      }

      if (! alreadyOpen) {
        debug(`TreeStore.onTabCreated(): restoring nodeId=${savedTabNode.id}`);
        try {
          const savedWindowNode = savedTabNode.getWindowNode(false);
          let windowNode = this.root.getWindowId(tab.windowId);
          if (! windowNode && savedWindowNode) {
            await savedWindowNode.setTabFields({
              type: 'window',
              windowId: tab.windowId,
              loaded: true
            }, { reason: 'onWindowCreated' });
            windowNode = savedWindowNode;
            await this.rememberWindowNode(windowNode, tab.windowId);
          }

          const preserveSavedPinned = savedTabNode.isPinned() && (! tab.pinned);
          if (preserveSavedPinned) {
            savedTabNode.pinRestorePending = true;
            savedTabNode.pinRestorePendingAt = Date.now();
          } else if (tab.pinned) {
            savedTabNode.pinRestorePending = false;
            savedTabNode.pinRestorePendingAt = 0;
          }

          await savedTabNode.setTabFields({
            ...(this.bkgd?.containers?.fieldsForTab(tab) || {}),
            tabId: tab.id,
            windowId: tab.windowId,
            loaded: true,
            discarded: tab.discarded,
            frozen: tab.frozen,
            hidden: tab.hidden,
            incognito: tab.incognito,
            pinned: Boolean(tab.pinned || savedTabNode.isPinned())
          }, { reason: 'onTabCreated' });

          if (windowNode && savedWindowNode
            && (windowNode !== savedWindowNode)) {
            const dest = await this.getBrowserEventTabDestination(
              savedTabNode,
              windowNode,
              tab.index,
              Boolean(tab.pinned)
            );
            await savedTabNode.moveTo(dest.destParent, dest.destIndex, {
              reason: 'onTabAttached',
              emit: false,
              skipTabReorder: true
            });
          }

          await this.rememberTabNode(savedTabNode, tab.id);
          await this.bkgd?.tabGroups?.restoreTab(savedTabNode, tab);
          if (this.bkgd?.tabGroups?.supported) {
            // Native session restore may attach the tabs before assigning
            // their new group IDs. Observe the settled burst, not each interim
            // ungrouped tab, or the saved member hierarchy would be promoted.
            this.bkgd.tabGroups.requestSync();
          }
          return savedTabNode;
        } finally {
          savedTabNode.browserLoadInProgress = false;
        }
      }
    }

    await super.onTabCreated(tab);
    const tabNode = this.getNodeByTabId(tab.id);
    await this.rememberTabNode(tabNode, tab.id);
    return tabNode;
  }

  async loadTreeFromDB () {
    this.createRootNode();

    // try to load the root node by itself
    // if it doesn't exist in the DB, then save the root node
    // (to make sure root is the first node in the DB)
    const saved = await this.db.loadNode(this.root.id);
    if (! saved) {
      log(`TreeStore.createRootNode couldn't load root, fresh install?`);
      await this.persistNodes([this.root]);
      this.needsTutorial = true;
    }

    // Load the authoritative per-node records.
    const loadAllStartedAt = Date.now();
    const nodeIds = await this.db.loadAllNodes();
    debug(`db.loadAllNodes: ${Date.now() - loadAllStartedAt}ms`);

    const numIds = Object.keys(nodeIds).length;
    debug(`loaded ${numIds} nodes`);
    if (! nodeIds['root'])
      return error(`loadTreeFromDB(): no root node in DB`);

    // restore session from serialized data
    const rebuildStartedAt = Date.now();
    const numLoaded = this.rebuildNodeFromSerializedHash(
      this.root, nodeIds);
    debug(
      `TreeStore.rebuildNodeFromSerializedHash: `
      + `${Date.now() - rebuildStartedAt}ms`
    );
    log(`loadTreeFromDB(): loaded ${numLoaded}/${numIds} nodes`);

    // if there's stale data in the DB
    // (happens sometimes during development)
    // re-attach all orphaned nodes
    if (numLoaded !== numIds) {
      await this.reattachOrphanedNodes(nodeIds);
    }

    // look for empty boring windows and delete them
    // (because Firefox, for some reason, keeps accumulating these)
    const boringEmptyWinNodes = this.root.findNodes(
      (n) => (n.isWindow()
        && (! n.hasKids())
        && (! n.shouldUnloadNotDelete())),
      (n) => true,
    );
    for (const toDelete of boringEmptyWinNodes) {
      debug(`delete boringEmptyWinNodes: ${toDelete.toLine()}`, toDelete);
      await toDelete.deleteSelf({ reason: 'emptyWindowClosed' });
    }
    // TODO: if lost+found exists with nothing inside, delete it too?
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
      lostFound = await this.root.addChild(
        //this.root.nodes.length,  // attach as last child
        0,  // attach as first child
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
      if ('root' === nodeId) continue; // root can't be orphaned

      const n = nodeIds[nodeId];
      const parentId = n.parent;
      const p = nodeIds[parentId];
      // attach to lost+found if:
      // - parent ID not in the database
      // - node is its own parent
      // - parent doesn't recognize child
      if ((undefined === p)  // parent ID not in database
        || (parentId === nodeId)  // is own parent
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
    const nodesToSave = modifiedNodes
      .map((nodeId) => this.nodes[nodeId])
      .filter(Boolean);
    await this.persistNodes(nodesToSave);

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
      const payload = {
        nodeId: msg.nodeId,
        reason: actionReason,
        when: msg.when
      };
      await this.bkgd.applyTreeMutation('ensureLoaded', payload);
      return { result: 'ok immediate' };
    }
    if (msg.type === 'unload') {
      const actionReason = msg.actionReason || 'tree_nodeChanged';
      const payload = {
        nodeId: msg.nodeId,
        reason: actionReason,
        when: msg.when,
        wasLoaded: msg.wasLoaded
      };
      if (undefined !== msg.tabId) payload.tabId = msg.tabId;
      if (undefined !== msg.windowId) payload.windowId = msg.windowId;
      if (undefined !== msg.keepTabsOnClose) {
        payload.keepTabsOnClose = msg.keepTabsOnClose;
      }
      await this.bkgd.applyTreeMutation('ensureUnloaded', payload);
      return { result: 'ok immediate' };
    }

    return super.tree_nodeChanged(msg, sender, sendResponse);
  }

  async tree_nodeDeleted (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const actionReason = msg.actionReason || 'tree_nodeDeleted';
    const payload = {
      nodeId: msg.nodeId,
      reason: actionReason,
      when: msg.when
    };
    if (undefined !== msg.mode) payload.mode = msg.mode;
    await this.bkgd.applyTreeMutation('ensureDeleted', payload);
    return { result: 'ok immediate' };
  }

  async tree_nodeMoved (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const actionReason = msg.actionReason || 'tree_nodeMoved';
    const payload = {
      nodeId: msg.nodeId,
      destParentId: msg.destParentId,
      destIndex: msg.destIndex,
      openWindowOnRootMove: msg.openWindowOnRootMove,
      prevParentId: msg.prevParentId,
      reason: actionReason,
      when: msg.when
    };
    if (msg.moveNodeOnly) payload.moveNodeOnly = true;
    if (msg.nodeOnlyDestAdjusted) payload.nodeOnlyDestAdjusted = true;
    await this.bkgd.applyTreeMutation('ensureMoved', payload);
    return { result: 'ok immediate' };
  }

  async applyMove (node, destParent, destIndex, msg) {
    return await this.runPersistenceBatch(
      (operationArgs) => this.applyMoveInBatch(
        node,
        destParent,
        destIndex,
        operationArgs
      ),
      msg
    );
  }

  async applyMoveInBatch (node, destParent, destIndex, msg) {
    const userActionArgs = { ...msg, reason: 'userAction' };
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
        || (node.isLoaded && node.isLoaded())
        || (node.hasLoadedTabsDeep && node.hasLoadedTabsDeep())
      );
      if ((msg.openWindowOnRootMove === true) && openTabs) {
        shouldOpenWindow = true;
      }
      const wantsWindow = openTabs;
      let isWholeWindowContent = false;
      const windowNode = node.getWindowNode(false);
      if (windowNode && windowNode.nodes.length === 1
        && windowNode.nodes[0] === node) {
        isWholeWindowContent = true;
      }
      if (shouldOpenWindow && wantsWindow && isWholeWindowContent) {
        return true;
      }
      if (shouldOpenWindow && wantsWindow) {
        const newWindowNode = await this.root.addChild(destIndex,
          { type: 'window' },
          userActionArgs);
        await node.moveTo(newWindowNode, 0, userActionArgs);
        return true;
      }
    }

    const moveHasLoadedTabs = (
      node.tabId
      || (node.isLoaded && node.isLoaded())
      || (node.hasLoadedTabsDeep && node.hasLoadedTabsDeep())
    );
    const destWindow = destParent.getWindowNode
      ? destParent.getWindowNode(false)
      : null;
    if (moveHasLoadedTabs && (! node.isWindow()) && (! destWindow)) {
      const windowNode = node.getWindowNode(false);
      if (windowNode && windowNode.nodes.length === 1
        && windowNode.nodes[0] === node) {
        const windowHasId = (
          (undefined !== windowNode.windowId)
          && (null !== windowNode.windowId)
        );
        const hasLoadedDesc = windowNode.hasLoadedTabsDeep
          ? windowNode.hasLoadedTabsDeep()
          : windowNode.hasLoadedTabs();
        const keepWindow = (
          windowNode.shouldUnloadNotDelete()
          || (windowNode.isLoaded() && windowHasId)
          || hasLoadedDesc
        );
        if (keepWindow) {
          await windowNode.moveTo(
            destParent,
            destIndex,
            userActionArgs
          );
          return true;
        }
      }
      const newWindowNode = await destParent.addChild(destIndex,
        { type: 'window' },
        userActionArgs);
      await node.moveTo(newWindowNode, 0, userActionArgs);
      return true;
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
        && (! (prevParent.hasLoadedTabsDeep
          ? prevParent.hasLoadedTabsDeep()
          : prevParent.hasLoadedTabs()))) {
        await prevParent.deleteSelf({
          ...moveMsg,
          reason: 'userAction'
        });
      }
    }

    return moved;
  }

  async unloadNodeForBrowserRemoval (node, args) {
    return await this.bkgd.applyTreeMutation('ensureUnloaded', {
      nodeId: node.id,
      ...args
    });
  }

  async deleteNodeForBrowserRemoval (node, args, promoteKids = false) {
    return await this.bkgd.applyTreeMutation('ensureDeleted', {
      nodeId: node.id,
      ...args,
      mode: promoteKids ? 'promoteKids' : undefined,
      // Unlike a sidebar action, a native browser close has no view which
      // already broadcast the atomic promote-delete operation.
      broadcastResult: promoteKids
    });
  }

  async moveTabNodeForBrowserEvent (
    tabNode,
    destParent,
    destIndex,
    reason,
    details = {}
  ) {
    return await this.bkgd.applyTreeMutation('ensureMoved', {
      nodeId: tabNode.id,
      destParentId: destParent.id,
      destIndex: destIndex,
      reason,
      skipTabReorder: true,
      moveNodeOnly: details.moveNodeOnly,
      browserWindowId: details.browserWindowId
        || (details.windowNode ? details.windowNode.windowId : undefined),
      browserIndex: details.browserIndex,
      pinned: details.pinned,
      prevParentId: tabNode.parent ? tabNode.parent.id : null
    });
  }

}
