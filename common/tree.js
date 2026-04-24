// common/tree.js: Tree class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import * as common from '/common/common.js';
const { log, debug, warn, error, emit, jsonSchema, dateTupleStrings } = common;
import { Node } from '/common/node.js';
import { Mutex } from '/common/mutex.js';


export class Tree {

  constructor (NodeClass) {
    if (undefined === NodeClass) NodeClass = Node;
    this.NodeClass = NodeClass;

    this.treeLoaded = new Promise(resolve => {
      this.resolveTreeLoaded = resolve;
    });

    this.onTabReplacedMutex = new Mutex();

    this.markedNodes = [];
    this.pendingMoves = new Map();
    this.pendingMoveTimeoutMs = 2000;
    this.suppressedTabMoves = new Map();
    this.suppressedTabMoveTimeoutMs = 2000;

    // holds tabIds of "tabs" we need to ignore,
    // like Vivaldi panels
    this.tabBlacklist = {};

    this.reorderTabsOnCreate = true;
    this.windowsClosing = new Set();

    this.createRootNode();

    // fields to copy when serializing Nodes to/from dict
    this.dictable = [
      'id',
      'type',
      'windowId',
      'tabId',
      'geometry',
      'windowState',
      'incognito',
      'label',
      'note',
      'title',
      'url',
      'faviconUrl',
      'expanded',
      'loaded',
      'wasLoaded',
      'active',
      'pinned',
      'marked',
      'checkbox',
      'checkboxPx',
      'ctime',
      'mtime',
      'atime',
      'discarded',
      'frozen',
      'hidden',
    ];

    // TODO: make user-configurable
    this.checkboxTodoType = ' ';
    this.checkboxHalfDoneType = '+';
    this.checkboxDoneType = 'X';
    // map because a plain object gets confused about order
    // when some of the keys look like numbers
    this.checkboxClasses = new Map();
    for (const [key, value] of [
      [' ', 'todo'],
      ['-', 'todo'],
      ['+', 'half-done'],
      ['=', 'half-done'],
      ['%', 'percent'],
      ['X', 'done'],
      ['*', 'done'],
      ['F', 'fail'],
      ['S', 'skip'],
      ['C', 'skip'],
      ['O', 'other'],
      ['!', 'important'],
      ['?', 'unknown'],
      //['0': 'n0'],
      ['1', 'n1'],
      ['2', 'n2'],
      ['3', 'n3'],
      ['4', 'n4'],
      ['5', 'n5'],
      ['6', 'n6'],
      ['7', 'n7'],
      ['8', 'n8'],
      ['9', 'n9'],
    ]) {
      this.checkboxClasses.set(key, value);
    }
  }

  suppressTabMovedEvents (windowId, tabIds) {
    if ((undefined === windowId) || (null === windowId)) return;
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const until = Date.now() + this.suppressedTabMoveTimeoutMs;
    for (const tabId of ids) {
      if ((undefined === tabId) || (null === tabId)) continue;
      this.suppressedTabMoves.set(`${windowId}:${tabId}`, until);
    }
  }

  clearSuppressedTabMovedEvents (windowId, tabIds) {
    if ((undefined === windowId) || (null === windowId)) return;
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    for (const tabId of ids) {
      if ((undefined === tabId) || (null === tabId)) continue;
      this.suppressedTabMoves.delete(`${windowId}:${tabId}`);
    }
  }

  isSuppressedTabMovedEvent (windowId, tabId) {
    const key = `${windowId}:${tabId}`;
    const until = this.suppressedTabMoves.get(key);
    if (! until) return false;
    if (Date.now() > until) {
      this.suppressedTabMoves.delete(key);
      return false;
    }
    this.suppressedTabMoves.delete(key);
    return true;
  }

  destroy () {
  }

