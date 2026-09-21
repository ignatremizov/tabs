// common/tree.js: Tree class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import {
  api, isChrome, isFirefox,
  isVivaldi, isZenBrowser
} from '/api.js';

import * as common from '/common/common.js';
const {
  log, debug, warn, error, emit,
  jsonSchema, dateTupleStrings, isNewTabPage
} = common;
import { Node } from '/common/node.js';
import { Mutex } from '/common/mutex.js';
import { Config } from '/common/config.js';
import { cookieStoreKey, sameCookieStore, isContainerTab } from '/common/containers.js';
import { validateNodeGraph } from '/common/serialized-tree.js';


export class Tree {

  constructor (NodeClass) {
    if (undefined === NodeClass) NodeClass = Node;
    this.NodeClass = NodeClass;

    this.treeLoaded = new Promise((resolve, reject) => {
      this.resolveTreeLoaded = resolve;
      this.rejectTreeLoaded = reject;
    });
    // Readiness failures remain observable by awaiters without an unhandled
    // rejection when startup fails before any sidebar/event begins waiting.
    this.treeLoaded.catch(() => {});

    this.onTabCreatedMutex = new Mutex();
    this.onTabReplacedMutex = new Mutex();
    this.onMessageMutex = new Mutex();

    // don't run more than one backup simultaneously
    this.localBackupInProgress = false;

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
    this.cfg = new Config();
    this.cfgDefaults = {
      clientId: null,
      humanFriendlyBackups: false,
      localBackupLastTimeCompleted: 0,
      hideCollapsedTabs: false,
      hideCollapsedTabGroups: true,
      pinnedTabsOpenNewTabsPinnedToo: false,
      convertFromWindowWhenDroppedIntoWindow: true,
      reorderTabsOnCreate: true,
    };

    this.createRootNode();

    // fields to copy when serializing Nodes to/from dict
    this.dictable = [
      'id',
      'type',
      'windowId',
      'tabId',
      'cookieStoreId',
      'containerProfileId',
      'containerName',
      'containerColor',
      'containerIcon',
      'containerMissing',
      'restoreError',
      'nativeGroup',
      'groupId',
      'groupWindowId',
      'groupTitle',
      'groupColor',
      'groupCollapsed',
      'geometry',
      'windowState',
      'incognito',
      'label',
      'note',
      'title',
      'url',
      'bookmark',
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
      ['/', 'ratio'],
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

  async init () {
    if (this.bkgd) {
      // prevent tab reorder storms
      this.tabReorderMutex = new Mutex();

      if (isFirefox)
        this.cfg.watch('hideCollapsedTabs',
          this.onHideCollapsedTabsChanged.bind(this), 1000);
    }
    await this.cfg.init(this.cfgDefaults);
    this.reorderTabsOnCreate = this.cfg.reorderTabsOnCreate;
    this.cfg.watch('reorderTabsOnCreate', (key, newValue) => {
      this.reorderTabsOnCreate = newValue;
    });
    this.initListeners();
  }

  async runPersistenceBatch (mutator, args) {
    return await mutator(args);
  }

  initListeners () {
    if (this.isInert) return;  // detached trees shouldn't listen

    api.runtime.onMessage.addListener(
      this.onRuntimeMessage.bind(this)
    );
  }

  onRuntimeMessage (msg, sender, sendResponse) {
    const messageName = msg?.msg || 'unknown';
    const isBackgroundTreeMessage = Boolean(
      this.bkgd
      && msg?.msg?.startsWith('tree_')
    );
    const respond = (response) => {
      if ('function' !== typeof sendResponse) return;
      try {
        sendResponse(response);
      } catch (responseError) {
        warn(`Tree.onMessage(${messageName}) response failed`,
          responseError);
      }
    };
    let result;
    try {
      result = this.onMessage(msg, sender, sendResponse);
    } catch (err) {
      error(`Tree.onMessage(${messageName}) failed`, err, msg);
      if (isBackgroundTreeMessage) {
        respond({ error: String(err?.message || err) });
      }
      return isBackgroundTreeMessage || undefined;
    }

    if (isBackgroundTreeMessage) {
      Promise.resolve(result).then(async () => {
        await this.root.flushPendingPersistence?.();
      }).then(
        () => {
          respond({ result: 'ok persisted' });
        },
        (err) => {
          error(`Tree.onMessage(${messageName}) failed`, err, msg);
          respond({ error: String(err?.message || err) });
        }
      );
      // Keep the MV3 service worker and response channel alive until the
      // background TreeStore has persisted the mutation.
      return true;
    }

    if (result && ('function' === typeof result.then)) {
      result.catch((err) => {
        error(`Tree.onMessage(${messageName}) failed`, err, msg);
      });
    }
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

  async newNodeId () {
    const nextId = await emit('bkgd_newNodeId');
    //debug('Tree.newNodeId():', nextId);
    return nextId;
  }

  async loadTreeFromBkgd () {
    // TODO: get entire tree state from bkgd
    //   ... and populate this tree with that data

    // get the raw Tree data
    const nodesJson = await emit('bkgd_getTree');
    if (! nodesJson)
      return error('Tree.loadTreeFromBkgd() failed, bkgd did not send tree');

    this.replaceSerializedTree(nodesJson);
  }

  replaceSerializedTree (nodesJson) {
    const serializedNodes = JSON.parse(nodesJson);
    if ((! serializedNodes)
      || ('object' !== typeof serializedNodes)
      || Array.isArray(serializedNodes)
      || (! serializedNodes.root)
      || (! Array.isArray(serializedNodes.root.nodes))) {
      throw new TypeError(
        'Tree.loadTreeFromBkgd() failed, bkgd sent an invalid tree'
      );
    }

    // TODO: delete anything which needs deleting before restoring
    // (like removing DOM elements in Views)
    // (maybe call derived class handler?)

    // restore session from serialized data
    const numLoaded = this.rebuildNodeFromSerializedHash(
      this.root, serializedNodes);
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
          if (['tabId', 'oldTabId', 'windowId', 'marked',
            'groupId', 'groupWindowId', 'restoreError'].includes(k))
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
    if (node !== this.root) throw new Error('Reconstruction requires a complete root snapshot');
    const graph = validateNodeGraph(hash, { rootId: node.id });
    const rebuilt = Object.create(null);
    // Construct the validated model detached. No recursion, partial live tree,
    // or inherited/prototype names can enter the cache during reconstruction.
    for (const id of graph.order) {
      const record = graph.records[id];
      const parent = id === graph.rootId ? null : rebuilt[record.parent];
      const child = new this.NodeClass(this, parent);
      for (const key of this.dictable) {
        if (Object.hasOwn(record, key)) child[key] = record[key];
      }
      child.id = id;
      rebuilt[id] = child;
      if (parent) parent.nodes.push(child);
    }
    const root = rebuilt[graph.rootId];
    // Preserve the root object's presentation handles while replacing data.
    for (const key of this.dictable) node[key] = root[key];
    node.nodes = root.nodes;
    node.parent = node;
    for (const child of node.nodes) child.parent = node;
    rebuilt[node.id] = node;
    this.nodes = rebuilt;
    this.markedNodes = graph.order.filter(id => rebuilt[id].marked);
    this.pendingMoves.clear();
    return graph.order.length;
  }

  makeBackupObject (rootNode, when) {
    const obj = {};
    // TODO: actually write and publish the schema file
    obj.$schema = jsonSchema;
    if (undefined === when) when = Date.now();
    obj.metadata = {};
    obj.metadata.exportDate = Number(when);
    obj.metadata.sessionStartDate = Number(rootNode.ctime);
    // attach the client ID
    let clientId = this.cfg.clientId;
    if (! clientId) clientId = '??';
    obj.metadata.clientId = clientId;
    // attach the actual tree / node data
    obj.nodes = this.serializeNodes(true);
    return obj;
  }

  async downloadBackupNow ({ recoveryData } = {}) {
    // abort if backup already running
    if (this.localBackupInProgress) return false;
    this.localBackupInProgress = true;
    let url;
    let onProgress;
    let completionTimer;
    try {
      const recovery = typeof recoveryData === 'string';
      if (! recovery) await this.treeLoaded;

      const when = new Date();
      const whenMs = Number(when);
      // determine whether to pretty-print the data
      const prettyPrint = this.cfg.humanFriendlyBackups ? 2 : 0;
      // generate the file's raw data
      const backup = recovery ? null : this.makeBackupObject(this.root, when);
      const jsonString = recovery ? recoveryData : JSON.stringify(backup, null, prettyPrint);
      const blob = new Blob([jsonString], { type: "application/json" });
      // generate the URL to download
      if ((! this.bkgd) || (isFirefox)) {
        // simple, but only works in Firefox or in views (like the sidepanel)
        url = URL.createObjectURL(blob);
      }
      else {
        // more complex, but works in Chrome service workers:
        const buffer = await blob.arrayBuffer();
        // avoid a stack overflow from spreading a large typed array
        const binaryString = new Uint8Array(buffer)
          .reduce((acc, byte) => acc + String.fromCharCode(byte), "");
        const base64String = btoa(binaryString);
        url = `data:application/json;base64,${base64String}`;
      }
      // build a filename
      const clientId = backup?.metadata.clientId;
      const date = dateTupleStrings(when);
      const filenameRequested = recovery
        ? `tktsto-recovery.${date[0]}-${date[1]}-${date[2]}_${date[3]}-${date[4]}-${date[5]}.json`
        : `tktsto.${date[0]}-${date[1]}-${date[2]}_${date[3]}-${date[4]}-${date[5]}.${clientId}.json`;
      let filename = filenameRequested;

      // Save the file and keep this Promise pending until the browser reports
      // completion, so alarms and startup backup scheduling have a real
      // lifecycle boundary.
      log(`downloadBackupNow(): saving to "${filename}"`);
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      let finished = false;
      let downloadId;
      let pendingDeltas = [];
      const finishOnce = (succeeded, failure) => {
        if (finished) return;
        finished = true;
        if (failure) warn(`downloadBackupNow(): Download failed: ${failure}`);
        finish(succeeded);
      };
      completionTimer = setTimeout(() => {
        finishOnce(false, 'Timed out waiting for download completion');
      }, 5 * 60 * 1000);
      onProgress = (delta) => {
        //debug('Download delta', delta);
        if (undefined === downloadId) {
          pendingDeltas.push(delta);
          return;
        }
        if (delta.id !== downloadId) return;
        // filename changed
        if (delta.filename?.current) {
          // "/foo/baz.txt" or "C:\foo\baz.txt" -> "baz.txt"
          filename = delta.filename.current.split(/[/\\]+/).pop();
          if (filenameRequested !== filename) {
            log(`downloadBackupNow(): filename changed to "${filename}" from "${filenameRequested}"`);
          }
        }
        if ('complete' === delta.state?.current) {
          finishOnce(true);
        } else if (
          delta.error?.current || ('interrupted' === delta.state?.current)
        ) {
          finishOnce(
            false,
            delta.error?.current || 'Download was interrupted'
          );
        }
      };
      api.downloads.onChanged.addListener(onProgress);
      Promise.resolve(api.downloads.download({
        url,
        filename,
        saveAs: false
      })).then(
        (id) => {
          downloadId = id;
          const deltas = pendingDeltas;
          pendingDeltas = [];
          for (const delta of deltas) onProgress(delta);
        },
        (err) => finishOnce(false, err)
      );

      const succeeded = await completed;
      if (succeeded) {
        try {
          if (! recovery) await Promise.all([
            this.cfg.set('localBackupLastTimeCompleted', Date.now()),
            api.storage.local.set({ lastBackupTime: whenMs })
          ]);
        } catch (err) {
          // The file is already safely downloaded.  A bookkeeping failure
          // should not tell the user that the backup itself failed.
          warn(`downloadBackupNow(): completion timestamp failed: ${err}`);
        }
        if (this.setStatus) {
          try {
            this.setStatus(`Saved ${blob.size} bytes to "${filename}"`);
          } catch (err) {
            warn(`downloadBackupNow(): status update failed: ${err}`);
          }
        }
      }
      return succeeded;
    } catch (err) {
      warn(`downloadBackupNow(): Download failed: ${err}`);
      return false;
    } finally {
      if (onProgress) {
        api.downloads.onChanged.removeListener(onProgress);
      }
      if (completionTimer) clearTimeout(completionTimer);
      this.localBackupInProgress = false;
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (err) { }
      }
    }
  }

  getNodeByTabId (tabId, root)  {
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

  choosePreferredTabNode (nodes, preferredWindowId) {
    if (! nodes || (nodes.length < 1)) return null;
    if (1 === nodes.length) return nodes[0];
    const hasPreferredWindow = (
      (undefined !== preferredWindowId)
      && (null !== preferredWindowId)
    );
    const getScore = (node) => (
      hasPreferredWindow
        ? [
            (node.windowId === preferredWindowId) ? 1 : 0,
            node.isLoaded() ? 1 : 0,
            node.shouldUnloadNotDelete() ? 1 : 0,
            node.ctime || 0,
            node.id || ''
          ]
        : [
            node.isLoaded() ? 1 : 0,
            node.isActive() ? 1 : 0,
            ((undefined !== node.windowId)
              && (null !== node.windowId)) ? 1 : 0,
            node.shouldUnloadNotDelete() ? 1 : 0,
            node.ctime || 0,
            node.id || ''
          ]
    );
    let bestNode = nodes[0];
    let bestScore = getScore(bestNode);
    for (let nodeIndex = 1; nodeIndex < nodes.length; nodeIndex += 1) {
      const candidate = nodes[nodeIndex];
      const candidateScore = getScore(candidate);
      for (let scoreIndex = 0; scoreIndex < bestScore.length; scoreIndex += 1) {
        if (candidateScore[scoreIndex] < bestScore[scoreIndex]) break;
        if (candidateScore[scoreIndex] > bestScore[scoreIndex]) {
          bestNode = candidate;
          bestScore = candidateScore;
          break;
        }
      }
    }
    return bestNode;
  }

  buildTabBindingIndex () {
    const tabNodesById = new Map();
    const oldTabNodesById = new Map();
    const add = (map, tabId, node) => {
      if ((undefined === tabId) || (null === tabId)) return;
      if (! map.has(tabId)) map.set(tabId, []);
      map.get(tabId).push(node);
    };
    for (const node of Object.values(this.nodes)) {
      if ((! node) || node.isWindow()) continue;
      add(tabNodesById, node.tabId, node);
      add(oldTabNodesById, node.oldTabId, node);
    }
    return { tabNodesById, oldTabNodesById };
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
      const title = tab.title && tab.title.trim();
      const looksLikeHost = title
        && /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(title);
      if (title && (title.includes('/') || looksLikeHost)) {
        // firefox puts the pending URL in the title
        // but strips the protocol://
        return title;
      }
      return tab.url;
    }
    return tab.url;
  }

  browserTabToNodeDetails (tab, windowId = tab?.windowId) {
    return {
      ...(this.bkgd?.containers?.fieldsForTab(tab || {}) || (
        tab?.cookieStoreId === undefined ? {} : { cookieStoreId: tab.cookieStoreId }
      )),
      windowId,
      tabId: tab?.id,
      title: tab?.title,
      url: this.getTabPendingUrl(tab || {}),
      faviconUrl: tab?.favIconUrl,
      loaded: true,
      active: tab?.active,
      discarded: tab?.discarded,
      frozen: tab?.frozen,
      hidden: tab?.hidden,
      incognito: tab?.incognito,
      pinned: Boolean(tab?.pinned),
      atime: tab?.lastAccessed
    };
  }

  getBrowserTabChanges (node, tab, windowId = tab?.windowId) {
    const desired = this.browserTabToNodeDetails(tab, windowId);
    const changes = {};
    if ((undefined !== desired.tabId) && (node.tabId !== desired.tabId)) {
      changes.tabId = desired.tabId;
    }
    if ((undefined !== desired.windowId)
      && (node.windowId !== desired.windowId)) {
      changes.windowId = desired.windowId;
    }
    if ((undefined !== desired.title) && (node.title !== desired.title)) {
      changes.title = desired.title;
    }
    if ((undefined !== desired.url) && (node.url !== desired.url)) {
      changes.url = desired.url;
    }
    if ((undefined !== desired.faviconUrl)
      && (node.faviconUrl !== desired.faviconUrl)) {
      changes.favIconUrl = desired.faviconUrl;
    }
    if (! node.isLoaded()) changes.loaded = true;
    for (const field of [
      'active',
      'discarded',
      'frozen',
      'hidden',
      'incognito',
      'cookieStoreId',
      'containerProfileId',
      'containerName',
      'containerColor',
      'containerIcon',
      'containerMissing',
      'atime'
    ]) {
      if ((undefined !== desired[field]) && (node[field] !== desired[field])) {
        changes[field] = desired[field];
      }
    }
    if ((undefined !== tab?.pinned)
      && (node.pinned !== desired.pinned)) {
      changes.pinned = desired.pinned;
    }
    for (const field of ['containerProfileId', 'containerName',
      'containerColor', 'containerIcon', 'containerMissing']) {
      if (Object.hasOwn(desired, field) && node[field] !== desired[field]) {
        changes[field] = desired[field];
      }
    }
    return changes;
  }

  browserTabContextMatches (node, tab, trusted = false) {
    // A session-value match can upgrade pre-container records. Heuristics
    // must instead treat missing metadata as the default cookie store.
    if (trusted && ! node.cookieStoreId) {
      return node.incognito === undefined || tab.incognito === undefined
        || Boolean(node.incognito) === Boolean(tab.incognito);
    }
    if (! sameCookieStore(node, tab)) return false;
    const profile = this.bkgd?.containers?.profileId;
    if (! isContainerTab(node)) return true;
    if (node.containerProfileId && profile) return node.containerProfileId === profile;
    // Only an actual tab/session binding can establish provenance for a
    // legacy record. An imported numeric store ID alone is not an identity.
    return trusted;
  }

  tabUrlsMatch (left, right) {
    return urlsMatch(left, right);
  }

  resolveBrowserTabUrl (url) {
    return resolveBrowserTabUrl(url);
  }

  getTabUrlMatchKey (url) {
    return normalizeUrlForMatch(url);
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

  getPinnedBranch (windowNode) {
    const firstChild = windowNode && windowNode.nodes
      ? windowNode.nodes[0]
      : null;
    return firstChild && firstChild.isPinnedBranch()
      ? firstChild
      : null;
  }

  capturePinnedBranchStates (windowNodes) {
    const states = new Map();
    for (const windowNode of windowNodes) {
      if (! windowNode || states.has(windowNode)) continue;
      const pinnedBranch = this.getPinnedBranch(windowNode);
      states.set(windowNode, {
        hadPinnedBranch: Boolean(pinnedBranch),
        pinnedNodes: new Set(
          pinnedBranch
            ? pinnedBranch.getLoadedAndUnloadedTabs()
            : []
        )
      });
    }
    return states;
  }

  async syncPinnedBranchStates (previousStates, args) {
    if (! previousStates || previousStates.size === 0) return false;

    // First clear tabs which belonged to a branch that may have moved or
    // stopped being special.  Active branches below then override this with
    // their current membership, so cross-window moves write each tab once.
    const desiredPinned = new Map();
    for (const state of previousStates.values()) {
      if (! state.hadPinnedBranch) continue;
      for (const node of state.pinnedNodes) desiredPinned.set(node, false);
    }

    // Whenever a Pinned branch exists, it is authoritative for the whole
    // window: descendants are pinned and every other tab is unpinned.
    for (const windowNode of previousStates.keys()) {
      const pinnedBranch = this.getPinnedBranch(windowNode);
      if (! pinnedBranch) continue;
      for (const node of windowNode.getLoadedAndUnloadedTabs()) {
        desiredPinned.set(node, node.isChildOf(pinnedBranch));
      }
    }

    let changed = false;
    for (const [node, pinned] of desiredPinned.entries()) {
      if (await node.setPinned(pinned, {
        ...args,
        reason: 'setPinned'
      })) {
        changed = true;
      }
    }
    return changed;
  }

  getMovableLoadedTabs (windowNode, excludeNode = null) {
    const pinnedBranch = this.getPinnedBranch(windowNode);
    return windowNode.getLoadedTabs().filter((node) =>
      (node !== excludeNode)
      && (! node.pinned)
      && ((! pinnedBranch) || (! node.isChildOf(pinnedBranch)))
    );
  }

  getPinnedLoadedTabs (windowNode, excludeNode = null) {
    const pinnedBranch = this.getPinnedBranch(windowNode);
    if (pinnedBranch) {
      return pinnedBranch.getLoadedTabs().filter(
        (node) => node !== excludeNode
      );
    }
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
      const pinnedBranch = this.getPinnedBranch(windowNode);
      return {
        destParent: pinnedBranch || windowNode,
        destIndex: 0
      };
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
    if (this.getPinnedBranch(windowNode)) {
      return { destParent: windowNode, destIndex: 1 };
    }
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

  finishPendingWindowLoad (windowNode, succeeded) {
    if (this.bkgd?.finishPendingWindowLoad) {
      this.bkgd.finishPendingWindowLoad(windowNode, succeeded);
      return;
    }
    if (windowNode.pendingWindowLoadTimer) {
      clearTimeout(windowNode.pendingWindowLoadTimer);
      delete windowNode.pendingWindowLoadTimer;
    }
    windowNode.browserLoadInProgress = false;
  }

  async onWindowCreated (window, args) {
    // are we re-opening a saved window?
    let browserTabs = Array.isArray(window.tabs) ? window.tabs : [];
    let savedWindowNode = this.findPendingWindowNode(
      window.id,
      null,
      browserTabs,
      false
    );
    if ((! savedWindowNode)
      && this.bkgd?.windowsLoading?.length
      && (browserTabs.length === 0)) {
      try {
        browserTabs = await api.tabs.query({ windowId: window.id });
      } catch (err) {
        debug(`Tree.onWindowCreated(${window.id}) tab lookup failed: ${err}`);
      }
      savedWindowNode = this.findPendingWindowNode(
        window.id,
        null,
        browserTabs,
        false
      );
    }
    if (! savedWindowNode) {
      savedWindowNode = this.findPendingWindowNode(window.id);
    }
    if (savedWindowNode) {
      const pendingIndex = this.bkgd.windowsLoading.indexOf(savedWindowNode);
      if (pendingIndex !== -1) {
        this.bkgd.windowsLoading.splice(pendingIndex, 1);
      }
      debug(`Tree.onWindowCreated() loadingSavedWindow=${savedWindowNode.id}`);
    }
    // if nothing in the queue, try searching by window ID
    // TODO: unsure if this ever actually happens
    if ((! savedWindowNode)
      // special case: Firefox restarted, windowId=1, but not same window
      && ('mergeOpenWindowsIntoTree' !== args.reason)
    ) {
      const found = this.root.findNodes((node) =>
        { return node.isWindow() && (node.windowId === window.id); });
      if (found.length > 0) {
        debug('Tree.onWindowCreated() found window', found[0]);
        savedWindowNode = found[0];
      }
    }
    // are we re-opening a saved window?
    if (savedWindowNode) {
      let attached = false;
      try {
        await savedWindowNode.setTabFields({
          type: 'window',
          windowId: window.id,
          loaded: true,
          windowState: window.state,
          incognito: window.incognito,
          geometry: [window.width, window.height, window.left, window.top]
        }, { reason: args.reason });
        attached = true;
        this.finishPendingWindowLoad(savedWindowNode, true);
        // in case a parent tab with child tabs has *already* been moved
        // to this window (which caused the window to be created),
        // reorder the tabs to pull in the child tabs
        await savedWindowNode.reorderAllTabsInThisWindow();
        return savedWindowNode;
      } finally {
        this.finishPendingWindowLoad(savedWindowNode, attached);
      }
    }

    // otherwise, create a new node for this window
    const destParent = this.root;
    // TODO: maybe insert at beginning instead of end?
    //       (or after current window, in same parent?)
    const destIndex = this.root.nodes.length;
    // TODO: handle window types: normal, panel, pop-up?, ...
    const newNode = await destParent.addChild(destIndex, {
      type: 'window',
      windowId: window.id,
      loaded: true,
      windowState: window.state,
      incognito: window.incognito,
      geometry: [window.width, window.height, window.left, window.top]
    }, { reason: args.reason });
    debug('Tree.onWindowCreated() new window node', newNode);
    return newNode;
  }

  findPendingWindowNode (
    windowId,
    tabNode = null,
    browserTabs = [],
    allowSingleFallback = true
  ) {
    const queue = this.bkgd && this.bkgd.windowsLoading;
    if (! queue || (queue.length <= 0)) return null;

    let pending = queue.find((node) => node.windowId === windowId);
    if ((! pending) && tabNode) {
      const tabWindowNode = tabNode.getWindowNode(false);
      if (queue.includes(tabWindowNode)) pending = tabWindowNode;
    }
    const browserTabIds = new Set(
      (browserTabs || []).map((tab) => tab && tab.id).filter(
        (tabId) => (undefined !== tabId) && (null !== tabId)
      )
    );
    if ((! pending) && (browserTabIds.size > 0)) {
      pending = queue.find((windowNode) =>
        windowNode.findNodes(
          (node) => (! node.isWindow()) && browserTabIds.has(node.tabId),
          (node) => ! node.isWindow()
        ).length > 0
      );
    }
    if (! pending) {
      pending = queue.find((windowNode) =>
        windowNode.findNodes(
          (node) => (! node.isWindow()) && (node.windowId === windowId),
          (node) => ! node.isWindow()
        ).length > 0
      );
    }
    if ((! pending) && allowSingleFallback && (queue.length === 1)) {
      pending = queue[0];
    }
    return pending || null;
  }

  async getOrCreateWindowNodeForTabAttachment (tabNode, windowId) {
    const found = this.root.findNodes((node) =>
      node.isWindow() && (node.windowId === windowId)
    );

    // Prefer a strong pending-load match over a provisional window node.
    // onWindowCreated may have fired first while several saved windows were
    // opening, before the browser exposed enough information to identify one.
    let pending = this.findPendingWindowNode(
      windowId,
      tabNode,
      [],
      false
    );
    if (pending) {
      await pending.setTabFields({
        windowId
      }, { reason: 'onTabAttached' });
      for (const conflict of found) {
        if ((conflict === pending)
          || conflict.windowId
          || conflict.hasKids()
          || conflict.shouldUnloadNotDelete()) {
          continue;
        }
        await conflict.deleteSelf({ reason: 'emptyWindowClosed' });
      }
      return pending;
    }
    if (found.length > 0) return found[0];

    pending = this.findPendingWindowNode(windowId, tabNode);
    if (pending) {
      await pending.setTabFields({
        windowId
      }, { reason: 'onTabAttached' });
      return pending;
    }

    const windowNode = await this.root.addChild(this.root.nodes.length, {
      type: 'window',
      windowId
    }, { reason: 'onTabAttached' });
    debug('Tree.onTabAttached(new window)');
    return windowNode;
  }

  async onWindowBoundsChanged(win, winNode = null) {
    if (! winNode) winNode = this.root.getWindowId(win.id);
    // no node = no problem, because a non-browser window may be focused
    if (! winNode) return;

    function arraysEqual(a, b) {
      if ((!a) || (!b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
      return true;
    }

    // update the window geometry and stuff
    const changes = {};
    if (win.width && win.height) {
      const geometry = [ win.width, win.height, win.left, win.top ];
      if (! arraysEqual(geometry, winNode.geometry))
        changes.geometry = geometry;
    }
    if ((undefined !== win.state)
      && (win.state !== winNode.windowState))
      changes.windowState = win.state;
    if ((undefined !== win.incognito)
      && (win.incognito !== winNode.incognito))
      changes.incognito = win.incognito;
    if (0 === Object.keys(changes).length) return;  // abort if no changes
    await winNode.setTabFields(changes, { reason: 'onWindowBoundsChanged' });
  }

  async checkIfVivaldiPanel (tab) {
    // Only Vivaldi exposes side panels as tab-like objects.  Running this
    // heuristic in every Chromium browser can drop a real onCreated event when
    // tabs.query() briefly lags behind the event.
    if (! isVivaldi) return false;
    // cache results
    if (this.tabBlacklist[`${tab.id}`]) { return true; }
    // cache miss, check the long way
    let winTabList = await api.tabs.query({ windowId: tab.windowId });
    // Vivaldi lists tab.windowId as this window,
    // but doesn't list tab.id in this window's tabs.
    let found = winTabList.some(t => t.id === tab.id);
    if (! found) {
      // A real newly-created tab can take a moment to appear in query results.
      await new Promise(resolve => setTimeout(resolve, 25));
      winTabList = await api.tabs.query({ windowId: tab.windowId });
      found = winTabList.some(t => t.id === tab.id);
    }
    if (! found) {
      // Vivaldi puts sidePanel "tabs" after the regular tabs
      //if (tab.index >= winTabList.length) {
      this.tabBlacklist[`${tab.id}`] = true;
      debug('ignoring tab which looks like a Vivaldi panel', tab);
      // TODO: this.cfg.set('isVivaldi', true);
      return true;
    }
    return false;
  }

  takePendingLoadedNode (tab, tabPendingUrl) {
    const queue = this.bkgd && this.bkgd.nodesLoading;
    if (! queue || (queue.length <= 0)) return;

    const matchesTab = (node) => {
      if (! this.browserTabContextMatches(node, tab)) return false;
      if (node.browserCreateTracked) {
        return Number.isInteger(node.pendingCreatedTabId)
          && node.pendingCreatedTabId === tab.id;
      }
      const windowNode = node.getWindowNode(false);
      if (windowNode
        && (undefined !== windowNode.windowId)
        && (null !== windowNode.windowId)
        && (undefined !== tab.windowId)
        && (windowNode.windowId !== tab.windowId)) {
        return false;
      }

      const expectedUrl = node.pendingUrl || node.url;
      if ((expectedUrl === tabPendingUrl) || (expectedUrl === tab.url)) {
        return true;
      }
      if (this.tabUrlsMatch(expectedUrl, tabPendingUrl)) {
        return true;
      }
      // Firefox substitutes about:blank while opening these protected pages.
      return isFirefox
        && ('about:blank' === tab.url)
        && ['about:newtab', 'about:home'].includes(expectedUrl);
    };

    const index = queue.findIndex(matchesTab);
    if (index < 0) return;
    const [savedTabNode] = queue.splice(index, 1);
    delete savedTabNode.browserCreateTracked;
    delete savedTabNode.pendingCreatedTabId;
    if (savedTabNode.pendingLoadTimer) {
      clearTimeout(savedTabNode.pendingLoadTimer);
      delete savedTabNode.pendingLoadTimer;
    }
    debug(`Tree.onTabCreated() loadingSavedTab=${savedTabNode.id}`);
    return savedTabNode;
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

    const unlock = await this.onTabCreatedMutex.lock();
    try {
      if (isZenBrowser) {
        const tabArray = await api.tabs.query({ windowId: tab.windowId });
        if (tabArray.length > 0) {
          const oldIndex = tab.index;
          const zeroIndex = tabArray[0].index;
          tab.index = oldIndex - zeroIndex;
          debug(`onTabCreated(): Zen tab.index ${oldIndex} - ${zeroIndex} => ${tab.index}`);
          if (oldIndex < zeroIndex) {
            debug('onTabCreated(): ignoring Zen non-tab');
            return;
          }
        }
      }

      // Multiple browser events can describe the same new tab.
      const existingTabNode = this.getNodeByTabId(tab.id);
      if (existingTabNode) {
        return debug(`Tree.onTabCreated(${tab.id}): already exists`);
      }

      // figure out which URL this new tab is going to
      const tabPendingUrl = this.getTabPendingUrl(tab);

      // Explicitly-opened saved tabs are known-good browser tabs.  Match them
      // before the Vivaldi side-panel heuristic, which can briefly see an empty
      // tab query while a real tab is still being created.
      const savedTabNode = this.takePendingLoadedNode(tab, tabPendingUrl);

      // Vivaldi sends tab events for side panels, which are not usable tabs.
      if ((! savedTabNode)
        && isChrome
        && await this.checkIfVivaldiPanel(tab)) {
        return;
      }

      // if we're loading a saved tab,
      // use that node instead of making a new one
      if (savedTabNode) {
        debug(`Tree.onTabCreated(): restoring nodeId=${savedTabNode.id}`);
        try {
          // re-attach this tab to the found Node
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
          // If the browser reports the tab as still unpinned during restore,
          // keep the saved pinned state until a real pinned update or pin
          // failure lands.
          if (tab.pinned) {
            savedTabNode.pinRestorePending = false;
            savedTabNode.pinRestorePendingAt = 0;
          }
          // put the tab in the right position
          await this.bkgd?.tabGroups?.restoreTab(savedTabNode, tab);
          await savedTabNode.reorderAllTabsInThisWindow();
          return;
        } finally {
          savedTabNode.browserLoadInProgress = false;
        }
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
      const loadedTabNodes = winNode.getLoadedTabs();

      // if the tab is a blank created by the user with C-t...
      // ... make it the 1st child of the active tab
      if (tab.pinned) {
        const dest = this.getPinnedInsertDestination(winNode, tab.index);
        destParent = dest.destParent;
        destIndex = dest.destIndex;
      }
      else if (activeTabNode?.isPinned()
        && (! this.cfg.pinnedTabsOpenNewTabsPinnedToo)) {
        const dest = this.getFirstMovableInsertDestination(winNode);
        destParent = dest.destParent;
        destIndex = dest.destIndex;
      }
      else if (isNewTabPage(tabPendingUrl)) {
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
      // if a tab is opened at the far right edge, claim it
      else if (tab.index >= loadedTabNodes.length) {
        destParent = activeTabNode || winNode;
        destIndex = 0;
        debug(`Tree.onTabCreated(farRightCapture) moving new tab to the right of: "${destParent.toLine()}"`);
      }
      // if a tab is restored into the middle, place it after its browser peer
      else if (undefined !== tab.index) {
        if (0 === tab.index) destParent = winNode;
        else destParent = loadedTabNodes[tab.index - 1] || winNode;
        destIndex = 0;
        debug(`Tree.onTabCreated(tabIndex) new tab is first child of: "${destParent.toLine()}"`);
      }
      else {
        debug('Tree.onTabCreated(default) not moving new tab');
      }
    }
    // create the tree node
    const newNode = await destParent.addChild(
      destIndex,
      this.browserTabToNodeDetails(tab),
      { reason: 'onTabCreated' }
    );
    if (this.bkgd?.tabGroups?.supported) {
      await this.bkgd.tabGroups.sync();
      if (this.reorderTabsOnCreate !== false) {
        await newNode.reorderAllTabsInThisWindow();
      }
    }
    }
    finally { unlock(); }
  }

  async unloadNodeForBrowserRemoval (node, args) {
    return await node.unload(args);
  }

  async deleteNodeForBrowserRemoval (node, args, promoteKids = false) {
    if (promoteKids) return await node.deleteSelfAndPromoteKids(args);
    return await node.deleteSelf(args);
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
      tabNode.tabClosedReason = undefined;
      return await this.unloadNodeForBrowserRemoval(tabNode, {
        reason: 'onTabRemoved',
        detail: 'manualUnload'
      });
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
      return this.unloadNodeForBrowserRemoval(
        tabNode,
        { reason: 'onWindowRemoved' }
      );
    }

    // If the last tab was a boring leaf, remove it and the empty window.
    if (isWindowClosing && windowNode) {
      const tabIsBoringLeaf = (! tabNode.shouldUnloadNotDelete())
        && (! tabNode.hasKids());
      const isOnlyWindowChild = (1 === windowNode.nodes.length)
        && (windowNode.nodes[0] === tabNode);
      if (tabIsBoringLeaf && isOnlyWindowChild) {
        await this.deleteNodeForBrowserRemoval(
          tabNode,
          { reason: 'onTabRemoved' }
        );
        if (windowNode.shouldUnloadNotDelete()) {
          await this.unloadNodeForBrowserRemoval(
            windowNode,
            { reason: 'onWindowRemoved' }
          );
        } else {
          await this.deleteNodeForBrowserRemoval(
            windowNode,
            { reason: 'onTabRemoved' }
          );
        }
        return;
      }
    }
    // if tab closed only because its window is closing
    if (isWindowClosing) {
      // keep unloaded tab as part of the user's saved window
      return await this.unloadNodeForBrowserRemoval(tabNode, {
        reason: 'onWindowRemoved',
        detail: 'saveWindow'
      });
    }
    // if tab closed manually by user, but it has label/notes
    else if (tabNode.shouldUnloadNotDelete()) {
      // keep tab in tree to preserve its metadata
      return await this.unloadNodeForBrowserRemoval(tabNode, {
        reason: 'onTabRemoved',
        detail: 'hasMetadata'
      });
    }
    // if tab is boring but has kids
    else if (tabNode.hasKids()) {
      // delete the node, but keep its kids
      return await this.deleteNodeForBrowserRemoval(
        tabNode,
        {
          reason: 'onTabRemoved',
          detail: 'hasKids'
        },
        true
      );
    }
    // tab is a leaf node with no label or anything interesting
    else {
      // delete boring tabs on close
      return await this.deleteNodeForBrowserRemoval(tabNode, {
        reason: 'onTabRemoved',
        detail: 'boringLeaf'
      });
    }
  }

  async onTabActivated (windowId, tabId, runMutation) {
    // do everything we can to find the correct tab and window nodes...
    // ... but if that fails, it's almost certainly not an issue
    // (because for some reason, browsers like Vivaldi fire off this event
    //  after the tab and window are already closed, so there's nothing to do)
    let windowNode = this.root.getWindowId(windowId);
    // look up by tabId if windowId failed
    if (! windowNode) {
      const tabNode = this.getNodeByTabId(tabId);
      if (tabNode) { windowNode = tabNode.getWindowNode(); }
      //debug(`Tree.onTabActivated(${windowId}, ${tabId}):`, windowNode, tabNode);
    }
    let tries = 5;
    while ((! windowNode) && (tries > 0)) {
      // can happen when loading saved tab in saved window,
      // because onWindowCreated doesn't happen until
      // after the onTabActivated event for the first tab
      debug(`Tree.onTabActivated() waiting for windowId="${windowId}"`);
      tries --;
      // wait a few ms
      await new Promise(resolve => setTimeout(resolve, 10));
      windowNode = this.root.getWindowId(windowId);
    }
    if (! windowNode) {
      if (this.bkgd && (this.bkgd.windowsLoading.length > 0))
        return;  // not an error, just a browser quirk
      // probably not an error
      return log(`Tree.onTabActivated() can't find windowId="${windowId}"`);
    }
    await windowNode.setActiveTab(
      { reason: 'onTabActivated' },
      runMutation,
      tabId
    );
  }

  async onTabMoved (tabId, moveInfo) {
    // tab was moved within a window
    // tabId: number
    // moveInfo.fromIndex: number
    // moveInfo.toIndex: number
    // moveInfo.windowId: number
    // get the tabNode and winNode

    // Zen Browser is fucked
    let zeroIndex = 0;
    if (isZenBrowser) {
      const tabArray = await api.tabs.query( { windowId: moveInfo.windowId });
      zeroIndex = tabArray[0].index;
      moveInfo.fromIndex -= zeroIndex;
      moveInfo.toIndex -= zeroIndex;
    }

    const windowNode = this.root.getWindowId(moveInfo.windowId);
    if (! windowNode) {
      // FIXME: WTF, shouldn't happen, big error here
      return error(`Tree.onTabMoved() can't find windowId="${moveInfo.windowId}"`);
    }
    const tabNode = this.getNodeByTabId(tabId);
    debug(`Tree.onTabMoved(): ${tabNode?.toLine()}`);
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
  }

  async onTabAttached (tabId, attachInfo) {
    // tabId: number
    // attachInfo.newPosition: number
    // attachInfo.newWindowId: number
    //   (may refer to a window which doesn't exist yet)

    // Zen Browser is fucked
    if (isZenBrowser) {
      debug(`Tree.onTabAttached(Zen, ${tabId})`, attachInfo);
      let tabArray = await api.tabs.query(
          { windowId: attachInfo.newWindowId });
      // attached to new window which doesn't exist yet
      // (needs a moment to spawn the window)
      if ((! tabArray) || (0 >= tabArray.length)) {
        debug(`Tree.onTabAttached(Zen): retrying`);
        // delay is probably unnecessary, since await above already waited
        await new Promise(r => setTimeout(r, 10));  // wait 10ms
        tabArray = await api.tabs.query(
          { windowId: attachInfo.newWindowId });
      }
      if (tabArray.length > 0) {
        const zeroIndex = tabArray[0].index;
        attachInfo.newPosition -= zeroIndex;
        debug(`Tree.onTabAttached(Zen) => index=${attachInfo.newPosition}`);
      }
    }

    const newIndex = attachInfo.newPosition;
    const windowId = attachInfo.newWindowId;

    debug(`Tree.onTabAttached(tabId=${tabId}) -> windowId=${windowId}, index=${newIndex}`);

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

    // onTabAttached can precede onWindowCreated.  Use the moved tab's saved
    // ancestry to identify the right pending window when several are opening.
    const windowNode = await this.getOrCreateWindowNodeForTabAttachment(
      tabNode,
      windowId
    );

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

  async onTabUpdated (tabId, changeInfo, tab) {
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

    // dammit, Zen Browser
    if (tabId < 0) {
      debug(`Tree.onTabUpdated(${tabId}): ignoring non-tab (Zen Browser?)`);
      return;
    }

    // wait, if a tab is currently being created or replaced
    const otcUnlock = await this.onTabCreatedMutex.lock();  otcUnlock();
    const otrUnlock = await this.onTabReplacedMutex.lock();  otrUnlock();
    // Do not wait for the entire saved-tab load queue here.  Background
    // browser events are serialized: onCreated needs the same event lock
    // currently held by this update to consume its pending match.  Waiting
    // would stall both until the load timeout discards the saved identity.
    // If this update precedes its own onCreated, the fallback below attaches
    // it through onTabCreated and consumes the pending match itself.

    const tabNode = this.getNodeByTabId(tabId);

    // detect if it's a Vivaldi sidePanel, and ignore it
    if ((! tabNode) && isChrome) {
      if (await this.checkIfVivaldiPanel(tab)) return;
    }

    // Brave likes to unpin tabs before closing a window,
    // so detect that and ignore it if it happens
    if (tabNode && (false === changeInfo.pinned)) {
      // in my testing, the onTabRemoved({ isWindowClosing: true })
      // comes about 20ms after onTabUpdated({ pinned: false })
      debug('waiting to see if unpin is real or isWindowClosing');
      await new Promise(r => setTimeout(r, 50));  // wait 50ms
      if (! tabNode.isLoaded()) return;
    }

    // if tab doesn't exist, create a node for it
    if (! tabNode) {
      warn(`Tree.onTabUpdated(${tabId}): no tab found`);
      return await this.onTabCreated(tab);
    }
    else {
      debug(`Tree.onTabUpdated(${tabId}): ${tabNode.toLine()}`,
        tabNode, changeInfo);
    }

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
      if (value === undefined) continue;
      if ('title' === field) value = value.trim().replace(/\s+/g, ' ');
      // Map browser API's favIconUrl to our faviconUrl property for comparison
      const nodeField = (field === 'favIconUrl') ? 'faviconUrl' : field;
      // if data actually changed, add it to the outgoing message
      if (tabNode[nodeField] !== value) changes[field] = value;
    }
    const pinnedChanged = Object.prototype.hasOwnProperty.call(changes, 'pinned');
    const contextFields = this.bkgd?.containers?.fieldsForTab(tab) || {};
    for (const [field, value] of Object.entries(contextFields)) {
      if (tabNode[field] !== value) changes[field] = value;
    }
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

  async onMessage (msg, sender, sendResponse) {
    if (! msg?.msg) {
      warn('Tree onMessage invalid', msg);
      if ('function' === typeof sendResponse) {
        sendResponse({ error: 'invalid msg type' });
      }
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
      const unlock = await this.onMessageMutex.lock();
      try {
        await handler.bind(this)(msg, sender, sendResponse);
      }
      finally { unlock(); }
      // FIXME: on sync error, tree should set an error state
      //   which can be exposed to the user to let them know they should
      //   reload the view or whatever...
      //   ... or perhaps it should automatically reload the whole tree
      //   any time there's a sync error.
      return;
    }
    throw new Error(`Tree fn not found: ${msg.msg}`);
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
      if (pendingMsg.moveNodeOnly) {
        await node.moveNodeOnlyTo(
          destParent,
          pendingMsg.destIndex,
          { ...pendingMsg, emit: false }
        );
      } else {
        await node.moveTo(destParent, pendingMsg.destIndex, pendingMsg);
      }
      this.pendingMoves.delete(nodeId);
    }
  }

  async onHideCollapsedTabsChanged (key, newValue, oldValue) {
    if (! isFirefox) return;
    if (! this.bkgd) return;
    debug(`hideCollapsedTabs: ${newValue}`);
    // find all open windows,
    // and force them to refresh their hidden tab states
    const windowNodes = this.root.findNodes(
      (n) => n.isWindow() && n.isLoaded(),
    );
    for (const winNode of windowNodes) {
      if (! newValue) await winNode.syncTabHideState(true);
      else {
        const wasExpanded = winNode.expanded;
        winNode.expanded = true;
        await winNode.syncTabHideState();
        winNode.expanded = wasExpanded;
      }
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
      throw new Error(
        `tree_nodeAdded(): couldn't find parent "${parentId}"`
      );
    }
    if (! details?.id) {
      throw new Error('tree_nodeAdded(): node has no ID');
    }
    const existing = this.nodes[details.id];
    if (existing) {
      // runtime.sendMessage() can be retried after a response-channel
      // failure even though the first attempt committed.  Node IDs make an
      // exact retry idempotent; never insert a second object with that ID.
      if ((existing.parent === parent)
        && parent.nodes.includes(existing)) {
        return existing;
      }
      throw new Error(
        `tree_nodeAdded(): duplicate node ID "${details.id}"`
      );
    }
    msg.reason = 'tree_nodeAdded';
    const newNode = await parent.addChild(index, details, msg);
    //const newNode = parent.nodes[index];
    //debug('tree_nodeAdded() newNode', newNode);
    if (! newNode) {
      throw new Error(
        `tree_nodeAdded(): failed to add node "${details.id}"`
      );
    }
    this.nodes[newNode.id] = newNode;
    debug(`tree_nodeAdded() added "${newNode.id}" to "${parent.id}"`);
    if (! this.bkgd) await this.flushPendingMoves();
    //debug('Tree root:', this.root);
    return newNode;
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
    msg.reason = 'tree_nodeDeleted';

    let result;
    try {
      if ('promoteKids' === msg.mode) {
        result = await node.deleteSelfAndPromoteKids({
          ...msg,
          emit: false
        });
      } else {
        result = await node.deleteSelf(msg);
      }
    } catch (err) {
      error(`tree_nodeDeleted() error`, err);
      throw err;
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
        throw new Error(
          `tree_nodeMoved(): couldn't find node "${nodeId}"`
        );
      if (! destParent)
        throw new Error(
          `tree_nodeMoved(): couldn't find parent "${destParentId}"`
        );
    }

    // move the node
    msg.reason = 'tree_nodeMoved';
    if (msg.moveNodeOnly) {
      return node.moveNodeOnlyTo(
        destParent,
        destIndex,
        { ...msg, emit: false }
      );
    }
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
      // setActive(false) can get called after deletion sometimes,
      // but it's fine (like, Chrome temp windows which exist only for 1ms)
      const message = `tree_nodeChanged(${changeType}): couldn't find node "${nodeId}"`;
      if ('setActive' === changeType) return warn(message);
      throw new Error(message);
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
      else if ('promoteKids' === changeType) {
        return await this.runPersistenceBatch(
          (operationArgs) => node.promoteChildren({
            ...operationArgs,
            emit: false
          }),
          { ...msg, emit: false }
        );
      }
      else {
        throw new Error(
          `tree_nodeChanged(): unsupported change type "${changeType}"`
        );
      }
    } catch (err) {
      error(`tree_nodeChanged(${changeType}, ${nodeId}) failed`, err, msg);
      throw err;
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
    const result = {};  // data to return
    result.loadedTabNodesWithNoTab = [];
    //const realTabList = [...window.tabs];
    const realTabList = [];
    for (const realTab of window.tabs) {
      // make an object we can safely modify
      const tabCopy = { ...realTab };
      Object.assign(tabCopy, this.bkgd?.containers?.fieldsForTab(realTab) || {});
      tabCopy.url = this.getTabPendingUrl(realTab);
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
      await bestMatch.winNode.setTabFields({
        windowId: window.id
      }, { reason: 'mergeOpenWindowsIntoTree' });
      // update the tabId and loaded / wasLoaded state of this window's tabs
      // search loaded tabs first, then wasLoaded, then unloaded
      // (to avoid attaching to an unloaded tab when a loaded tab exists)
      const loadedTabNodes = [];
      const wasLoadedTabNodes = [];
      const unloadedTabNodes = [];
      for (const node of bestMatch.tabList) {
        if (node.isLoadedTab()) loadedTabNodes.push(node);
        else if (node.isWasLoadedTab()) wasLoadedTabNodes.push(node);
        else unloadedTabNodes.push(node);
      }
      const tabNodeList = [
        ...loadedTabNodes,
        ...wasLoadedTabNodes,
        ...unloadedTabNodes
      ];
      const { tabNodesById, oldTabNodesById } =
        this.buildTabBindingIndex();
      const realTabMatches = buildRealTabMatchIndex(realTabList);
      const hasBindingConflict = (targetNode, tabId) => {
        const candidates = [
          ...(tabNodesById.get(tabId) || []),
          ...(oldTabNodesById.get(tabId) || [])
        ];
        return candidates.some((node) =>
          (node !== targetNode)
          && (this.nodes[node.id] === node)
          && ((node.tabId === tabId) || (node.oldTabId === tabId))
        );
      };
      // now attach browser tab IDs to nodes
      for (const tabNode of tabNodeList) {
        // Duplicate URLs are common for apps like Gmail/Drive.  Prefer the
        // saved pinned state so startup pre-attachment does not swap pinned and
        // unpinned copies before the full merge pass runs.
        const realTab = realTabMatches.take(
          tabNode.url,
          tabNode.isPinned(),
          tabNode
        );
        if (realTab) {
          const tabArgs = { reason: 'mergeOpenWindowsIntoTree' };
          if (! hasBindingConflict(tabNode, realTab.id)) {
            // The one-time binding index proves this assignment cannot steal a
            // live ID, so avoid a full-tree uniqueness scan for every tab.
            tabArgs.ensureUniqueBindings = false;
          }
          await tabNode.setTabFields({
            ...(this.bkgd?.containers?.fieldsForTab(realTab) || {}),
            tabId: realTab.id,
            windowId: window.id,
            loaded: true,
            wasLoaded: false,
            pinned: Boolean(realTab.pinned)
          }, tabArgs);
        }
        // if a "loaded" tab node wasn't found, assign it as "wasLoaded"
        if ((! realTab) && tabNode.isLoaded()) {
          await tabNode.unload({ reason: 'mergeOpenWindowsIntoTree' });
          result.loadedTabNodesWithNoTab.push(tabNode);
        }
      }
      result.winNode = bestMatch.winNode;
      return result;
    }
    return result;
  }
}

function buildRealTabMatchIndex(tabs) {
  const exactPinned = new Map();
  const comparablePinned = new Map();
  const exact = new Map();
  const comparable = new Map();
  const add = (map, key, tab) => {
    if (! map.has(key)) map.set(key, { tabs: [], index: 0 });
    map.get(key).tabs.push(tab);
  };
  const pinnedKey = (url, pinned, context) =>
    JSON.stringify([contextUrlKey(context, url), Boolean(pinned)]);
  for (const tab of tabs) {
    const comparableUrl = normalizeUrlForMatch(tab.url);
    add(exactPinned, pinnedKey(tab.url, tab.pinned, tab), tab);
    add(comparablePinned, pinnedKey(comparableUrl, tab.pinned, tab), tab);
    add(exact, contextUrlKey(tab, tab.url), tab);
    add(comparable, contextUrlKey(tab, comparableUrl), tab);
  }
  const take = (map, key) => {
    const bucket = map.get(key);
    if (! bucket) return null;
    while ((bucket.index < bucket.tabs.length)
      && bucket.tabs[bucket.index].attached) {
      bucket.index += 1;
    }
    const tab = bucket.tabs[bucket.index];
    if (! tab) return null;
    bucket.index += 1;
    tab.attached = true;
    return tab;
  };
  return {
    take (url, pinned, context) {
      const comparableUrl = normalizeUrlForMatch(url);
      return (
        take(exactPinned, pinnedKey(url, pinned, context))
        || take(comparablePinned, pinnedKey(comparableUrl, pinned, context))
        // Fallback for older saved data or changed browser state; the later
        // merge pass refreshes pinned state and position.
        || take(exact, contextUrlKey(context, url))
        || take(comparable, contextUrlKey(context, comparableUrl))
      );
    }
  };
}


// check if two tab arrays are identical (same length, same values in order)
function tabArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url) return false;
    if (contextUrlKey(a[i], '') !== contextUrlKey(b[i], '')) return false;
    if (getPinnedState(a[i]) !== getPinnedState(b[i])) return false;
  }
  return true;
}

function countPinnedPositionMatches(candidate, needle) {
  const limit = Math.min(candidate.length, needle.length);
  let count = 0;
  for (let i = 0; i < limit; i++) {
    if (urlsMatch(candidate[i].url, needle[i].url)
      && (contextUrlKey(candidate[i], '') === contextUrlKey(needle[i], ''))
      && (getPinnedState(candidate[i]) === getPinnedState(needle[i]))) {
      count += 1;
    }
  }
  return count;
}

function countExactUrlPositionMatches(candidate, needle) {
  const limit = Math.min(candidate.length, needle.length);
  let count = 0;
  for (let i = 0; i < limit; i++) {
    if (contextUrlKey(candidate[i], candidate[i].url)
      === contextUrlKey(needle[i], needle[i].url)) count += 1;
  }
  return count;
}

function getPinnedState(item) {
  if (item && ('function' === typeof item.isPinned)) {
    return Boolean(item.isPinned());
  }
  return Boolean(item && item.pinned);
}


// check if 'sub' is a subsequence of 'arr'
function isTabSubSequence(sub, arr) {
  let subIndex = 0;
  for (let i = 0; i < arr.length && subIndex < sub.length; i++) {
    if (urlsMatch(sub[subIndex].url, arr[i].url)
      && (contextUrlKey(sub[subIndex], '') === contextUrlKey(arr[i], ''))) {
      subIndex++;
    }
  }
  return subIndex === sub.length;
}


function countTabUrls(tabs) {
  const counts = new Map();
  for (const tab of tabs) {
    const url = contextUrlKey(tab, normalizeUrlForMatch(tab.url));
    counts.set(url, (counts.get(url) || 0) + 1);
  }
  return counts;
}

function tabUrlCountsCover(containerCounts, requestedCounts) {
  for (const [url, count] of requestedCounts.entries()) {
    if ((containerCounts.get(url) || 0) < count) return false;
  }
  return true;
}

function normalizeUrlForMatch(url) {
  if (! url) return '';
  return String(resolveBrowserTabUrl(url))
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

function contextUrlKey(tab, url) {
  return JSON.stringify([
    url || '', cookieStoreKey(tab),
    isContainerTab(tab) ? (tab?.containerProfileId || '') : ''
  ]);
}

function resolveBrowserTabUrl(url) {
  if (('string' === typeof url)
    && url.startsWith('/')
    && api.runtime?.getURL) {
    return api.runtime.getURL(url);
  }
  return url;
}

function urlsMatch(left, right) {
  if (left === right) return true;
  if ((! left) || (! right)) return false;
  return normalizeUrlForMatch(left) === normalizeUrlForMatch(right);
}


// Compute a "score" for a candidate array relative to the needle array.
// Args are both [ tab1, tab2, ... ] arrays where each tab has a url.
// Values are compared by tab.url.
// Returns { category (lower is better), matchCount (higher is better) }
// Returns null if the candidate has no URL overlap with the needle.
function getWindowCandidateScore(
  candidate,
  needle,
  needleCounts = countTabUrls(needle)
) {
  // Count a candidate URL only once per occurrence.  Without multiset
  // matching, one saved Gmail tab looks like a full match for any number of
  // restored Gmail tabs and can attach the browser window to the wrong node.
  const candidateCounts = countTabUrls(candidate);
  let matchCount = 0;
  for (const [url, count] of needleCounts.entries()) {
    matchCount += Math.min(count, candidateCounts.get(url) || 0);
  }
  // Disqualify windows with no overlap at all.
  if (matchCount < 1) return null;

  // check if candidate covers all of needle
  const fullMatch = tabUrlCountsCover(candidateCounts, needleCounts);
  // check if candidate is exclusively built from needle values
  const candidateIsSubset = tabUrlCountsCover(needleCounts, candidateCounts);

  const exactUrlPositionMatches =
    countExactUrlPositionMatches(candidate, needle);
  const pinnedPositionMatches = countPinnedPositionMatches(candidate, needle);
  const score = (category) => ({
    category,
    matchCount,
    exactUrlPositionMatches,
    pinnedPositionMatches
  });

  // category 1: exact match
  if (tabArraysEqual(candidate, needle))
    return score(1);

  // category 2 or 3: candidate contains all needle elements
  if (fullMatch) {
    // if the needle appears in order in the candidate,
    // it's a superset in order
    if (isTabSubSequence(needle, candidate))
      return score(2);
    else
      return score(3);
  }

  // category 4 or 5: candidate is made up solely of needle values
  if (candidateIsSubset) {
    if (isTabSubSequence(candidate, needle))
      return score(4);
    else
      return score(5);
  }

  // otherwise, candidate is a partial match that doesn't fit a category
  return score(6);
}


// iterate over the haystack to choose the closest match
// needle: an array of tabs, where each tab has a tab.url
// haystack: an array of { winNode, tabList } objects
function findClosestWindowMatch(needle, haystack) {
  let bestCandidate = null;
  let bestScore = null;
  const needleCounts = countTabUrls(needle);
  const metadataScores = new WeakMap();
  const getMetadataScore = (candidate) => {
    const winNode = candidate.winNode;
    if (metadataScores.has(winNode)) return metadataScores.get(winNode);
    const score = (winNode.label ? 1 : 0)
      + (winNode.note ? 1 : 0)
      + (winNode.checkbox ? 1 : 0)
      + winNode.countNodes();
    metadataScores.set(winNode, score);
    return score;
  };

  for (const candidate of haystack) {
    const score = getWindowCandidateScore(
      candidate.tabList,
      needle,
      needleCounts
    );
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
        && (score.exactUrlPositionMatches
          > bestScore.exactUrlPositionMatches)
      ) {
        bestScore = score;
        bestCandidate = candidate;
      }
      // If exact URL matches tie, prefer matching pinned positions.
      else if ((score.category === bestScore.category)
        && (score.matchCount === bestScore.matchCount)
        && (score.exactUrlPositionMatches
          === bestScore.exactUrlPositionMatches)
        && (score.pinnedPositionMatches > bestScore.pinnedPositionMatches)
      ) {
        bestScore = score;
        bestCandidate = candidate;
      }
      // if same category and same number of matches,
      // take the candidate with more metadata and children
      else if ((score.category === bestScore.category)
        && (score.matchCount === bestScore.matchCount)
        && (score.exactUrlPositionMatches
          === bestScore.exactUrlPositionMatches)
        && (score.pinnedPositionMatches === bestScore.pinnedPositionMatches)
      ) {
        if (getMetadataScore(candidate) > getMetadataScore(bestCandidate)) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }
    }
  }

  const line = bestCandidate ? bestCandidate.winNode.toLine() : '';
  const scoreText = bestScore
    ? `${bestScore.category}, ${bestScore.matchCount}`
    : 'null';
  debug(`findClosestWindowMatch() => ${scoreText}: ${line}`);
  return bestCandidate;
}