  init () {
    // bkgd only: prevent tab reorder storms
    if (this.bkgd) this.tabReorderMutex = new Mutex();

    this.initListeners();

    if (this.bkgd) {
      // TODO: consider per-browser defaults for tab placement behavior.
      api.storage.local.get({ reorderTabsOnCreate: true }).then((result) => {
        this.reorderTabsOnCreate = result.reorderTabsOnCreate;
      });
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.reorderTabsOnCreate) {
          this.reorderTabsOnCreate = changes.reorderTabsOnCreate.newValue;
        }
      });
    }
  }

  initListeners () {
    api.runtime.onMessage.addListener( (msg, sender, sendResponse) => {
      try {
        const result = this.onMessage(msg, sender, sendResponse);
        if (result && ('function' === typeof result.then)) {
          result.catch((err) => {
            error(`Tree.onMessage(${msg && msg.msg ? msg.msg : 'unknown'}) failed`, err, msg);
          });
        }
      } catch (err) {
        error(`Tree.onMessage(${msg && msg.msg ? msg.msg : 'unknown'}) failed`, err, msg);
      }
    });
  }

  createRootNode () {
    // empty Node to hold all others
    if (!this.root)
      this.root = new this.NodeClass(this, null);
    this.root.parent = this.root;
    this.root.id = 'root';
    this.root.nodes = [];
    // cache all nodes by ID
    this.nodes = { 'root': this.root };
  }

  nodeMarkChanged (node) {
    if (node.marked) {
      this.markedNodes.push(node.id);
    }
    else {
      const index = this.markedNodes.indexOf(node.id);
      if (index >= 0) this.markedNodes.splice(index, 1);
    }
  }

  async unmarkAll (args) {
    //debug('Tree.unmarkAll()');
    // iterate over a copy of the array,
    // since the original will be modified while iterating
    for (const nodeId of this.markedNodes.slice()) {
      const node = this.nodes[nodeId];
      //debug(`unmarking "${nodeId}"`);
      await node.setMarked(false, args);
    }
  }

  async loadTreeFromBkgd () {
    // TODO: get entire tree state from bkgd
    //   ... and populate this tree with that data

    // get the raw Tree data
    const response = await emit('bkgd_getTree');
    if (! response)
      return error('Tree.loadTreeFromBkgd() failed, bkgd did not send tree');

    //debug('bkgd_getTree() =>', response);
    // TODO: delete anything which needs deleting before restoring
    // (like removing DOM elements in Views)
    // (maybe call derived class handler?)

    // restore session from serialized data
    this.createRootNode();
    const numLoaded = this.rebuildNodeFromSerializedHash(
      this.root, response.nodes);
    // tree is ready to use
    debug('Tree.resolveTreeLoaded()');
    this.resolveTreeLoaded();  // let listeners know the tree is loaded
    log(`loadTreeFromBkgd(): loaded ${numLoaded} nodes`);
  }

  serializeNodes (forBackup = false) {
    const result = {};
    let defaultNode;
    if (forBackup) defaultNode = new Node();

    for (const key in this.nodes) {
      //debug('serializeNodes:', key, this.nodes[key]);
      const node = this.nodes[key].toDict();
      if (forBackup) {  // clean up the data before exporting
        for (const [k,v] of Object.entries(node)) {
          // get rid of attributes with no value
          // (redundant, removing unchanged/default does this too)
          //if ((null === v) || ('' === v))
          //  delete node[k];
          // remove data which shouldn't persist
          if (['tabId', 'oldTabId', 'windowId', 'marked'].includes(k))
            delete node[k];
          // remove values which haven't changed from default
          if (defaultNode[k] === node[k])
            delete node[k];
          // remove empty nodes from leaf
          if (('nodes' === k) && (0 === node[k].length))
            delete node[k];
        }
      }
      result[key] = node;
    }
    return result;
  }

  rebuildNodeFromSerializedHash (node, hash) {
    //debug('rebuildNodeFromSerializedHash()', node, hash);
    let numLoaded = 0;
    const nodeDict = hash[node.id];
    if (! nodeDict) {
      warn(`rebuildNodeFromSerializedHash(): no nodeId "${node.id}"`);
      return 1;
    }
    //debug('nodeDict()', nodeDict);

    // update caches
    this.nodes[node.id] = node;
    // build the node
    node.fromDict(nodeDict);
    this.nodeMarkChanged(node);  // update our mark cache
    node.nodes = [];
    numLoaded ++;
    for (const nodeId of nodeDict.nodes) {
      if ('root' === nodeId) continue;  // root can't be a child
      //debug('nodeDict() childId', nodeId);
      const child = new this.NodeClass(this, node);
      child.id = nodeId;
      this.nodes[nodeId] = child;
      node.nodes.push(child);
      numLoaded += this.rebuildNodeFromSerializedHash(child, hash);
    }
    return numLoaded;
  }

  async makeBackupObject (rootNode, when) {
    const obj = {};
    // TODO: actually write and publish the schema file
    obj.$schema = jsonSchema;
    if (undefined === when) when = Date.now();
    obj.metadata = {};
    obj.metadata.exportDate = Number(when);
    obj.metadata.sessionStartDate = Number(rootNode.ctime);
    // attach the client ID
    let clientId = '??';
    const result = await api.storage.local.get('clientId');
    if (result.clientId) clientId = result.clientId;
    obj.metadata.clientId = clientId;
    // attach the actual tree / node data
    obj.nodes = this.serializeNodes(true);
    return obj;
  }

  async downloadBackupNow () {
    await this.treeLoaded;  // wait until tree is ready

    const when = new Date();
    const whenMs = Number(when);
    // determine whether to pretty-print the data
    let prettyPrint = 0;
    const result = await api.storage.local.get('humanFriendlyBackups');
    if (result.humanFriendlyBackups) prettyPrint = 2;
    // generate the file's raw data
    const backup = await this.makeBackupObject(this.root, when);
    const jsonString = JSON.stringify(backup, null, prettyPrint);
    const blob = new Blob([jsonString], { type: "application/json" });
    // generate the URL to download
    let url;
    if ((! this.bkgd) || (isFirefox)) {
      // simple, but only works in Firefox or in views (like the sidepanel)
      url = URL.createObjectURL(blob);
    }
    else {
      // more complex, but works in Chrome service workers:
      const buffer = await blob.arrayBuffer();
      // hello, stack overflow:
      //const base64String = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      // avoid a stack overflow:
      const binaryString = new Uint8Array(buffer)
        .reduce((acc, byte) => acc + String.fromCharCode(byte), "");
      const base64String = btoa(binaryString);
      url = `data:application/json;base64,${base64String}`;
    }
    // build a filename
    const clientId = backup.metadata.clientId;
    const date = dateTupleStrings(when);
    const filename = `tktsto.${date[0]}-${date[1]}-${date[2]}_${date[3]}-${date[4]}-${date[5]}.${clientId}.json`;

    // save the file
    log(`Tree.downloadBackupNow(): saving to "${filename}"`);
    const downloading = api.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    });
    let downloadId;
    function onStarted (id) {
      downloadId = id;
      api.storage.local.set({ lastBackupTime: whenMs });
    }
    function progress (delta) {
      //debug('Download delta', delta);
      if ((delta.id === downloadId)
        && delta.state && delta.state.current === "complete")
      {
        //log(`Download succeeded: ${filename}`);
        api.downloads.onChanged.removeListener(progress);
        if (downloadId && api.downloads && api.downloads.search) {
          api.downloads.search({ id: downloadId }).then((items) => {
            const info = items && items[0];
            if (info && info.filename && info.filename !== filename) {
              log(`Tree.downloadBackupNow(): saved as "${info.filename}" (requested "${filename}")`);
            }
          }).catch((err) => {
            warn(`Tree.downloadBackupNow(): download search failed: ${err}`);
          });
        }
        if (this.setStatus) {
          this.setStatus(`Saved ${blob.size} bytes to "${filename}"`);
        }
        try {
          // docs recommend cleaning this up
          // but docs also say this is unavailable in service workers
          // so ... do it when possible, and ignore errors otherwise
          URL.revokeObjectURL(url);
        } catch (err) {
        }
      }
    }
    function onFailed (err) {
      warn(`Download failed: ${err}`);
      api.downloads.onChanged.removeListener(progress);
    }
    api.downloads.onChanged.addListener(progress.bind(this));
    downloading.then(onStarted, onFailed);
  }

  getNodeByTabId (tabId, root)  {
    // TODO: maybe move this function to Node.getNodeByTabId() ?
    if (! root) root = this.root;
    const directMatches = root.findNodes((node) =>
      { return (node.tabId === tabId); }
    );
    if (1 === directMatches.length) return directMatches[0];
    if (directMatches.length > 1) {
      const preferred = this.choosePreferredTabNode(directMatches);
      warn(`Tree.getNodeByTabId(${tabId}) found ${directMatches.length} tabId matches, not 1`,
        directMatches);
      return preferred;
    }

    const oldMatches = root.findNodes((node) =>
      { return (node.oldTabId === tabId); }
    );
    if (1 === oldMatches.length) return oldMatches[0];
    if (1 > oldMatches.length) return null;
    const preferred = this.choosePreferredTabNode(oldMatches);
    warn(`Tree.getNodeByTabId(${tabId}) found ${oldMatches.length} oldTabId matches, not 1`,
      oldMatches);
    return preferred;
  }

  choosePreferredTabNode (nodes) {
    if (! nodes || (nodes.length < 1)) return null;
    if (1 === nodes.length) return nodes[0];
    const scored = nodes.map((node) => ({
      node,
      score: [
        node.isLoaded() ? 1 : 0,
        node.isActive() ? 1 : 0,
        node.windowId ? 1 : 0,
        node.shouldUnloadNotDelete() ? 1 : 0,
        node.ctime || 0,
        node.id || ''
      ]
    }));
    scored.sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) {
        if (a.score[i] < b.score[i]) return 1;
        if (a.score[i] > b.score[i]) return -1;
      }
      return 0;
    });
    return scored[0].node;
  }

  async ensureUniqueBrowserBindings (targetNode, changes, args) {
    if (! targetNode || ! changes) return;

    if ((undefined !== changes.tabId) && (null !== changes.tabId)) {
      await this.clearConflictingTabBindings(targetNode, changes.tabId, args);
    }

    const nextType = ('type' in changes) ? changes.type : targetNode.type;
    if ((nextType === 'window')
      && (undefined !== changes.windowId)
      && (null !== changes.windowId)) {
      await this.clearConflictingWindowBindings(
        targetNode,
        changes.windowId,
        args
      );
    }
  }

  async clearConflictingTabBindings (targetNode, tabId, args) {
    for (const node of Object.values(this.nodes)) {
      if ((! node) || (node === targetNode) || node.isWindow()) continue;
      const directMatch = (node.tabId === tabId);
      const oldMatch = (node.oldTabId === tabId);
      if ((! directMatch) && (! oldMatch)) continue;

      const staleChanges = {};
      if (directMatch) {
        staleChanges.tabId = undefined;
        staleChanges.windowId = undefined;
        staleChanges.active = false;
        staleChanges.loaded = false;
        staleChanges.wasLoaded = Boolean(node.loaded || node.wasLoaded);
      }
      if (oldMatch) staleChanges.oldTabId = undefined;
      await node.setTabFields(staleChanges, {
        ...args,
        emit: false,
        ensureUniqueBindings: false,
        reason: 'dedupeTabBinding'
      });
    }
  }

  async clearConflictingWindowBindings (targetNode, windowId, args) {
    for (const node of Object.values(this.nodes)) {
      if ((! node) || (node === targetNode) || (! node.isWindow())) continue;
      if (node.windowId !== windowId) continue;
      const staleChanges = {
        windowId: undefined,
        active: false
      };
      if (node.isLoaded()) {
        staleChanges.loaded = false;
        staleChanges.wasLoaded = Boolean(node.loaded || node.wasLoaded);
      }
      await node.setTabFields(staleChanges, {
        ...args,
        emit: false,
        ensureUniqueBindings: false,
        reason: 'dedupeWindowBinding'
      });
    }
  }

  getTabPendingUrl (tab) {
    if (tab.pendingUrl) return tab.pendingUrl;  // chrome
    if ('about:blank' === tab.url) {  // firefox
      if (tab.title && tab.title.includes('/')) {
        // firefox puts the pending URL in the title
        // but strips the protocol://
        return tab.title;
      }
      return tab.url;
    }
    return tab.url;
  }

  async getWindowPinnedPrefixCount (windowId) {
    let tabs;
    try {
      tabs = await api.tabs.query({ windowId });
    } catch (err) {
      warn(`Tree.getWindowPinnedPrefixCount(${windowId}) failed: ${err}`);
      return 0;
    }
    tabs.sort((a, b) => (a.index || 0) - (b.index || 0));
    let count = 0;
    for (const tab of tabs) {
      if (tab && tab.pinned) count += 1;
      else break;
    }
    return count;
  }

  browserTabIndexToMovableIndex (index, pinnedPrefixCount) {
    // Browser tab indexes count pinned tabs; tree placement for movable tabs
    // must subtract that fixed prefix.
    if (! Number.isInteger(index)) return null;
    return index - pinnedPrefixCount;
  }

  getMovableLoadedTabs (windowNode, excludeNode = null) {
    return windowNode.getLoadedTabs().filter((node) =>
      (! node.pinned) && (node !== excludeNode)
    );
  }

  getPinnedLoadedTabs (windowNode, excludeNode = null) {
    return windowNode.getLoadedTabs().filter((node) =>
      node.pinned && (node !== excludeNode)
    );
  }

  getPinnedInsertDestination (windowNode, pinnedIndex, excludeNode = null) {
    // When reordering an existing pinned node, exclude it before interpreting
    // the browser's target index so rightward moves don't count the node twice.
    const pinnedTabs = this.getPinnedLoadedTabs(windowNode, excludeNode);
    if ((! Number.isInteger(pinnedIndex)) || (pinnedIndex <= 0)
      || (pinnedTabs.length === 0)) {
      return { destParent: windowNode, destIndex: 0 };
    }
    if (pinnedIndex >= pinnedTabs.length) {
      const lastPinned = pinnedTabs[pinnedTabs.length - 1];
      return {
        destParent: lastPinned.parent,
        destIndex: lastPinned.indexOf() + 1
      };
    }
    const nextPinned = pinnedTabs[pinnedIndex];
    return {
      destParent: nextPinned.parent,
      destIndex: nextPinned.indexOf()
    };
  }

  getFirstMovableInsertDestination (windowNode) {
    // Unpinned tabs must start after the pinned prefix, even when there are no
    // other movable tabs in the tree yet.
    const pinnedTabs = this.getPinnedLoadedTabs(windowNode);
    if (pinnedTabs.length === 0) {
      return { destParent: windowNode, destIndex: 0 };
    }
    const lastPinned = pinnedTabs[pinnedTabs.length - 1];
    return {
      destParent: lastPinned.parent,
      destIndex: lastPinned.indexOf() + 1
    };
  }

  getMovableInsertDestination (windowNode, movableIndex, excludeNode = null) {
    // Use the movable strip only.  Excluding the moving node prevents stale tree
    // position from turning pin/unpin transitions into false no-ops.
    const tabList = this.getMovableLoadedTabs(windowNode, excludeNode);
    if ((tabList.length === 0)
      || (! Number.isInteger(movableIndex))
      || (movableIndex <= 0)) {
      return this.getFirstMovableInsertDestination(windowNode);
    }
    if (movableIndex >= tabList.length) {
      const lastNode = tabList[tabList.length - 1];
      return {
        destParent: lastNode.parent,
        destIndex: lastNode.indexOf() + 1
      };
    }
    const nextNode = tabList[movableIndex];
    return {
      destParent: nextNode.parent,
      destIndex: nextNode.indexOf()
    };
  }

  async getBrowserEventTabDestination (tabNode, windowNode, browserIndex, pinned) {
    if (pinned) {
      return this.getPinnedInsertDestination(
        windowNode,
        browserIndex,
        tabNode
      );
    }
    const pinnedPrefixCount =
      await this.getWindowPinnedPrefixCount(windowNode.windowId);
    const movableIndex = this.browserTabIndexToMovableIndex(
      browserIndex,
      pinnedPrefixCount
    );
    return this.getMovableInsertDestination(
      windowNode,
      movableIndex,
      tabNode
    );
  }

  async moveTabNodeForBrowserEvent (
    tabNode,
    destParent,
    destIndex,
    reason,
    details = {}
  ) {
    if (details.moveNodeOnly && tabNode.hasKids()) {
      await tabNode.promoteKids({
        reason,
        skipTabReorder: true
      });
      if (details.windowNode && Number.isInteger(details.browserIndex)) {
        const dest = await this.getBrowserEventTabDestination(
          tabNode,
          details.windowNode,
          details.browserIndex,
          details.pinned
        );
        destParent = dest.destParent;
        destIndex = dest.destIndex;
      }
    }
    if ((tabNode.parent === destParent)
      && (tabNode.indexOf() === destIndex)) {
      return;
    }
    return await tabNode.moveTo(destParent, destIndex, {
      reason,
      skipTabReorder: true
    });
  }

  async onWindowCreated (window, args) {
    // are we re-opening a saved window?
    let savedWindowNode;
    if (this.bkgd.windowsLoading.length > 0) {
      savedWindowNode = this.bkgd.windowsLoading.shift();
      debug(`Tree.onWindowCreated() loadingSavedWindow=${savedWindowNode.id}`);
    }
    // if nothing in the queue, try searching by window ID
    // TODO: unsure if this ever actually happens
    if (! savedWindowNode) {
      const found = this.root.findNodes((node) =>
        { return node.isWindow() && (node.windowId === window.id); });
      if (found.length > 0) {
        debug('Tree.onWindowCreated() found window', found[0]);
        savedWindowNode = found[0];
      }
    }
    // are we re-opening a saved window?
    if (savedWindowNode) {
      await savedWindowNode.setTabFields({
        type: 'window',
        windowId: window.id,
        loaded: true,
        //windowState: window.state,  // TODO
        //incognito: window.incognito,  // TODO
        geometry: [window.width, window.height, window.left, window.top]
      }, { reason: args.reason });
      // in case a parent tab with child tabs has *already* been moved
      // to this window (which caused the window to be created),
      // reorder the tabs to pull in the child tabs
      await savedWindowNode.reorderAllTabsInThisWindow();
      return savedWindowNode;
    }

    // otherwise, create a new node for this window
    const destParent = this.root;
    // TODO: maybe insert at beginning instead of end?
    const destIndex = this.root.nodes.length;
    // TODO: handle window.top, .left, .width, .height
    //       so it can re-open saved windows at same size+position
    // TODO: handle window types: normal, incognito, pop-up?, ...
    const newNode = await destParent.addChild(destIndex, {
      type: 'window',
      windowId: window.id,
      loaded: true,
      //windowState: window.state,  // TODO
      //incognito: window.incognito,  // TODO
      geometry: [window.width, window.height, window.left, window.top]
    }, { reason: args.reason });
    debug('Tree.onWindowCreated() new window node', newNode);
    return newNode;
  }

  async onTabCreated (tab) {
    // tab: https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
    // tab.active: boolean
    // tab.discarded: boolean
    // tab.favIconUrl: string
    // tab.frozen: boolean
    // tab.groupId: number
    // tab.id: number
    // tab.incognito: boolean
    // tab.index: number
    // tab.lastAccessed: number
    // tab.openerTabId: number
    // tab.pinned: number
    // tab.sessionId: string (will be useful for handling restored sessions later)
    // tab.title: string
    // tab.url: string
    // tab.windowId: number
    //   MAY NOT EXIST YET
    //   When opening a new window, the browser does onTabCreated
    //   before doing onWindowCreated, so it can refer to a window
    //   which doesn't exist yet.  :(
    debug(`Tree.onTabCreated(): Window ID: ${tab.windowId} Tab ID: ${tab.id}, URL: ${tab.url}, pendingUrl: ${tab.pendingUrl}`, tab);

    // if tab was already created, do nothing
    const tabNode = this.getNodeByTabId(tab.id);
    if (tabNode) return debug(`Tree.onTabCreated(${tab.id}): already exists`);

    // figure out which URL this new tab is going to
    const tabPendingUrl = this.getTabPendingUrl(tab);

    // Vivaldi sends this event for sidepanels,
    // but they can't be used like tabs, so ignore them
    if (('about:blank' === tabPendingUrl) && isChrome) {
      let pendingTab;  // allow if *we* opened it; ignore otherwise
      if (this.bkgd && (this.bkgd.nodesLoading.length > 0)) {
        pendingTab = this.bkgd.nodesLoading[0];
      }
      if ('about:blank' !== pendingTab) {
        this.tabBlacklist[`${tab.id}`] = true;
        debug('ignoring tab which looks like a Vivaldi panel');
        return;
      }
    }

    // are we loading a saved tab?
    let savedTabNode;
    if (this.bkgd && (this.bkgd.nodesLoading.length > 0)) {
      savedTabNode = this.bkgd.nodesLoading.shift();
      debug(`Tree.onTabCreated() loadingSavedTab=${savedTabNode.id}`);
    }

    // if we're loading a saved tab,
    // use that node instead of making a new one
    if (savedTabNode) {
      debug(`Tree.onTabCreated(): restoring nodeId=${savedTabNode.id}`);
      // re-attach this tab to the found Node
      await savedTabNode.setTabFields({
        tabId: tab.id,
        windowId: tab.windowId,
        loaded: true,
        discarded: tab.discarded,
        frozen: tab.frozen,
        hidden: tab.hidden,
        incognito: tab.incognito,
        pinned: Boolean(tab.pinned || savedTabNode.pinned)
      }, { reason: 'onTabCreated' });
      // If the browser reports the tab as still unpinned during restore, keep
      // the saved pinned state until a real pinned update or pin failure lands.
      if (tab.pinned) savedTabNode.pinRestorePending = false;
      // put the tab in the right position
      await savedTabNode.reorderAllTabsInThisWindow();
      return;
    }

    // find the window Node
    let winNode = this.root.getWindowId(tab.windowId);
    if (! winNode) {
      // this usually means the user just opened a new window, and
      // the browser generated onTabCreated BEFORE doing an onWindowCreated
      // event, so we need to create a new window Node on the assumption
      // that it WILL exist in a few milliseconds (7ms later, in my tests)
      //return error(`Tree.onTabCreated() can't find windowId="${tab.windowId}"`);
      debug(`Tree.onTabCreated() can't find windowId="${tab.windowId}", creating new Node for it`);
      // create the window node, assuming the window will exist soon
      const winParent = this.root;
      const winIndex = this.root.nodes.length;
      winNode = await winParent.addChild(winIndex, {
        type: 'window',
        windowId: tab.windowId,
        loaded: false
        }, { reason: 'onTabCreated' });
    }
    let destParent = winNode;
    let destIndex = winNode.nodes.length;

    if (this.reorderTabsOnCreate === false) {
      const pinnedPrefixCount =
        await this.getWindowPinnedPrefixCount(tab.windowId);
      if (tab.pinned) {
        const dest = this.getPinnedInsertDestination(winNode, tab.index);
        destParent = dest.destParent;
        destIndex = dest.destIndex;
      } else {
        const movableIndex =
          this.browserTabIndexToMovableIndex(tab.index, pinnedPrefixCount);
        const tabList = this.getMovableLoadedTabs(winNode);
        if (tabList.length === 0) {
          const dest = this.getFirstMovableInsertDestination(winNode);
          destParent = dest.destParent;
          destIndex = dest.destIndex;
        } else if ((movableIndex === null) || (movableIndex <= 0)) {
          const dest = this.getFirstMovableInsertDestination(winNode);
          destParent = dest.destParent;
          destIndex = dest.destIndex;
        } else if (movableIndex >= tabList.length) {
          const lastNode = tabList[tabList.length - 1];
          destParent = lastNode.parent;
          destIndex = lastNode.indexOf() + 1;
        } else {
          const prevNode = tabList[movableIndex - 1];
          destParent = prevNode.parent;
          destIndex = prevNode.indexOf() + 1;
        }
      }
    } else {
      // find the active tab so we can compare to the new tab
      // (some browsers (Maxthon) set tab.index *instead of* tab.openerTabId,
      //  so detecting parent must be done by index in those browsers)
      const activeTabs = await api.tabs.query({
        active: true, windowId: tab.windowId });
      const activeTab = activeTabs[0];
      const activeTabNode = winNode.getActiveTab();

      // if the tab is a blank created by the user with C-t...
      // ... make it the 1st child of the active tab
      if (isNewTabPage(tabPendingUrl)) {
        destParent = activeTabNode;
        if (! destParent) destParent = winNode;
        destIndex = 0;
        debug(`Tree.onTabCreated(newTabPage) moving new tab to the right of: "${destParent.toLine()}"`);
      }
      // find the right place to put this tab in the tree
      else if (tab.openerTabId) {
        const found = this.getNodeByTabId(tab.openerTabId, winNode);
        if (found) {
          destParent = found;
          // find the correct destIndex
          // TODO: decide this based on a user config option:
          //   - open tabs as [first / last] child of current,
          //     or open as next sibling
          //destIndex = destParent.nodes.length;
          destIndex = 0;  // always insert as 1st child of current tab
          debug(`Tree.onTabCreated(openerTabId): destParent:`, destParent);
        }
        else {
          // if parent not found, open tab as 1st child of current/active tab
          if (activeTabNode) {
            destParent = activeTabNode;
            destIndex = 0;
            debug(`Tree.onTabCreated(openerTabId not found): destParent:`, destParent);
          }
        }
      }
      // Maxthon doesn't set openerTabId, so detect it by index
      else if (activeTab && ((activeTab.index + 1) === tab.index)) {
        // first child of current tab
        // (assume user clicked a link on the current page, to open a new tab)
        destParent = activeTabNode;
        if (! destParent) destParent = winNode;
        destIndex = 0;
        debug(`Tree.onTabCreated(parentByIndex) moving new tab to the right of: "${destParent.toLine()}"`);
      }
    }
    // create the tree node
    await destParent.addChild(destIndex, {
      windowId: tab.windowId,
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      faviconUrl: tab.favIconUrl,
      loaded: true,
      active: tab.active,
      discarded: tab.discarded,
      frozen: tab.frozen,
      hidden: tab.hidden,  // firefox only?
      incognito: tab.incognito,
      pinned: Boolean(tab.pinned),
      atime: tab.lastAccessed
      }, { reason: 'onTabCreated' });
  }

  async onTabRemoved (tabId, removeInfo) {
    // tabId: number
    // removeInfo.isWindowClosing: boolean
    // removeInfo.windowId: number
    debug(`tree.onTabRemoved(tabId=${tabId}, windowId=${removeInfo.windowId}, isWindowClosing=${removeInfo.isWindowClosing})`);
    const tabNode = this.getNodeByTabId(tabId);
    // if tab doesn't exist, do nothing
    if (! tabNode) {
      log(`onTabRemoved(${tabId}): couldn't find node`, removeInfo);
      return;
    }
    // TODO: if tab was last Node in the window and it's boring,
    //   delete the tab node...
    //   and if the window was boring too, delete it too
    // if tab unloaded manually by user, and we're just cleaning up
    // (without tabClosedReason, it's likely the user closed the tab
    //  and caused a new service worker to spawn)
    if ('unload' === tabNode.tabClosedReason) {
      // finalize the unload now that the browser tab is actually closed
      tabNode.tabClosedReason = undefined;  // message received, reset it
      return tabNode.unload({ reason: 'onTabRemoved', detail: 'manualUnload' });
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
      // Preserve tabs even if the window is boring.
      return tabNode.unload({ reason: 'onWindowRemoved' });
    }

    // If the last tab was a boring leaf, remove it and the empty window.
    if (isWindowClosing && windowNode) {
      const tabIsBoringLeaf = (! tabNode.shouldUnloadNotDelete())
        && (! tabNode.hasKids());
      const isOnlyWindowChild = (1 === windowNode.nodes.length)
        && (windowNode.nodes[0] === tabNode);
      if (tabIsBoringLeaf && isOnlyWindowChild) {
        await tabNode.deleteSelf({ reason: 'onTabRemoved' });
        if (windowNode.shouldUnloadNotDelete()) {
          await windowNode.unload({ reason: 'onWindowRemoved' });
        } else {
          await windowNode.deleteSelf({ reason: 'onTabRemoved' });
        }
        return;
      }
    }
    // if tab closed only because its window is closing
    if (isWindowClosing) {
      // keep unloaded tab as part of the user's saved window
      return tabNode.unload({ reason: 'onWindowRemoved', detail: 'saveWindow' });
    }
    // if tab closed manually by user, but it has label/notes
    else if (tabNode.shouldUnloadNotDelete()) {
      // keep tab in tree to preserve its metadata
      return tabNode.unload({ reason: 'onTabRemoved', detail: 'hasMetadata' });
    }
    // if tab is boring but has kids
    else if (tabNode.hasKids()) {
      // delete the node, but keep its kids
      return tabNode.deleteSelfAndPromoteKids({ reason: 'onTabRemoved', detail: 'hasKids' });
    }
    // tab is a leaf node with no label or anything interesting
    else {
      // delete boring tabs on close
      return tabNode.deleteSelf({ reason: 'onTabRemoved', detail: 'boringLeaf' });
    }
  }

  async onTabActivated (windowId, tabId) {
    const windowNode = this.root.getWindowId(windowId);
    if (! windowNode) {
      // can happen when loading saved tab in saved window,
      // because onWindowCreated doesn't happen until
      // after the onTabActivated event for the first tab
      if (this.bkgd && (this.bkgd.windowsLoading.length > 0))
        return;  // not an error, just a browser quirk
      return error(`Tree.onTabActivated() can't find windowId="${windowId}"`);
    }
    await windowNode.setActiveTab({ reason: 'onTabActivated' });
  }

  async onTabMoved (tabId, moveInfo) {
    // tab was moved within a window
    // tabId: number
    // moveInfo.fromIndex: number
    // moveInfo.toIndex: number
    // moveInfo.windowId: number
    // get the tabNode and winNode
    const windowNode = this.root.getWindowId(moveInfo.windowId);
    if (! windowNode) {
      // FIXME: WTF, shouldn't happen, big error here
      return error(`Tree.onTabMoved() can't find windowId="${moveInfo.windowId}"`);
    }
    const tabNode = this.getNodeByTabId(tabId);
    if (! tabNode) {
      // FIXME: also shouldn't happen
      return error(`Tree.onTabMoved() can't find tabId="${tabId}"`);
    }
    if (this.isSuppressedTabMovedEvent(moveInfo.windowId, tabId)) {
      debug(`Tree.onTabMoved(${tabId}) ignored extension reorder event`);
      return;
    }
    let browserTab = null;
    try {
      browserTab = await api.tabs.get(tabId);
    } catch (err) {
      warn(`Tree.onTabMoved(${tabId}) tab lookup failed: ${err}`);
    }
    if (browserTab && tabNode.pinned !== Boolean(browserTab.pinned)) {
      await tabNode.setTabFields(
        { pinned: Boolean(browserTab.pinned) },
        { reason: 'onTabMoved' }
      );
    }
    if ((browserTab && browserTab.pinned) || tabNode.pinned) {
      const dest = this.getPinnedInsertDestination(
        windowNode,
        moveInfo.toIndex,
        tabNode
      );
      if ((tabNode.parent === dest.destParent)
        && (tabNode.indexOf() === dest.destIndex)
        && ((! tabNode.hasKids()) || (moveInfo.fromIndex === moveInfo.toIndex))) {
        debug('Tree.onTabMoved(): pinned tab already at correct index',
          moveInfo.fromIndex, moveInfo.toIndex);
        return;
      }
      return await this.moveTabNodeForBrowserEvent(
        tabNode,
        dest.destParent,
        dest.destIndex,
        'onTabMoved',
        {
          moveNodeOnly: moveInfo.fromIndex !== moveInfo.toIndex,
          windowNode,
          browserIndex: moveInfo.toIndex,
          pinned: true
        }
      );
    }
    const pinnedPrefixCount =
      await this.getWindowPinnedPrefixCount(moveInfo.windowId);
    const fromIndex = this.browserTabIndexToMovableIndex(
      moveInfo.fromIndex,
      pinnedPrefixCount
    );
    const toIndex = this.browserTabIndexToMovableIndex(
      moveInfo.toIndex,
      pinnedPrefixCount
    );
    if ((toIndex === null) || (toIndex < 0)) return;
    debug(`Tree.onTabMoved(): ${tabNode.toLine()}`);
    const dest = this.getMovableInsertDestination(
      windowNode,
      toIndex,
      tabNode
    );
    if ((tabNode.parent === dest.destParent)
      && ((tabNode.indexOf() === dest.destIndex)
        || (tabNode.indexOf() + 1 === dest.destIndex))
      && ((! tabNode.hasKids()) || (moveInfo.fromIndex === moveInfo.toIndex))) {
      debug('Tree.onTabMoved(): tab already at correct index',
        fromIndex, toIndex);
      return;
    }
    return await this.moveTabNodeForBrowserEvent(
      tabNode,
      dest.destParent,
      dest.destIndex,
      'onTabMoved',
      {
        moveNodeOnly: moveInfo.fromIndex !== moveInfo.toIndex,
        windowNode,
        browserIndex: moveInfo.toIndex,
        pinned: false
      }
    );

    // old: some thoughts on how this maybe should work
    // decide on a new position:
    // - 1st child of prevTabNode
    // - 1st sibling after prevTabNode
    // - last child of prevTabNode
    // - last sibling before nextTabNode
    // - depends on Node expanded/collapsed states maybe?
    // - other (after implementing user config options for other placements)
    // cases...
    // - if prev and next are siblings, place as sibling between them
    // - if prev is leaf, place as sibling just after it
    // - if prev is ancestor of next, place this as 1st child of prev
    // - if prev is collapsed branch and next not a descendant, place as next sibling?
    // - if prev is branch, place as 1st child?
  }

  async onTabAttached (tabId, attachInfo) {
    // tabId: number
    // attachInfo.newPosition: number
    // attachInfo.newWindowId: number
    //   (may refer to a window which doesn't exist yet)
    const newIndex = attachInfo.newPosition;
    const windowId = attachInfo.newWindowId;
    debug(`Tree.onTabAttached(${tabId}) -> ${windowId}, ${newIndex}`);

    // find the tab node
    const tabNode = this.getNodeByTabId(tabId);
    // if tab doesn't exist, do nothing
    if (! tabNode) return warn(`Tree.onTabAttached(${tabId}): no tab found`);
    let browserTab = null;
    try {
      browserTab = await api.tabs.get(tabId);
    } catch (err) {
      warn(`Tree.onTabAttached(${tabId}) tab lookup failed: ${err}`);
    }
    const attachmentChanges = {};
    if (tabNode.windowId !== windowId) attachmentChanges.windowId = windowId;
    if (browserTab && tabNode.pinned !== Boolean(browserTab.pinned)) {
      attachmentChanges.pinned = Boolean(browserTab.pinned);
    }
    if (Object.keys(attachmentChanges).length > 0) {
      await tabNode.setTabFields(attachmentChanges, { reason: 'onTabAttached' });
    }

    // find or create the window node
    let windowNode;
    const found = this.root.findNodes((node) =>
      { return node.isWindow() && (node.windowId === windowId); });
    if (found.length > 0) { windowNode = found[0]; }
    // when moving a loaded tab to an unloaded window,
    // the browser does onTabAttached before onWindowCreated
    // so we have to handle part of that process here
    else if (this.bkgd.windowsLoading.length > 0) {
      windowNode = this.bkgd.windowsLoading[0];
      windowNode.windowId = windowId;
    }
    // otherwise, create a new window node
    else {
      const destParent = this.root;
      const destIndex = destParent.nodes.length;
      windowNode = await destParent.addChild(destIndex, {
        type: 'window',
        windowId: windowId
      }, { reason: 'onTabAttached' });
      // this happens if I drag a tab into nowhere to create a new window,
      // and it initially has no tabs
      debug('Tree.onTabAttached(new window)');
      // is handled below
      //await tabNode.moveTo(windowNode, 0, { reason: 'onTabAttached' });
      //return;
    }

    if ((browserTab && browserTab.pinned) || tabNode.pinned) {
      const dest = this.getPinnedInsertDestination(
        windowNode,
        newIndex,
        tabNode
      );
      if ((tabNode.getWindowNode(false) !== windowNode)
        || (tabNode.parent !== dest.destParent)
        || ((tabNode.indexOf() !== dest.destIndex)
          && (tabNode.indexOf() + 1 !== dest.destIndex))) {
        await this.moveTabNodeForBrowserEvent(
          tabNode,
          dest.destParent,
          dest.destIndex,
          'onTabAttached',
          {
            moveNodeOnly: true,
            windowNode,
            browserIndex: newIndex,
            pinned: true
          }
        );
      }
      await windowNode.setActiveTab({ reason: 'onTabAttached' });
      return;
    }
    // get the ordered list of tabs in this windowNode
    const pinnedPrefixCount = await this.getWindowPinnedPrefixCount(windowId);
    const movableNewIndex =
      this.browserTabIndexToMovableIndex(newIndex, pinnedPrefixCount);
    if ((movableNewIndex === null) || (movableNewIndex < 0)) {
      await windowNode.setActiveTab({ reason: 'onTabAttached' });
      return;
    }
    let tabList = this.getMovableLoadedTabs(windowNode);
    let destParent;
    let destIndex;
    let skip = false;
    // already moved internally
    // (like, user moved it in the tree view, and the browser is catching up)
    if (tabNode === tabList[movableNewIndex]) {
      debug('Tree.onTabAttached(): already correct:', tabNode.toLine());
      skip = true;
    }
    // empty window
    else if (0 === tabList.length) {
      const dest = this.getFirstMovableInsertDestination(windowNode);
      destParent = dest.destParent;
      destIndex = dest.destIndex;
    }
    // right-most tab
    else if (movableNewIndex >= tabList.length) {
      const lastNode = tabList[tabList.length - 1];
      destParent = lastNode.parent;
      destIndex = lastNode.indexOf() + 1;
    }
    // middle or first tab
    else {
      const nextNode = tabList[movableNewIndex];
      destParent = nextNode.parent;
      destIndex = nextNode.indexOf();
    }
    if (! skip) {
      debug('Tree.onTabAttached(): moving', tabNode.toLine(), destParent.toLine(), destIndex);
      await this.moveTabNodeForBrowserEvent(
        tabNode,
        destParent,
        destIndex,
        'onTabAttached',
        {
          moveNodeOnly: true,
          windowNode,
          browserIndex: newIndex,
          pinned: false
        }
      );
    }

    // ensure only one tab is 'active'
    debug(`onTabAttached(): active tab: auto`);
    await windowNode.setActiveTab({ reason: 'onTabAttached' });
  }

  async onTabUpdated(tabId, changeInfo, tab) {
    // tabId: number
    // tab: https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
    // changeInfo.title: string
    // changeInfo.url: url
    // changeInfo.favIconUrl: string
    // changeInfo.status: https://developer.chrome.com/docs/extensions/reference/api/tabs#type-TabStatus
    //   - 'unloaded', 'loading', 'complete'
    // changeInfo.pinned: boolean
    // changeInfo.groupId: number
    // changeInfo.discarded: boolean
    // changeInfo.frozen: boolean
    // changeInfo.audible: boolean
    // changeInfo.mutedInfo: https://developer.chrome.com/docs/extensions/reference/api/tabs#type-MutedInfo
    // changeInfo.autoDiscardable: boolean
    debug(`Tree.onTabUpdated(tabId=${tabId})`, changeInfo, tab);

    // wait, if a tab is currently being replaced
    const otrUnlock = await this.onTabReplacedMutex.lock();  otrUnlock();

    // ignore Vivaldi sidepanels and other non-tab "tabs"
    if (this.tabBlacklist[`${tabId}`]) {
      debug('ignoring blacklisted tab');
      return;
    }

    const tabNode = this.getNodeByTabId(tabId);

    // if tab doesn't exist, do nothing
    if (! tabNode) return warn(`Tree.onTabUpdated(${tabId}): no tab found`);

    // change ... multiple things
    let changes = {};  // only changes we care about
    for (const field of
      ['title', 'url', 'favIconUrl',
        'discarded', 'frozen', 'hidden', 'pinned']
    ) {
      // bugfix: sometimes Vivaldi gives me empty changeInfo,
      // so pull new values from tab object if necessary
      let value = changeInfo[field];
      if (undefined === value) value = tab[field];
      if ('pinned' === field && tabNode.pinRestorePending) {
        // Saved pinned tabs can emit an early false update before the browser
        // accepts our pin request.  Ignore only the short one-way race; stale
        // false updates after the guard window are treated as real unpins.
        const guardMs = 2000;
        const pendingAge = Date.now() - (tabNode.pinRestorePendingAt || 0);
        if ((value === false) && (pendingAge <= guardMs)) continue;
        tabNode.pinRestorePending = false;
        tabNode.pinRestorePendingAt = 0;
      }
      // clean up sloppy titles
      if ('title' === field) value = value.trim().replace(/\s+/g, ' ');
      // Map browser API's favIconUrl to our faviconUrl property for comparison
      const nodeField = (field === 'favIconUrl') ? 'faviconUrl' : field;
      // if data actually changed, add it to the outgoing message
      if (tabNode[nodeField] !== value) changes[field] = value;
    }
    const pinnedChanged = Object.prototype.hasOwnProperty.call(changes, 'pinned');
    // apply changes, if any
    if (Object.keys(changes).length > 0) {
      await tabNode.setTabFields(changes, { reason: 'onTabUpdated' });
    }
    if (pinnedChanged) {
      await this.repositionTabNodeAfterPinnedUpdate(tabNode, tab);
    }
  }

  async repositionTabNodeAfterPinnedUpdate (tabNode, tab) {
    const windowId = tab.windowId || tabNode.windowId;
    const windowNode = this.root.getWindowId(windowId);
    if (! windowNode) {
      return warn(`Tree.repositionTabNodeAfterPinnedUpdate() can't find windowId="${windowId}"`);
    }
    let dest;
    if (tabNode.pinned) {
      dest = this.getPinnedInsertDestination(windowNode, tab.index, tabNode);
    } else {
      const pinnedPrefixCount = await this.getWindowPinnedPrefixCount(windowId);
      const movableIndex = this.browserTabIndexToMovableIndex(
        tab.index,
        pinnedPrefixCount
      );
      if ((movableIndex === null) || (movableIndex < 0)) return;
      dest = this.getMovableInsertDestination(windowNode, movableIndex, tabNode);
    }
    if ((tabNode.parent === dest.destParent)
      && ((tabNode.indexOf() === dest.destIndex)
        || (tabNode.indexOf() + 1 === dest.destIndex))) {
      return;
    }
    return await this.moveTabNodeForBrowserEvent(
      tabNode,
      dest.destParent,
      dest.destIndex,
      'onTabUpdated',
      {
        moveNodeOnly: true,
        windowNode,
        browserIndex: tab.index,
        pinned: tabNode.pinned
      }
    );
  }

  async onTabReplaced (addedTabId, removedTabId) {
    // "Fired when a tab is replaced with another tab due to prerendering or instant."
    // addedTabId: number
    // removedTabId: number
    debug(`Tree.onTabReplaced(addedTabId=${addedTabId}, removedTabId=${removedTabId})`);
    // I don't even know how to make this event happen...
    // ... and apparently it doesn't happen at all in some browsers ...
    // so the code here is untested
    const tabNode = this.getNodeByTabId(removedTabId);

    // if tab doesn't exist, do nothing
    if (! tabNode) return warn(`Tree.onTabReplaced(${removedTabId}): no tab found`);

    // it's like a onTabUpdated(), but only the tabId changes?
    const changes = { 'tabId': addedTabId };

    const unlock = await this.onTabReplacedMutex.lock();
    try {
      // get the actual tab, to check if anything else changed
      const tab = await api.tabs.get(addedTabId);
      if (tab) {
        // check for other changes too
        for (const field of
          ['title', 'url', 'favIconUrl',
            'discarded', 'frozen', 'hidden']
        ) {
          let value = tab[field];
          // clean up sloppy titles
          if ('title' === field) value = value.trim().replace(/\s+/g, ' ');
          // Map browser API's favIconUrl to our faviconUrl property for comparison
          const nodeField = (field === 'favIconUrl') ? 'faviconUrl' : field;
          // if data actually changed, add it to the outgoing message
          if (tabNode[nodeField] !== value) changes[field] = value;
        }
      }
      await tabNode.setTabFields(changes, { reason: 'onTabReplaced' });
    }
    finally { unlock(); }
  }

  onMessage (msg, sender, sendResponse) {
    if (! msg.msg) {
      warn('Tree onMessage invalid', msg);
      sendResponse({error: 'invalid msg type'});
      return;
    }
    // if message not for us, ignore it and abort
    if (! msg.msg.startsWith('tree_')) return;
    const sourceId = common.emitSourceId || globalThis.__tktstoEmitSourceId;
    if (sourceId && msg.sourceId && (msg.sourceId === sourceId)) return;

    // below here, no sendResponse() is expected
    // and we must return 'false' or nothing at all,
    // to avoid making caller think an async response is coming
    debug('Tree onMessage', msg);
    const handler = this[`${msg.msg}`];
    if (handler) {
      // actually handle the event
      //debug(`Tree: ${msg.msg}()`);
      const result = handler.bind(this)(msg, sender, sendResponse);
      if (result && ('function' === typeof result.catch)) {
        result.catch((err) => {
          error(`Tree.${msg.msg}() failed`, err, msg);
        });
      }
      // FIXME: on sync error, tree should set an error state
      //   which can be exposed to the user to let them know they should
      //   reload the view or whatever...
      //   ... or perhaps it should automatically reload the whole tree
      //   any time there's a sync error.
      return;
    }
    return error(`Tree fn not found: ${msg.msg}`);
  }

  queuePendingMove (msg) {
    if (! msg || ! msg.nodeId) return;
    this.pendingMoves.set(msg.nodeId, {
      msg: { ...msg },
      receivedAt: Date.now()
    });
  }

  async flushPendingMoves () {
    if (! this.pendingMoves.size) return;
    const now = Date.now();
    for (const [nodeId, entry] of this.pendingMoves.entries()) {
      const pendingMsg = entry.msg;
      if ((now - entry.receivedAt) > this.pendingMoveTimeoutMs) {
        error('tree_nodeMoved(): pending move timed out', pendingMsg);
        this.pendingMoves.delete(nodeId);
        continue;
      }
      const node = this.nodes[pendingMsg.nodeId];
      const destParent = this.nodes[pendingMsg.destParentId];
      if (! node || ! destParent) continue;
      pendingMsg.reason = 'tree_nodeMoved';
      await node.moveTo(destParent, pendingMsg.destIndex, pendingMsg);
      this.pendingMoves.delete(nodeId);
    }
  }

  async tree_nodeAdded (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const parentId = msg.parentId;
    const index = msg.index;
    const details = msg.node;
    const parent = this.nodes[parentId];
    //debug('tree_nodeAdded() parent', parent);
    if (! parent) {
      return error(`tree_nodeAdded(): couldn't find parent "${parentId}"`);
    }
    msg.reason = 'tree_nodeAdded';
    const newNode = await parent.addChild(index, details, msg);
    //const newNode = parent.nodes[index];
    //debug('tree_nodeAdded() newNode', newNode);
    if (! newNode) {
      return error(`tree_nodeAdded(): failed to add node "${details.id}"`);
    }
    this.nodes[newNode.id] = newNode;
    debug(`tree_nodeAdded() added "${newNode.id}" to "${parent.id}"`);
    if (! this.bkgd) await this.flushPendingMoves();
    //debug('Tree root:', this.root);
  }

  async tree_nodeDeleted (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const nodeId = msg.nodeId;
    debug('tree_nodeDeleted()', nodeId);
    let node = this.nodes[nodeId];
    if (! node) {
      // Node was already removed locally, ignore duplicate delete.
      return;
    }
    // un-cache and delete it
    delete this.nodes[nodeId];

    msg.reason = 'tree_nodeDeleted';

    //return await node.deleteSelf(msg);
    let result;
    try {
      result = await node.deleteSelf(msg);
    } catch (err) {
      error(`tree_nodeDeleted() error`, err);
    }
    return result;
  }

  async tree_nodeMoved (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    // unpack
    const nodeId = msg.nodeId;
    const destParentId = msg.destParentId;
    const destIndex = msg.destIndex;

    // find nodes
    let node = this.nodes[nodeId];
    let destParent = this.nodes[destParentId];
    if (! node || ! destParent) {
      if (! this.bkgd) {
        this.queuePendingMove(msg);
        return;
      }
      if (! node)
        return error(`tree_nodeMoved(): couldn't find node "${nodeId}"`);
      if (! destParent)
        return error(`tree_nodeMoved(): couldn't find parent "${destParentId}"`);
    }

    // move the node
    msg.reason = 'tree_nodeMoved';
    return node.moveTo(destParent, destIndex, msg);
  }

  async tree_nodeChanged (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    // unpack
    const nodeId = msg.nodeId;
    const changeType = msg.type;

    // find nodes
    const node = this.nodes[nodeId];
    if (! node) {
      return error(`tree_nodeChanged(): couldn't find node "${nodeId}"`);
    }

    // while syncing between threads,
    // tell handlers not to emit this event again
    msg.reason = 'tree_nodeChanged';

    // figure out what kind of change happened, and update it
    try {
      if ('setExpanded' === changeType) {
        return await node.setExpanded(msg.expanded, msg);
      }
      else if ('setNotes' === changeType) {
        return await node.setNotes(msg.label, msg.note, msg);
      }
      else if ('setCheckbox' === changeType) {
        return await node.setCheckbox(msg.checkbox, msg);
      }
      else if ('setTabFields' === changeType) {
        return await node.setTabFields(msg.changes, msg);
      }
      else if ('setMarked' === changeType) {
        return await node.setMarked(msg.marked, msg);
      }
      else if ('setActive' === changeType) {
        return await node.setActive(msg.active, msg);
      }
      else if ('load' === changeType) {
        return await node.load(msg);
      }
      else if ('unload' === changeType) {
        return await node.unload(msg);
      }
      else {
        return error(`tree_nodeChanged(): unsupported change type "${changeType}"`);
      }
    } catch (err) {
      error(`tree_nodeChanged(${changeType}, ${nodeId}) failed`, err, msg);
      return;
    }
  }

  async tree_refreshAll (msg, sender, sendResponse) {
    // Base implementation does nothing - TreeView overrides this to re-render
    debug('tree_refreshAll()');
  }

  async tree_windowClosed (msg, sender, sendResponse) {
    await this.treeLoaded;  // wait until tree is ready

    const nodeId = msg.nodeId;
    const windowId = msg.windowId;
    const node = this.nodes[nodeId];
    debug('tree_windowClosed()', nodeId, windowId);
    if (! node) {
      return error(`tree_windowClosed(): couldn't find node "${nodeId}"`);
    }
    if (! node.isWindow()) {
      return error(`tree_windowClosed(): not a window: "${nodeId}"`);
    }
    // un-cache and delete it (?)
    // (a closed window object may just be unloaded, not deleted)
    //delete this.nodes[nodeId];
    msg.reason = 'tree_windowClosed';
    return await node.windowClosed(msg);
  }

  // Search the entire tree and try to find a window node
  // which matches the contents of this window...
  // ... and merge its tabs into the tree.
  // Matches have a category and a score.
  // Lowest-numbered category wins, and ties are broken by score.
  // Further tie-breaking prefers the window with the most metadata,
  // so a window with a label beats one without... and further ties are
  // broken by which window occurs first in the session tree.
  async findMatchingWindow (window, excludeNodeIds) {
    // find the "needle" (realTabList) in the "haystack"
    //const realTabList = [...window.tabs];
    const realTabList = [];
    for (const realTab of window.tabs) {
      // make an object we can safely modify
      const tabCopy = { ...realTab };
      realTabList.push(tabCopy);
    }
    const haystack = [];
    const winNodeList = this.root.findNodes(
      (node) => { return node.isWindow(); }
    );
    for (const winNode of winNodeList) {
      if (excludeNodeIds && excludeNodeIds.has(winNode.id)) continue;
      const tabList = winNode.getLoadedAndUnloadedTabs();
      haystack.push({ winNode, tabList });
    }
    // evaluate each candidate to find the best one
    const bestMatch = findClosestWindowMatch(realTabList, haystack);
    // bestMatch may be null if nothing good was found
    if (bestMatch) {
      // attach the window node to the browser window
      bestMatch.winNode.windowId = window.id;
      // update the tabId and loaded / wasLoaded state of this window's tabs
      // search loaded tabs first, then wasLoaded, then unloaded
      // (to avoid attaching to an unloaded tab when a loaded tab exists)
      const tabNodeList = [];
      // loaded
      for (const tabNode of bestMatch.winNode.findNodes(
        (n) => { return n.isLoadedTab(); },
        (n) => { return (! n.isWindow()); }
      )) { tabNodeList.push(tabNode); }
      // wasLoaded
      for (const tabNode of bestMatch.winNode.findNodes(
        (n) => { return n.isWasLoadedTab(); },
        (n) => { return (! n.isWindow()); }
      )) { tabNodeList.push(tabNode); }
      // unloaded
      for (const tabNode of bestMatch.winNode.findNodes(
        (n) => { return n.isUnloadedTab(); },
        (n) => { return (! n.isWindow()); }
      )) { if (! tabNodeList.includes(tabNode)) tabNodeList.push(tabNode); }
      // now attach browser tab IDs to nodes
      for (const tabNode of tabNodeList) {
        // Duplicate URLs are common for apps like Gmail/Drive.  Prefer the
        // saved pinned state so startup pre-attachment does not swap pinned and
        // unpinned copies before the full merge pass runs.
        let realTab = realTabList.find((candidate) =>
          (! candidate.attached)
          && (tabNode.url === candidate.url)
          && (tabNode.pinned === Boolean(candidate.pinned))
        );
        if (! realTab) {
          // Fallback for older saved data or changed browser state; the later
          // merge pass will refresh pinned state and reposition if needed.
          realTab = realTabList.find((candidate) =>
            (! candidate.attached) && (tabNode.url === candidate.url)
          );
        }
        if (realTab) {
          realTab.attached = true;
          await tabNode.setTabFields({
            tabId: realTab.id,
            windowId: window.id,
            loaded: true,
            wasLoaded: false,
            pinned: Boolean(realTab.pinned)
          }, { reason: 'mergeOpenWindowsIntoTree' });
        }
        // if a "loaded" tab node wasn't found, assign it as "wasLoaded"
        if ((! realTab) && tabNode.isLoaded()) {
          await tabNode.unload({ reason: 'mergeOpenWindowsIntoTree' });
        }
      }
      return bestMatch.winNode;
    }
    return null;
  }
}


// check if two tab arrays are identical (same length, same values in order)
function tabArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url) return false;
    if (Boolean(a[i].pinned) !== Boolean(b[i].pinned)) return false;
  }
  return true;
}

function countPinnedPositionMatches(candidate, needle) {
  const limit = Math.min(candidate.length, needle.length);
  let count = 0;
  for (let i = 0; i < limit; i++) {
    if ((candidate[i].url === needle[i].url)
      && (Boolean(candidate[i].pinned) === Boolean(needle[i].pinned))) {
      count += 1;
    }
  }
  return count;
}


// check if 'sub' is a subsequence of 'arr'
function isTabSubSequence(sub, arr) {
  let subIndex = 0;
  for (let i = 0; i < arr.length && subIndex < sub.length; i++) {
    if (sub[subIndex].url === arr[i].url) {
      subIndex++;
    }
  }
  return subIndex === sub.length;
}


// check if two Tab arrays are identical (same length, same values in order)
function tabArrayIncludes(arr, value) {
  for (const item of arr)
    if (item.url === value.url) return true;
  return false;
}


// Compute a "score" for a candidate array relative to the needle array.
// Args are both [ tab1, tab2, ... ] arrays where each tab has a url.
// Values are compared by tab.url.
// Returns { category (lower is better), matchCount (higher is better) }
// Returns null if the candidate matches fewer than half the needle's values.
function getWindowCandidateScore(candidate, needle) {
  // count how many elements of needle occur in candidate
  const matchCount = needle.reduce(
    (acc, v) => acc + (tabArrayIncludes(candidate, v) ? 1 : 0),
    0);
  const minMatches = Math.ceil(needle.length / 2);
  // disqualify if fewer than half the values are present
  //if (matchCount < minMatches) return null;
  if (matchCount < 1) return null;

  // check if candidate covers all of needle
  const fullMatch = needle.every(v => tabArrayIncludes(candidate, v));
  // check if candidate is exclusively built from needle values
  const candidateIsSubset = candidate.every(v => tabArrayIncludes(needle, v));

  const pinnedPositionMatches = countPinnedPositionMatches(candidate, needle);

  // category 1: exact match
  if (tabArraysEqual(candidate, needle))
    return { category: 1, matchCount, pinnedPositionMatches };

  // category 2 or 3: candidate contains all needle elements
  if (fullMatch) {
    // if the needle appears in order in the candidate,
    // it's a superset in order
    if (isTabSubSequence(needle, candidate))
      return { category: 2, matchCount, pinnedPositionMatches };
    else
      return { category: 3, matchCount, pinnedPositionMatches };
  }

  // category 4 or 5: candidate is made up solely of needle values
  if (candidateIsSubset) {
    if (isTabSubSequence(candidate, needle))
      return { category: 4, matchCount, pinnedPositionMatches };
    else
      return { category: 5, matchCount, pinnedPositionMatches };
  }

  // otherwise, candidate is a partial match that doesn't fit a category
  return { category: 6, matchCount, pinnedPositionMatches };
}


// iterate over the haystack to choose the closest match
// needle: an array of tabs, where each tab has a tab.url
// haystack: an array of { winNode, tabList } objects
function findClosestWindowMatch(needle, haystack) {
  let bestCandidate = null;
  let bestScore = null;

  for (const candidate of haystack) {
    const score = getWindowCandidateScore(candidate.tabList, needle);
    const scoreText = score ? `${score.category}, ${score.matchCount}` : 'null';
    debug(`findClosestWindowMatch(${scoreText}): ${candidate.winNode.toLine()}`);
    // skip candidates that don't meet minimum matching criteria
    if (score === null) continue;

    // first non-null match is an automatic best score
    if (null === bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    } else {
      // lower category number wins
      if (score.category < bestScore.category) {
        bestScore = score;
        bestCandidate = candidate;
      }
      // if same category, take the candidate with more matches
      else if ((score.category === bestScore.category)
        && (score.matchCount > bestScore.matchCount)
      ) {
        bestScore = score;
        bestCandidate = candidate;
      }
      // if URLs tie, prefer the candidate whose pinned positions line up.
      else if ((score.category === bestScore.category)
        && (score.matchCount === bestScore.matchCount)
        && (score.pinnedPositionMatches > bestScore.pinnedPositionMatches)
      ) {
        bestScore = score;
        bestCandidate = candidate;
      }
      // if same category and same number of matches,
      // take the candidate with more metadata and children
      else if ((score.category === bestScore.category)
        && (score.matchCount === bestScore.matchCount)
        && (score.pinnedPositionMatches === bestScore.pinnedPositionMatches)
      ) {
        const sMeta = (bestCandidate.winNode.label ? 1 : 0)
          + (bestCandidate.winNode.note ? 1 : 0)
          + (bestCandidate.winNode.checkbox ? 1 : 0)
          + bestCandidate.winNode.countNodes();
        const cMeta = (candidate.winNode.label ? 1 : 0)
          + (candidate.winNode.note ? 1 : 0)
          + (candidate.winNode.checkbox ? 1 : 0)
          + candidate.winNode.countNodes();
        if (cMeta > sMeta) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }
    }
  }

  const line = bestCandidate ? bestCandidate.winNode.toLine() : '';
  debug(`findClosestWindowMatch() => ${bestScore}: ${line}`);
  return bestCandidate;
}


function isNewTabPage (url) {
  const prefixes = [
    // firefox, librewolf, ...
    'about:newtab',
    'about:blank',
    'about:home',
    'about://newtab',
    'about://blank',
    'about://home',
    // chrome, chromium, ...
    'chrome://newtab',
    // edge
    'edge://newtab',
    'edge://new-tab-page',
    // vivaldi
    'chrome://vivaldi-webui/startpage',
  ];
  for (const prefix of prefixes)
    if (url.startsWith(prefix)) return true;
  return false;
}
