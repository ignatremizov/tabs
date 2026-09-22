// bkgd/bkgd.js: main background script
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import {
  log,
  debug,
  warn,
  error,
  fmtDate,
  emit,
  jsonSchema,
  isIllegalURL,
  sanitizeClientId
} from '/common/common.js';
import { Mutex } from '/common/mutex.js';
import { Config } from '/common/config.js';
import { IdGenerator } from '/common/id-generator.js';
import * as sidepanel from './sidepanel.js';
import { TreeStore } from './treestore.js';
import { base32encode } from '/common/base32.js';
import { createNewUserTutorialNodes } from '/bkgd/new-user.js';
import { runReconcile } from '/bkgd/reconcile.js';
import { Containers } from '/bkgd/containers.js';
import { TabGroups } from '/bkgd/tab-groups.js';
import { validateNodeGraph, nestedRecordsToHash, isRecord } from '/common/serialized-tree.js';
import { commitImportedGraph } from '/bkgd/import-tree.js';

log('/bkgd/bkgd.js running');

function buildStartupTabCandidateIndex(tree, windowNode) {
  const all = windowNode.getLoadedAndUnloadedTabs();
  const pinned = all.filter((node) => node.isPinned());
  const movable = all.filter((node) => ! node.isPinned());
  const byTabId = new Map();
  const byExactUrl = new Map();
  const byComparableUrl = new Map();
  const add = (map, key, node) => {
    if (! map.has(key)) map.set(key, []);
    map.get(key).push(node);
  };
  for (const node of all) {
    if ((undefined !== node.tabId) && (null !== node.tabId)) {
      add(byTabId, node.tabId, node);
    }
    add(byExactUrl, node.url, node);
    add(byComparableUrl, tree.getTabUrlMatchKey(node.url), node);
  }

  const available = (nodes, claimedNodeIds, pinnedState, tab, trusted = false) =>
    (nodes || []).filter((node) =>
      (! claimedNodeIds.has(node.id))
      && (! tab || tree.browserTabContextMatches(node, tab, trusted))
      && ((undefined === pinnedState)
        || (node.isPinned() === pinnedState))
    );
  const choose = (nodes, claimedNodeIds, pinnedState, tab) =>
    tree.choosePreferredTabNode(
      available(nodes, claimedNodeIds, pinnedState, tab)
  );

  return {
    findByTabId (tabId, claimedNodeIds, tab) {
      return available(byTabId.get(tabId), claimedNodeIds, undefined, tab, true)[0] || null;
    },
    findByUrl (url, pinnedState, claimedNodeIds, tab) {
      const comparableUrl = tree.getTabUrlMatchKey(url);
      return (
        choose(byExactUrl.get(url), claimedNodeIds, pinnedState, tab)
        || choose(
          byComparableUrl.get(comparableUrl),
          claimedNodeIds,
          pinnedState,
          tab
        )
        || choose(byExactUrl.get(url), claimedNodeIds, undefined, tab)
        || choose(byComparableUrl.get(comparableUrl), claimedNodeIds, undefined, tab)
      );
    },
    findFallback (pinnedState, claimedNodeIds, tab) {
      const nodes = pinnedState ? pinned : movable;
      return nodes.find((node) =>
        (! claimedNodeIds.has(node.id)) && (! node.isWindow())
        && (! tab || tree.browserTabContextMatches(node, tab))
      ) || null;
    }
  };
}

export class Bkgd {

  constructor () {
    // help event handlers wait until init is finished
    this.configLoaded = new Promise((resolve, reject) => {
      this.resolveConfigLoaded = resolve;
      this.rejectConfigLoaded = reject;
    });
    this.treeLoaded = new Promise((resolve, reject) => {
      this.resolveTreeLoaded = resolve;
      this.rejectTreeLoaded = reject;
    });
    this.configLoaded.catch(() => {});
    this.treeLoaded.catch(() => {});
    this.startupError = null;
    this.startupReady = false;
    this.backupQueued = false;

    // Queues match browser creation events to saved nodes being restored.
    // Never block browser events waiting for these queues to drain: those
    // same events are responsible for consuming their pending matches.
    // Browser callbacks can overlap at await boundaries.  Preserve their
    // observed order in memory without writing replayable position records.
    // Keep this separate from Tree.onMessageMutex so onCreated events can
    // finish tab/window loads started by a view mutation.
    this.browserMutationMutex = new Mutex();
    this.nodesLoading = [];
    this.windowsLoading = [];
    this.pendingBrowserLoadTimeoutMs = 5000;
    this.activeBrowserCreates = 0;
    this.deferredCreatedTabs = new Map();
    this.containers = new Containers(this);
    this.tabGroups = new TabGroups(this);

    // Reorder requests are debounced per browser window, then executed
    // serially because the browser tab strip APIs are shared mutable state.
    this.pendingTabReorders = new Map();
    this.tabReorderRequestMutex = new Mutex();
    this.tabReorderDebounceTime = 100;

    // runtime.sendMessage() can lose its response after the handler commits.
    // Cache mutation results by caller-generated request ID so transport
    // retries do not replay imports, tutorial generation, or tree wrapping.
    this.bkgdRequestResults = new Map();
    this.bkgdRequestResultLimit = 256;

    // internal map of treeId : TreeViewInfo,
    // tracks the port and viewType and viewScope of each open TreeView
    // so we can decide where to send global hotkey events
    // (usually send to current window, but in "Tabs Outliner mode",
    //  send to a separate window)
    this.treeViews = {};

    // local backups
    this.localBackupAlarmName = 'periodicLocalBackup';
    this.reconcileAlarmName = 'periodicReconcile';
    this.reconcileIntervalMinutes = 5;
    this.reconcileInFlight = false;

    this.cfg = new Config();
    this.cfgDefaults = {
      clientId: null,
      localBackupInterval: 0,
      localBackupLastTimeCompleted: 0,
      backupOnStartup: true,
      reconcileIntervalMinutes: 5,
    };

    // kludge because Chrome sidePanel API is missing important stuff
    // like sidePanel.isOpen()
    if (isChrome) this.chromeSidepanelIsOpen = {};
  }

  init () {
    // tell emit() that this thread is a service worker,
    // so it should only runtime.sendMessage()
    // when TreeView ports are connected
    emit.isBkgd = true;
    emit.bkgd = this;
    this.ports = [];
    // TODO: consider config to keep a long-lived port open when no views exist.

    // if I understand correctly, this needs to NOT be async,
    // because that means listeners aren't registered immediately at startup,
    // which means it misses messages until init is finished...
    // but instead, it needs to register listeners *immediately* and then
    // make them handle "waiting on init" conditions when events come in
    // (by receiving events but delaying the processing until init is done)
    this.initConnectListener();
    this.initMessageListener();
    this.initWindowListeners();
    this.initTabListeners();
    this.initContextListeners();
    this.initMiscListeners();

    // tell the browser the sidepanel can be opened via hotkey or icon click
    sidepanel.init();

    this.initialization = this.initConfig().then(async () => {
      await this.containers.init();
      this.idGen = new IdGenerator(this.cfg.clientId, 9, 2);
      this.clientId = this.cfg.clientId;
      this.cfg.watch('clientId', (key, newVal, oldVal) => {
        // always use latest clientId to generate new nodeIds
        this.idGen.name = newVal;
        this.clientId = newVal;
      });
      debug('Bkgd.resolveConfigLoaded()');
      this.resolveConfigLoaded();  // let listeners know the config is ready

      this.tree = new TreeStore(this);
      // give the tree a link to the bkgd object
      this.tree.bkgd = this;
      //  actually load the tree from storage
      return this.tree.init().then(async () => {
        this.idGen.cache = this.tree.nodes;
        // grab all the open windows and tabs, and put them in the tree
        await this.mergeOpenWindowsIntoTree();
        try { await this.tabGroups.sync(); }
        catch (err) {
          warn('Initial native tab-group snapshot unavailable', err);
          this.tabGroups.requestSync();
        }
        // and if this is the first boot, add tutorial nodes
        if (this.tree.needsTutorial) {
          await createNewUserTutorialNodes(this.tree);
        }
        await runReconcile.call(this, { reason: 'startup' });
        // tree is ready to use
        debug('Bkgd.resolveTreeLoaded()');
        this.startupReady = true;
        this.resolveTreeLoaded();  // let listeners know the tree is loaded
        this.tree.resolveTreeLoaded();
      });
    }).catch((err) => {
      this.failInitialization(err);
    });

  }

  failInitialization (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    this.startupError = failure.message;
    this.rejectConfigLoaded(failure);
    this.rejectTreeLoaded(failure);
    this.tree?.rejectTreeLoaded?.(failure);
    error('Outline initialization failed; stored records were retained', failure);
  }

  bkgd_getStartupState () {
    return { ready: this.startupReady, failure: this.startupError,
      canExport: Boolean(this.startupError && this.tree?.db?.loadRawRecords) };
  }

  async bkgd_getRecoveryData () {
    if (! this.startupError || ! this.tree?.db?.loadRawRecords) {
      throw new Error('No failed outline storage is available for recovery export');
    }
    const records = await this.tree.db.loadRawRecords();
    return { data: JSON.stringify({ format: 'tktsto-raw-recovery-v1',
      exportedAt: Date.now(), error: this.startupError, records }, null, 2) };
  }

  async applyTreeMutation (name, payload = {}) {
    if ('ensureLoaded' === name) {
      return this.ensureLoaded(payload);
    }
    if ('ensureUnloaded' === name) {
      return this.ensureUnloaded(payload);
    }
    if ('ensureMoved' === name) {
      return this.ensureMoved(payload);
    }
    if ('ensureDeleted' === name) {
      return this.ensureDeleted(payload);
    }
    throw new Error(`Unknown tree mutation: ${name}`);
  }

  async ensureLoaded (payload) {
    const node = this.tree.nodes[payload.nodeId];
    if (! node) return;
    const shouldLoad = node.isUnloadedTab() || node.isUnloadedWindow();
    if (! shouldLoad) return;
    const args = {
      reason: payload.reason || 'tree_nodeChanged',
      when: payload.when
    };
    if (undefined !== payload.discarded) args.discarded = payload.discarded;
    return await node.load(args);
  }

  async ensureUnloaded (payload) {
    const node = this.tree.nodes[payload.nodeId];
    if (! node) return;
    if ((undefined === node.tabId) && (undefined !== payload.tabId)) {
      node.tabId = payload.tabId;
    }
    if ((undefined === node.windowId) && (undefined !== payload.windowId)) {
      node.windowId = payload.windowId;
    }
    const alreadyUnloaded = (
      (! node.isLoaded())
      && (! node.tabId)
      && (! node.windowId)
      && (
        (undefined === payload.wasLoaded)
        || (node.wasLoaded === payload.wasLoaded)
      )
    );
    if (alreadyUnloaded) return;
    const args = {
      reason: payload.reason || 'tree_nodeChanged',
      when: payload.when
    };
    if (undefined !== payload.wasLoaded) args.wasLoaded = payload.wasLoaded;
    if (payload.keepTabsOnClose) {
      node.keepTabsOnClose = true;
      args.keepTabsOnClose = true;
    }
    return await node.unload(args);
  }

  async ensureMoved (payload) {
    const node = this.tree.nodes[payload.nodeId];
    const destParent = this.tree.nodes[payload.destParentId];
    if (! node || ! destParent) return;
    const args = {
      reason: payload.reason || 'tree_nodeMoved',
      when: payload.when
    };
    if (payload.openWindowOnRootMove) {
      args.openWindowOnRootMove = true;
    }
    if (payload.prevParentId) {
      args.prevParentId = payload.prevParentId;
    }
    if (payload.skipTabReorder) {
      args.skipTabReorder = true;
    }
    if (payload.moveNodeOnly) {
      // ensureMovedInBatch promotes the background copy before the final
      // move.  Preserve that atomic semantic when Node.moveTo rebroadcasts
      // the persisted result to open TreeViews.
      args.moveNodeOnly = true;
      args.nodeOnlyDestAdjusted = true;
    }

    return await this.tree.runPersistenceBatch(
      (operationArgs) => this.ensureMovedInBatch(
        payload,
        node,
        destParent,
        payload.destIndex,
        operationArgs
      ),
      args
    );
  }

  async ensureMovedInBatch (payload, node, destParent, destIndex, args) {
    const prevParentId = payload.prevParentId
      || (node.parent ? node.parent.id : null);
    let promotedChildren = false;
    if (payload.moveNodeOnly && node.hasKids()) {
      const destination = payload.nodeOnlyDestAdjusted
        ? { destParent, destIndex }
        : node.getNodeOnlyMoveDestination(destParent, destIndex);
      destParent = destination.destParent;
      destIndex = destination.destIndex;
      const promoted = await node.promoteChildren({
        ...args,
        emit: false,
        skipTabReorder: true
      });
      if ((! promoted) || node.hasKids()) {
        throw new Error(
          `ensureMoved(): could not promote every child of "${node.id}"`
        );
      }
      promotedChildren = true;
    }
    if (payload.moveNodeOnly
      && Number.isInteger(payload.browserIndex)
      && (undefined !== payload.browserWindowId)
      && this.tree.getBrowserEventTabDestination) {
      const windowNode = this.tree.root.getWindowId(payload.browserWindowId);
      if (windowNode) {
        const dest = await this.tree.getBrowserEventTabDestination(
          node,
          windowNode,
          payload.browserIndex,
          Boolean(payload.pinned)
        );
        destParent = dest.destParent;
        destIndex = dest.destIndex;
      }
    }
    if (node.parent === destParent && node.indexOf() === destIndex) {
      // Promotion alone is still a structural mutation.  There is no final
      // Node.moveTo call to broadcast it, so tell each open view to replay the
      // same atomic node-only operation.
      if (promotedChildren) {
        const moveMsg = {
          nodeId: node.id,
          destParentId: destParent.id,
          destIndex,
          moveNodeOnly: true,
          nodeOnlyDestAdjusted: true,
          when: destParent.mtime,
          prevParentId,
          actionReason: args.reason
        };
        if (args.openWindowOnRootMove) {
          moveMsg.openWindowOnRootMove = true;
        }
        await emit('tree_nodeMoved', moveMsg);
      }
      return true;
    }
    if (this.tree.applyMove) {
      return await this.tree.applyMove(
        node,
        destParent,
        destIndex,
        args
      );
    }
    return await node.moveTo(destParent, destIndex, args);
  }

  async ensureDeleted (payload) {
    const node = this.tree.nodes[payload.nodeId];
    if (! node || node.isRoot()) return;
    const args = {
      reason: payload.reason || 'tree_nodeDeleted',
      when: payload.when
    };
    if ('promoteKids' === payload.mode) {
      // The originating view and any sibling views apply the same atomic
      // message themselves.  Persist the background transition without
      // rebroadcasting per-child moves or a second delete.  Browser-originated
      // deletions have no originating view, so publish one atomic result after
      // its persistence transaction completes.
      args.emit = false;
      const changed = await node.deleteSelfAndPromoteKids(args);
      if (changed && payload.broadcastResult) {
        await emit('tree_nodeDeleted', {
          nodeId: payload.nodeId,
          mode: 'promoteKids',
          when: node.mtime,
          actionReason: args.reason
        });
      }
      return changed;
    }
    return await node.deleteSelf(args);
  }

  async runSerializedBrowserMutation (handler) {
    const unlock = await this.browserMutationMutex.lock();
    try {
      return await handler();
    } finally {
      unlock();
    }
  }

  async createTrackedSavedTab (node, create, getTab = value => value) {
    // Firefox's first onCreated/onUpdated payload can still be about:blank.
    // The creation result is the authoritative identity, including for two
    // simultaneous restores of the same URL in the same cookie store.
    node.browserCreateTracked = true;
    this.activeBrowserCreates++;
    try {
      const result = await create();
      const tab = getTab(result);
      if (tab && Number.isInteger(tab.id)) {
        node.pendingCreatedTabId = tab.id;
        this.deferredCreatedTabs.set(tab.id, tab);
      }
      return result;
    } finally {
      this.activeBrowserCreates--;
      // Do not wait inside a browser event handler for this promise. Events
      // are buffered without holding the event mutex and drained afterwards.
      await this.drainCreatedTabs();
    }
  }

  deferCreatedTab (tab) {
    if (! this.activeBrowserCreates || ! Number.isInteger(tab?.id)) return false;
    if (this.tree.getNodeByTabId(tab.id)) return false;
    this.deferredCreatedTabs.set(tab.id, tab);
    return true;
  }

  async drainCreatedTabs () {
    if (this.activeBrowserCreates || ! this.deferredCreatedTabs.size) return;
    await this.runSerializedBrowserMutation(async () => {
      while (! this.activeBrowserCreates && this.deferredCreatedTabs.size) {
        const [id] = this.deferredCreatedTabs.keys();
        this.deferredCreatedTabs.delete(id);
        let tab;
        try { tab = await api.tabs.get(id); }
        catch { continue; } // Already closed: never resurrect it.
        if (tab?.id !== id) continue;
        await this.tree.onTabCreated(tab);
      }
    });
  }

  startPendingWindowLoad (windowNode) {
    if (! windowNode || windowNode.browserLoadInProgress) return false;
    windowNode.browserLoadInProgress = true;
    windowNode.browserLoadPromise = new Promise(resolve => {
      windowNode.resolveBrowserLoad = resolve;
    });
    if (! this.windowsLoading.includes(windowNode)) {
      this.windowsLoading.push(windowNode);
    }
    windowNode.pendingWindowLoadTimer = setTimeout(() => {
      this.finishPendingWindowLoad(windowNode, false);
      warn('Pending browser window creation timed out:', windowNode);
    }, this.pendingBrowserLoadTimeoutMs);
    windowNode.pendingWindowLoadTimer.unref?.();
    return true;
  }

  finishPendingWindowLoad (windowNode, succeeded) {
    if (! windowNode) return;
    if (windowNode.pendingWindowLoadTimer) {
      clearTimeout(windowNode.pendingWindowLoadTimer);
      delete windowNode.pendingWindowLoadTimer;
    }
    const windowIndex = this.windowsLoading.indexOf(windowNode);
    if (windowIndex !== -1) this.windowsLoading.splice(windowIndex, 1);
    const resolve = windowNode.resolveBrowserLoad;
    windowNode.browserLoadInProgress = false;
    windowNode.browserLoadPromise = null;
    windowNode.resolveBrowserLoad = null;
    if (resolve) resolve(Boolean(succeeded));
  }

  async waitForPendingWindowLoad (windowNode) {
    if (! windowNode) return false;
    if (windowNode.browserLoadInProgress
      && windowNode.browserLoadPromise) {
      await windowNode.browserLoadPromise;
    }
    const hasId = (
      (undefined !== windowNode.windowId)
      && (null !== windowNode.windowId)
    );
    return windowNode.isLoaded() && hasId;
  }

  initConnectListener () {
    api.runtime.onConnect.addListener( this.onConnect.bind(this) );
  }

  addSafeListener (event, name, handler) {
    event.addListener((...args) => {
      try {
        const result = handler(...args);
        if (result && ('function' === typeof result.then)) {
          return result.then(() => undefined, (err) => {
            error(`Bkgd.${name} failed`, err);
          });
        }
        // Browser notifications do not consume our domain return values.
        // Firefox otherwise tries to structured-clone returned Node/Tree
        // objects back across its process boundary and rejects the callback.
        return undefined;
      } catch (err) {
        error(`Bkgd.${name} failed`, err);
      }
    });
  }

  initMessageListener () {
    api.runtime.onMessage.addListener( this.onMessage.bind(this) );
  }

  initMiscListeners () {
    // user clicked extension icon in the address bar area
    this.addSafeListener(
      api.action.onClicked,
      'onExtensionIconClicked',
      this.onExtensionIconClicked.bind(this)
    );

    // global hotkey "commands"
    this.addSafeListener(
      api.commands.onCommand,
      'onCommand',
      this.onCommand.bind(this)
    );

    // automatic scheduled backups
    this.initLocalBackupAlarm().catch((err) => {
      error('Bkgd.initLocalBackupAlarm failed', err);
    });
    this.addSafeListener(
      api.alarms.onAlarm,
      'onAlarm',
      this.onAlarm.bind(this)
    );
  }

  initWindowListeners () {
    // monitor for windows being opened and closed
    this.addSafeListener(
      api.windows.onCreated,
      'onWindowCreated',
      this.onWindowCreated.bind(this)
    );
    this.addSafeListener(
      api.windows.onRemoved,
      'onWindowRemoved',
      this.onWindowRemoved.bind(this)
    );
    // user changed keyboard focus to a new window
    this.addSafeListener(
      api.windows.onFocusChanged,
      'onWindowFocusChanged',
      this.onWindowFocusChanged.bind(this)
    );
    // handle window resizing
    // Firefox 128.6.0esr-1~deb12u1 gives an error that it doesn't have this,
    // even though the docs say it does
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/onBoundsChanged
    if (api.windows.onBoundsChanged)
      this.addSafeListener(
        api.windows.onBoundsChanged,
        'onWindowBoundsChanged',
        this.onWindowBoundsChanged.bind(this)
      );
  }

  initTabListeners () {
    // tabs opened and closed
    this.addSafeListener(
      api.tabs.onCreated,
      'onTabCreated',
      this.onTabCreated.bind(this)
    );
    this.addSafeListener(
      api.tabs.onRemoved,
      'onTabRemoved',
      this.onTabRemoved.bind(this)
    );
    // tab became the window's active tab
    this.addSafeListener(
      api.tabs.onActivated,
      'onTabActivated',
      this.onTabActivated.bind(this)
    );
    // tab moved within a single window
    this.addSafeListener(
      api.tabs.onMoved,
      'onTabMoved',
      this.onTabMoved.bind(this)
    );
    // tab moved from one window to another
    this.addSafeListener(
      api.tabs.onAttached,
      'onTabAttached',
      this.onTabAttached.bind(this)
    );
    api.tabs.onDetached.addListener (this.onTabDetached.bind(this) );
    // virtually anything else changed
    this.addSafeListener(
      api.tabs.onUpdated,
      'onTabUpdated',
      this.onTabUpdated.bind(this)
    );
    // not really sure when this happens or why or how
    this.addSafeListener(
      api.tabs.onReplaced,
      'onTabReplaced',
      this.onTabReplaced.bind(this)
    );
  }

  async initConfig () {
    await this.cfg.init(this.cfgDefaults);

    const sanitized = sanitizeClientId(this.cfg.clientId);
    if (! sanitized) {
      // detect first run and generate random client name
      // generate 2-digit base32 string
      let num = Math.floor(Math.random() * (32**2));
      const clientId = base32encode(num, 2);
      await this.cfg.set('clientId', clientId);
      log(`set random clientId: ${clientId}`);
    }
    else if (sanitized !== this.cfg.clientId) {
      await this.cfg.set('clientId', sanitized);
    }
    log(`clientId: ${this.cfg.clientId}`);

    // reset backup events when the interval changes
    this.cfg.watch('localBackupInterval', () => {
      this.initLocalBackupAlarm(true).catch((err) => {
        error('Bkgd.initLocalBackupAlarm reset failed', err);
      });
    });
    this.reconcileIntervalMinutes = this.cfg.reconcileIntervalMinutes;
    this.cfg.watch('reconcileIntervalMinutes', (key, newValue) => {
      this.reconcileIntervalMinutes = newValue;
      this.initReconcileAlarm(true).catch((err) => {
        error('Bkgd.initReconcileAlarm reset failed', err);
      });
    });
    await this.initReconcileAlarm(true);
  }

  initContextListeners () {
    for (const name of ['onCreated', 'onUpdated', 'onRemoved']) {
      const event = api.contextualIdentities?.[name];
      if (! event?.addListener) continue;
      this.addSafeListener(event, `contextualIdentities.${name}`, async () => {
        await this.treeLoaded;
        await this.runSerializedBrowserMutation(() => this.containers.refresh());
      });
    }
    for (const name of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
      const event = api.tabGroups?.[name];
      if (event?.addListener) {
        this.addSafeListener(event, `tabGroups.${name}`, () => this.tabGroups.requestSync());
      }
    }
  }

  async initLocalBackupAlarm (reset = false) {
    await this.configLoaded;  // this.cfg must be ready first

    const stored = await api.storage.local.get({
      lastBackupTime: 0,
      backupOnStartup: this.cfg.backupOnStartup
    });
    const alarm = await api.alarms.get(this.localBackupAlarmName);
    let interval = this.cfg.localBackupInterval;
    // 0.5 minutes is the shortest the browser allows
    const backupDisabled = (! interval) || (interval < 0.5);

    // check last backup time, and if last + interval < now, backup now
    // because sometimes alarms don't persist across browser restarts, and
    // if a user sets interval=24h but they restart daily, it may never fire
    if (! backupDisabled && (stored.backupOnStartup !== false)) {
      const lastBackupTime = Math.max(
        stored.lastBackupTime || 0,
        this.cfg.localBackupLastTimeCompleted || 0
      );
      const intervalMs = interval * 60 * 1000;
      if ((Date.now() - lastBackupTime) >= intervalMs) {
        if (! this.backupQueued) {
          this.backupQueued = true;
          this.treeLoaded.then(async () => {
            try {
              await this.tree.downloadBackupNow();
            } finally {
              this.backupQueued = false;
            }
          }).catch((err) => {
            this.backupQueued = false;
            error('Startup backup failed', err);
          });
        }
      }
    }

    debug(`Bkgd.initLocalBackupAlarm: reset=${reset} interval=${interval}, alarm=${alarm}, backupDisabled=${backupDisabled}`);

    // disable alarm if it exists and user doesn't want it
    // or if they changed the interval
    if (reset || backupDisabled) {
      if (alarm) {
        await api.alarms.clear(this.localBackupAlarmName);
        log(`${this.localBackupAlarmName} cancelled`);
      }
    }

    // we're done, if the user doesn't want backups
    if (backupDisabled) return;

    // create alarm if user wants it and it isn't scheduled yet
    if (reset || (! alarm)) {
      await api.alarms.create(this.localBackupAlarmName, {
        periodInMinutes: interval
      });
      log(`${this.localBackupAlarmName} interval set to ${interval/60} hour(s)`);
    }
  }

  async onAlarm (alarm) {
    await this.treeLoaded;
    debug(`Bkgd.onAlarm(${alarm.name})`, alarm);
    if (this.localBackupAlarmName === alarm.name) {
      debug(this.localBackupAlarmName);
      return await this.tree.downloadBackupNow();
    } else if (this.reconcileAlarmName === alarm.name) {
      return await this.runSerializedBrowserMutation(
        () => runReconcile.call(this, { reason: 'alarm' })
      );
    }
  }

  async initReconcileAlarm (reset = false) {
    const interval = this.reconcileIntervalMinutes;
    const alarm = await api.alarms.get(this.reconcileAlarmName);
    if (! interval || interval < 1) {
      if (alarm) await api.alarms.clear(this.reconcileAlarmName);
      return;
    }
    if (reset || (! alarm)) {
      await api.alarms.create(this.reconcileAlarmName, {
        periodInMinutes: interval
      });
      log(`${this.reconcileAlarmName} interval set to ${interval} minute(s)`);
    }
  }

  async onExtensionIconClicked (tab, click) {
    // middle click
    if (click && click.button === 1) {
      debug('onExtensionIconClicked(middle)');
      // TODO: add this, for browsers which support it...
      // (but it seems like only Firefox supports it)
    }
    // left click
    else {
      debug('onExtensionIconClicked(left)');
      if (isFirefox) {
        await api.sidebarAction.toggle();
      } else {
        // FIXME: sidePanel.isOpen() still doesn't exist, as of Chrome 143
        // nasty kludge, waiting on Chrome to add .isOpen()
        let isOpen = this.chromeSidepanelIsOpen[tab.windowId];
        if ('function' === typeof api.sidePanel.isOpen) {
          isOpen = await api.sidePanel.isOpen({ windowId: tab.windowId });
        }
        if (isOpen) {
          // Chrome 141+
          // (WTF, why didn't this exist until 25 releases AFTER .open())
          await api.sidePanel.close({ windowId: tab.windowId });
        } else {
          // Chrome 116+
          await api.sidePanel.open({ windowId: tab.windowId });
        }
        this.chromeSidepanelIsOpen[tab.windowId] = (! isOpen);
      }
    }
    // right click uses a totally different API
    // because the browser handles it as a context menu,
    // and gives us the option to add items to that menu
  }

  async mergeOpenWindowsIntoTree () {
    log('mergeOpenWindowsIntoTree()');
    let windows;
    try {
      windows = await api.windows.getAll({ populate: true });
    } catch (err) {
      // somehow I got firefox into a weird state
      // where it couldn't even return a list of windows...
      return error('failed to get list of windows', err);
    }

    const mergeStartedAt = Date.now();
    // Read durable browser-session identities before any numeric/URL binding
    // repair can clear or claim them. Browser IDs are reused after restart.
    const sessionWindowNodesById = new Map();
    const sessionTabNodesById = new Map();
    await Promise.all(windows.map(async window => {
      const winNode = await this.tree.getWindowNodeFromSession?.(window.id);
      if (winNode) sessionWindowNodesById.set(window.id, winNode);
      await Promise.all(window.tabs.map(async tab => {
        const node = await this.tree.getTabNodeFromSession?.(tab.id);
        if (node && this.tree.browserTabContextMatches(node, tab, true)) {
          sessionTabNodesById.set(tab.id, node);
        }
      }));
    }));
    const reservedWindowIds = new Set(
      [...sessionWindowNodesById.values()].map(node => node.id)
    );
    const reservedTabIds = new Set(
      [...sessionTabNodesById.values()].map(node => node.id)
    );
    const hasSessionTabBindings = sessionTabNodesById.size > 0;
    // attach browser windows to window nodes
    const attachedWindows = [];
    const attachedNodeIds = new Set();
    const extUrl = api.runtime.getURL
      ? api.runtime.getURL('/')
      : null;
    let delay = 500;
    const delayPerTab = 50;
    for (const window of windows) {
      debug(`Window ID: ${window.id}`);
      // Firefox session values survive restored browser IDs, so consult them
      // before stale numeric IDs or URL-based matching.
      let winNode = sessionWindowNodesById.get(window.id) || null;
      const matchedBySession = Boolean(winNode);
      // Otherwise prefer an already-loaded exact windowId match within the
      // same browser session.
      if (! winNode) {
        const numeric = this.tree.root.getWindowId(window.id);
        if (numeric && ! reservedWindowIds.has(numeric.id)) winNode = numeric;
      }
      if (winNode && attachedNodeIds.has(winNode.id)) {
        winNode = null;
      }
      if (winNode && (! matchedBySession)) {
        const hasLoadedDesc = winNode.hasLoadedTabsDeep
          ? winNode.hasLoadedTabsDeep()
          : winNode.hasLoadedTabs();
        if ((! winNode.isLoaded()) && (! hasLoadedDesc)) {
          winNode = null;
        }
      }
      // Otherwise search for a Window in the tree with matching tabs.
      let match = {
        winNode: null,
        loadedTabNodesWithNoTab: []
      };
      let matchedByContents = false;
      if (! winNode) {
        match = await this.tree.findMatchingWindow(
          window,
          new Set([...attachedNodeIds, ...reservedWindowIds]),
          { attachTabs: false }
        );
        winNode = match.winNode;
        matchedByContents = Boolean(winNode);
      }
      if (winNode) {
        // findMatchingWindow() already claimed this browser ID through
        // setTabFields(), including its uniqueness check.
        if (! matchedByContents) {
          await winNode.setTabFields(
            { windowId: window.id },
            { reason: 'mergeOpenWindowsIntoTree' }
          );
        }
        //debug('winNode before loading:', winNode.asTextBranch());
        await winNode.load({ reason: 'mergeOpenWindowsIntoTree' });
        // Reopen missing extension pages only after the tab-assignment pass
        // below has distinguished them from restored session-bound tabs.
      }
      // if nothing found, add new window node to the tree
      else {
        log(`couldn't find window ${window.id} node, making new node`);
        winNode = await this.tree.onWindowCreated(window,
          { reason: 'mergeOpenWindowsIntoTree' });
      }
      if (typeof window.focused === 'boolean') {
        await winNode.setTabFields(
          { active: window.focused },
          { reason: 'mergeOpenWindowsIntoTree' }
        );
      }
      if (this.tree.rememberWindowNode) {
        await this.tree.rememberWindowNode(winNode, window.id);
      }
      // mark this winNode as actually attached to a real window
      attachedWindows.push({ winNode, window });
      attachedNodeIds.add(winNode.id);
    }

    // remove "loaded" status from window nodes which didn't get attached
    // (also affects their 'loaded' tab nodes)
    const winNodeList = this.tree.root.findNodes(
      (n) => { return n.isWindow(); });
    for (const node of winNodeList) {
      const hasLoadedDesc = node.hasLoadedTabsDeep
        ? node.hasLoadedTabsDeep()
        : node.hasLoadedTabs();
      if ((! attachedNodeIds.has(node.id))
        && (node.isLoaded() || hasLoadedDesc)) {
        await node.unload({ reason: 'mergeOpenWindowsIntoTree' });
      }
    }

    // attach tabs now
    const claimedTabNodeIds = new Set();
    const {
      tabNodesById,
      oldTabNodesById
    } = this.tree.buildTabBindingIndex();
    const liveTabNodesById = new Map();
    // Heuristics cannot borrow a node reserved for a later session match.
    const unavailableTabNodeIds = new Set(reservedTabIds);
    const getIndexedTabNodes = (tabId) => {
      const direct = (tabNodesById.get(tabId) || []).filter((node) =>
        (this.tree.nodes[node.id] === node) && (node.tabId === tabId)
      );
      if (direct.length > 0) return direct;
      return (oldTabNodesById.get(tabId) || []).filter((node) =>
        (this.tree.nodes[node.id] === node) && (node.oldTabId === tabId)
      );
    };
    const getIndexedTabNode = (tabId) =>
      this.tree.choosePreferredTabNode(getIndexedTabNodes(tabId));
    const getIndexedBindingConflicts = (targetNode, tabId) => {
      const candidates = new Set([
        ...(tabNodesById.get(tabId) || []),
        ...(oldTabNodesById.get(tabId) || [])
      ]);
      return [...candidates].filter((node) =>
        (node !== targetNode)
        && (this.tree.nodes[node.id] === node)
        && ((node.tabId === tabId) || (node.oldTabId === tabId))
      );
    };
    for (const obj of attachedWindows) {
      const winNode = obj.winNode;
      const window = obj.window;
      const candidates = buildStartupTabCandidateIndex(this.tree, winNode);
      const rememberTabPromises = [];
      let pinnedPrefixCount = 0;
      for (const browserTab of window.tabs) {
        if (browserTab && browserTab.pinned) pinnedPrefixCount += 1;
        else break;
      }
      for (const tab of window.tabs) {
        debug(`Tab ID: ${tab.id}, URL: ${tab.url}`, tab);
        const tabUrl = this.tree.getTabPendingUrl(tab);
        const getTabDestination = (tabNode = null) => {
          // Startup merge receives browser indexes, where pinned tabs occupy a
          // fixed prefix.  Convert those indexes into the correct tree sibling
          // destination before creating or repositioning nodes.
          if (tab.pinned) {
            return this.tree.getPinnedInsertDestination(
              winNode,
              tab.index,
              tabNode
            );
          }
          const movableIndex = this.tree.browserTabIndexToMovableIndex(
            tab.index,
            pinnedPrefixCount
          );
          return this.tree.getMovableInsertDestination(
            winNode,
            movableIndex,
            tabNode
          );
        };
        // Prefer durable session identity to reused numeric IDs. Retain the
        // numeric fallback for browsers/old sessions without those identities.
        const attachedTabNode = hasSessionTabBindings ? null : getIndexedTabNode(tab.id);
        const sessionTabNode = sessionTabNodesById.get(tab.id);
        let tabNode = null;
        if (sessionTabNode
          && this.tree.browserTabContextMatches(sessionTabNode, tab, true)
          && (! claimedTabNodeIds.has(sessionTabNode.id))) {
          tabNode = sessionTabNode;
        }
        if ((! tabNode)
          && attachedTabNode
          && this.tree.browserTabContextMatches(attachedTabNode, tab, true)
          && (! unavailableTabNodeIds.has(attachedTabNode.id))
          && (attachedTabNode.getWindowNode(false) === winNode)) {
          tabNode = attachedTabNode;
        }
        if (! tabNode && ! hasSessionTabBindings) {
          tabNode = candidates.findByTabId(
            tab.id,
            unavailableTabNodeIds,
            tab
          );
        }
        if (! tabNode) {
          // Match exact URL and pinned state first, then the normalized URL,
          // before falling back to a pin-agnostic match.
          tabNode = candidates.findByUrl(
            tabUrl,
            Boolean(tab.pinned),
            unavailableTabNodeIds,
            tab
          );
        }
        if (! tabNode && ! hasSessionTabBindings) {
          // With durable session identities present, a new unmatched tab is
          // not evidence that an unrelated saved page navigated elsewhere.
          tabNode = candidates.findFallback(
            Boolean(tab.pinned),
            unavailableTabNodeIds,
            tab
          );
        }
        if ((! tabNode) && attachedTabNode
          && this.tree.browserTabContextMatches(attachedTabNode, tab, true)
          && (! unavailableTabNodeIds.has(attachedTabNode.id))) {
          tabNode = attachedTabNode;
        }
        if (tabNode) {
          claimedTabNodeIds.add(tabNode.id);
          unavailableTabNodeIds.add(tabNode.id);
          const bindingConflicts =
            getIndexedBindingConflicts(tabNode, tab.id);
          for (const conflict of bindingConflicts) {
            unavailableTabNodeIds.add(conflict.id);
          }
          const hasBindingConflict = bindingConflicts.length > 0;
          const prevWindowNode = tabNode.getWindowNode(false);
          const prevPinned = tabNode.pinned;
          const changes = this.tree.getBrowserTabChanges(
            tabNode,
            tab,
            window.id
          );
          if (hasBindingConflict && (! ('tabId' in changes))) {
            // Reasserting the same ID runs the normal uniqueness path, which
            // batches conflict cleanup with the target-node write.
            changes.tabId = tab.id;
          }
          if (Object.keys(changes).length > 0) {
            const tabArgs = { reason: 'mergeOpenWindowsIntoTree' };
            if (! hasBindingConflict) {
              tabArgs.ensureUniqueBindings = false;
            }
            await tabNode.setTabFields(changes, tabArgs);
          }
          const pinnedChanged = prevPinned !== Boolean(tab.pinned);
          const windowChanged = prevWindowNode !== winNode;
          const pinnedPrefixRepair = Boolean(tab.pinned);
          if (windowChanged || pinnedChanged || pinnedPrefixRepair) {
            const dest = getTabDestination(tabNode);
            // Repair only cross-window placement, real pin/unpin transitions,
            // and pinned prefix placement.  Startup merge must not flatten a
            // saved tree merely because browser tab order differs from the
            // tree outline.
            if ((tabNode.parent !== dest.destParent)
              || ((tabNode.indexOf() !== dest.destIndex)
                && (tabNode.indexOf() + 1 !== dest.destIndex))) {
              await tabNode.moveTo(dest.destParent, dest.destIndex, {
                reason: 'mergeOpenWindowsIntoTree',
                emit: false
              });
            }
          }
          if (this.tree.rememberTabNode) {
            rememberTabPromises.push(
              this.tree.rememberTabNode(tabNode, tab.id)
            );
          }
          liveTabNodesById.set(tab.id, tabNode);
          continue;
        }
        // if not, add new tab to the tree
        let dest = getTabDestination();
        let destParent = dest.destParent;
        let destIndex = dest.destIndex;
        if ((! tab.pinned) && tab.openerTabId && (tab.openerTabId !== tab.id)) {
          let openerNode = liveTabNodesById.get(tab.openerTabId);
          if (! openerNode) {
            const found = getIndexedTabNodes(tab.openerTabId);
            const claimed = found.filter(
              (node) => claimedTabNodeIds.has(node.id)
            );
            const sameWindow = found.filter(
              (node) => node.getWindowNode(false) === winNode
            );
            openerNode = this.tree.choosePreferredTabNode(
              claimed.length > 0
                ? claimed
                : (sameWindow.length > 0 ? sameWindow : found)
            );
          }
          if (openerNode) {
            destParent = openerNode;
            destIndex = destParent.nodes.length;
          } else {
            warn(`tab ${tab.id} has openerTabId ${tab.openerTabId} but no parent found`);
          }
        }
        const newTabNode = await destParent.addChild(
          destIndex,
          {
            ...this.tree.browserTabToNodeDetails(tab, window.id),
            wasLoaded: false
          },
          { reason: 'mergeOpenWindowsIntoTree' }
        );
        claimedTabNodeIds.add(newTabNode.id);
        unavailableTabNodeIds.add(newTabNode.id);
        liveTabNodesById.set(tab.id, newTabNode);
        if (this.tree.rememberTabNode) {
          rememberTabPromises.push(
            this.tree.rememberTabNode(newTabNode, tab.id)
          );
        }
      }
      await Promise.all(rememberTabPromises);

      // remove stale "active" status if it exists
      // (happens when extension page is active and extension restarted,
      //  because the page gets closed while extension isn't running)
      await winNode.setActiveTab({ reason: 'mergeOpenWindowsIntoTree' });

      // Session identity matching can bypass the URL matcher, so explicitly
      // clear stale loaded bindings here too.  Reopen internal extension pages
      // afterward because browsers close them while an extension restarts.
      const extensionPagesToReload = [];
      for (const node of winNode.getLoadedTabs()) {
        if (claimedTabNodeIds.has(node.id)) continue;
        await node.unload({ reason: 'mergeOpenWindowsIntoTree' });
        if (extUrl && node.url?.startsWith(extUrl)) {
          extensionPagesToReload.push(node);
        }
      }
      if (extensionPagesToReload.length > 0) {
        const deferredLoad = async () => {
          for (const node of extensionPagesToReload) {
            await node.load({ reason: 'restoreLoadedTab' });
            await new Promise(resolve => setTimeout(resolve, delayPerTab));
          }
        };
        setTimeout(() => {
          deferredLoad().catch((err) => {
            error('Deferred extension-page reload failed', err);
          });
        }, delay);
        delay += (delayPerTab + 10) * extensionPagesToReload.length;
      }
    }

    debug(
      `mergeOpenWindowsIntoTree(): ${Date.now() - mergeStartedAt}ms`
    );
    log('mergeOpenWindowsIntoTree() done');
  }

  async onWindowCreated (window, args) {
    // add new window to the tree
    // (note: window.id may have already been created by a prior event,
    //  so we need to search for it and attach to that node if it exists)
    debug(`bkgd.onWindowCreated: ID ${window.id}`, window);
    if (! args) args = {};
    if (! args.reason) args.reason = 'onWindowCreated';
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(
      () => this.tree.onWindowCreated(window, args)
    );
  }

  async onWindowRemoved (windowId) {
    log(`bkgd.onWindowRemoved: ID ${windowId}`);
    // TODO: detect whether window was closed by user or by us
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      if (this.tree && this.tree.windowsClosing) {
        this.tree.windowsClosing.add(windowId);
        setTimeout(() => {
          this.tree.windowsClosing.delete(windowId);
        }, 2000);
      }
      const node = this.tree.root.getWindowId(windowId);
      if (node) {
        debug('bkgd.onWindowRemoved(): found window node', windowId, node);
        return await node.windowClosed({ reason: 'onWindowRemoved' });
      }
      debug('bkgd.onWindowRemoved(): no window node found', windowId);
    });
  }

  async onWindowFocusChanged (windowId) {
    debug(`bkgd.onWindowFocusChanged(${windowId})`);
    // WINDOW_ID_NONE means the browser application lost OS focus.  Keep the
    // most recently focused browser window active so session views do not
    // collapse merely because the user Alt+Tabbed to another application.
    if ((! Number.isInteger(windowId)) || (windowId < 0)) return;
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      let focusedNode = null;
      if (windowId >= 0) {
        focusedNode = this.tree.root.getWindowId(windowId);
      }
      if (focusedNode) {
        // update the window geometry and stuff
        // (because Firefox has no onWindowBoundsChanged event, apparently)
        // (so this is a workaround for that)
        let win;
        try { win = await api.windows.get(windowId); } catch (err) { }
        if (win) await this.tree.onWindowBoundsChanged(win, focusedNode);
      }
      const now = Date.now();
      const windowNodes = this.tree.root.findNodes(
        (node) => node.isWindow()
          && ((undefined !== node.windowId)
            || (node.mtime > (now - 3000)))
      );
      for (const node of windowNodes) {
        const shouldBeActive = Boolean(focusedNode && (node === focusedNode));
        if ((node.active !== shouldBeActive) || (! node.isLoaded())) {
          await node.setActive(shouldBeActive, {
            reason: 'onWindowFocusChanged',
            focusedNodeId: focusedNode?.id,
            onWindowRemoved: ! node.isLoaded()
          });
        }
      }
      // no node = no problem, because a non-browser window may be focused
    });
  }

  async onWindowBoundsChanged (win) {
    debug('bkgd.onWindowBoundsChanged', win);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(
      () => this.tree.onWindowBoundsChanged(win)
    );
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
    debug(`bkgd.onTabCreated(${tab.id}): ${tab.url} : ${tab.title}`, tab);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(() => {
      if (this.deferCreatedTab(tab)) return;
      return this.tree.onTabCreated(tab);
    });
  }

  async onTabRemoved (tabId, removeInfo) {
    // tabId: number
    // removeInfo.isWindowClosing: boolean
    // removeInfo.windowId: number
    debug(`bkgd.onTabRemoved(tabId=${tabId}, windowId=${removeInfo.windowId}, isWindowClosing=${removeInfo.isWindowClosing})`);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      const result = await this.tree.onTabRemoved(tabId, removeInfo);
      this.tabGroups.requestSync();
      return result;
    });
  }

  async onTabActivated (activeInfo) {
    // activeInfo.tabId: number
    // activeInfo.windowId: number
    debug(`bkgd.onTabActivated(tabId=${activeInfo.tabId}, windowId=${activeInfo.windowId})`);
    await this.treeLoaded;
    return await this.tree.onTabActivated(
      activeInfo.windowId,
      activeInfo.tabId,
      (handler) => this.runSerializedBrowserMutation(handler)
    );
  }

  async onTabMoved (tabId, moveInfo) {
    // tab was moved within a window
    // tabId: number
    // moveInfo.fromIndex: number
    // moveInfo.toIndex: number
    // moveInfo.windowId: number
    debug(`bkgd.onTabMoved(tabId=${tabId}, windowId=${moveInfo.windowId}): ${moveInfo.fromIndex} -> ${moveInfo.toIndex}`);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      if (this.tabReorderInProgress && (! this.tabReorderStalled)) {
        return debug(
          'bkgd.onTabMoved ignored (tabReorderInProgress)'
        );
      }
      if (await this.tabGroups.isWholeGroupMove(tabId)) {
        this.tabGroups.requestSync();
        return;
      }
      const result = await this.tree.onTabMoved(tabId, moveInfo);
      this.tabGroups.requestSync();
      return result;
    });
  }

  async onTabAttached (tabId, attachInfo) {
    // tabId: number
    // attachInfo.newPosition: number
    // attachInfo.newWindowId: number
    //   (may refer to a window which doesn't exist yet)
    debug(`bkgd.onTabAttached(tabId=${tabId}, windowId=${attachInfo.newWindowId}, ${attachInfo.newPosition})`);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      if (this.tabReorderInProgress) {
        this.onTabAttachedRequested = true;
        return debug(
          'bkgd.onTabAttached ignored (tabReorderInProgress)'
        );
      }
      if (await this.tabGroups.isWholeGroupMove(tabId)) {
        await this.tabGroups.sync();
        return;
      }
      const result = await this.tree.onTabAttached(tabId, attachInfo);
      this.tabGroups.requestSync();
      return result;
    });
  }

  onTabDetached (tabId, detachInfo) {
    // tabId: number
    // detachInfo.oldPosition: number
    // detachInfo.oldWindowId: number
    debug(`bkgd.onTabDetached(tabId=${tabId}, windowId=${detachInfo.oldWindowId}, ${detachInfo.oldPosition})`);
    // blank, on purpose
    // we don't really need to do anything here
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
    debug(`bkgd.onTabUpdated(tabId=${tabId})`, changeInfo, tab);
    await this.treeLoaded;
    return await this.runSerializedBrowserMutation(async () => {
      if (this.deferCreatedTab(tab)) return;
      const result = await this.tree.onTabUpdated(tabId, changeInfo, tab);
      if ('groupId' in changeInfo || 'pinned' in changeInfo) this.tabGroups.requestSync();
      return result;
    });
  }

  async onTabReplaced (addedTabId, removedTabId) {
    // "Fired when a tab is replaced with another tab due to prerendering or instant."
    // addedTabId: number
    // removedTabId: number
    debug(`bkgd.onTabReplaced(addedTabId=${addedTabId}, removedTabId=${removedTabId})`);
    await this.treeLoaded;
    // this apparently only happens in chrome,
    // and only in some circumstances which are almost entirely undocumented
    // so I'm not sure how to even make it happen
    // If I understand correctly, it's stuff like... you start typing into
    // the address bar with "instant search" enabled, and it pre-fetches
    // and pre-renders some pages, and then when you click on one,
    // it replaces the current tab?
    // I'll probably have to install a whole separate browser just to find
    // one which actually supports this feature, since all the browsers I
    // use either block it or don't implement it at all.
    return await this.runSerializedBrowserMutation(
      () => this.tree.onTabReplaced(addedTabId, removedTabId)
    );
  }

  onConnect (port) {
    // keep a list of connected TreeView instances
    this.ports.push(port);
    //debug('ports', this.ports);

    // handle posted messages
    port.onMessage.addListener((msg) => { this.onPortMessage(port, msg); });

    // delete associated TreeView on disconnect
    port.onDisconnect.addListener(() => {
      debug('bkgd_portDisconnect()', port);
      //debug('treeViews[]:', this.treeViews);
      for (const treeId of Object.keys({ ...this.treeViews })) {
        const tv = this.treeViews[treeId];
        if (tv?.port === port) {
          debug(`disconnect TreeView ${treeId}`);
          delete this.treeViews[treeId];
          //debug('treeViews[]:', this.treeViews);
        }
      }
      this.ports = this.ports.filter(p => p !== port);
    });
  }

  onPortMessage (port, msg) {
    //debug(`Bkgd.onPortMessage(${msg.msg})`, msg, port);
    // there is only one message type expected
    if ('bkgdPort_registerTreeView' === msg?.msg) {
      // save the ID so we can tell which one disconnected later
      this.bkgdPort_registerTreeView(msg);
      if (msg.treeId) {
        const tv = this.treeViews[msg.treeId];
        if (tv) tv.port = port;
      }
    }
  }

  onMessage (msg, sender, sendResponse) {
    // reject broken messages
    if (! msg?.msg) {
      const err = 'bkgd onMessage: invalid msg type';
      warn(err, msg);
      if ('function' === typeof sendResponse) sendResponse({ error: err });
      return;
    }
    // if message is for someone else, ignore it and abort
    if (! msg.msg.startsWith('bkgd_')) return;

    // onMessage handlers can't be async,
    // because async functions return a Promise
    // and then the message channel gets closed before calling sendResponse()
    // so instead we return true to keep the channel open,
    // and invoke the real handler, which can take as much time as it needs

    // call async handler synchronously
    this.onBkgdMessage(msg, sender, sendResponse).catch((err) => {
      const detail = err && err.message ? err.message : String(err);
      error(`Bkgd.onMessage(${msg.msg}) failed: ${detail}`, err);
      if ('function' === typeof sendResponse) {
        try {
          sendResponse({
            error: `Bkgd.onMessage(${msg.msg}) failed: ${detail}`
          });
        } catch (responseError) {
          warn(`Bkgd.onMessage(${msg.msg}) response failed: ${responseError}`);
        }
      }
    });
    // "claim" this message, indicating we'll respond async,
    // and keep the message channel open
    // (but if we don't respond within a few seconds,
    //  it'll generate an error, so there is a time limit)
    return true;
  }

  async onBkgdMessage (msg, sender, sendResponse) {
    if (msg && ('bkgd_ping' !== msg.msg))
      debug('bkgd onMessage', msg);
    // look up the appropriate message handler
    const handler = this[`${msg.msg}`];
    if (handler) {
      //await this.configLoaded;  // wait for config to finish loading
      // actually handle the event
      //debug(`bkgd: ${msg.msg}()`);
      const requestKey = this.getBkgdRequestKey(msg);
      let resultPromise = requestKey
        ? this.bkgdRequestResults.get(requestKey)
        : null;
      if (! resultPromise) {
        resultPromise = Promise.resolve().then(
          () => handler.bind(this)(msg, sender)
        );
        if (requestKey) {
          const limit = Math.max(1, this.bkgdRequestResultLimit || 1);
          while (this.bkgdRequestResults.size >= limit) {
            const oldest = this.bkgdRequestResults.keys().next().value;
            this.bkgdRequestResults.delete(oldest);
          }
          this.bkgdRequestResults.set(requestKey, resultPromise);
        }
      }
      let result;
      try {
        result = await resultPromise;
      } catch (err) {
        // A cached rejection must not make a later explicit retry fail forever.
        if (requestKey && this.bkgdRequestResults.get(requestKey) === resultPromise) {
          this.bkgdRequestResults.delete(requestKey);
        }
        throw err;
      }
      if (result?.error && requestKey) this.bkgdRequestResults.delete(requestKey);
      // Retain a completed operation's cached result if only this final
      // durability check fails. Retrying must flush, not replay the operation.
      if (requestKey && ! result?.error) await this.tree?.root?.flushPendingPersistence?.();
      //debug('bkgd sendResponse:', result);
      sendResponse(result);
      return;
    }
    // if no handler found, send an error
    // because we promised to send a response, so now it's mandatory
    // and if we don't, the caller's "emit()" will retry
    const err = `bkgd fn not found: ${msg.msg}`;
    sendResponse({ error: err });
    return error(err);
  }

  getBkgdRequestKey (msg) {
    if (! msg?.sourceId || ! msg?.requestId) return null;
    // These requests are read-only or naturally repeatable, and getTree may
    // contain megabytes of data which should not be retained in the cache.
    if (['bkgd_ping', 'bkgd_getTree', 'bkgd_focusWindow',
      'bkgd_getPersistenceState', 'bkgd_retryPersistence',
      'bkgd_getStartupState', 'bkgd_getRecoveryData'].includes(msg.msg)) {
      return null;
    }
    return `${msg.sourceId}\u0000${msg.requestId}\u0000${msg.msg}`;
  }

  bkgd_ping (msg, sender) {
    queueMicrotask(() => {
      try {
        this.bkgdPort_registerTreeView(msg, sender);
        this.pruneDeadTreeViews();
      } catch (err) {
        error('bkgd_ping registration failed', err);
      }
    });
    return Date.now();
  }

  bkgdPort_registerTreeView (msg, sender) {
    //debug('bkgdPort_registerTreeView()', msg, sender);
    // data:
    //   msg.treeId
    //   msg.windowId
    //   msg.viewScope ('session' or 'window')
    //   msg.viewType ('tab' or 'sidepanel')
    //   sender?.documentId?
    //   sender?.tab?.id
    //   ? lastPingTime
    const key = msg.treeId;
    if (! key) return warn('no treeId', msg, sender);
    let oldValue = this.treeViews[key];
    if (! oldValue) oldValue = {};
    const value = { ...oldValue, ...msg, lastPing: Date.now() };
    if (sender?.tab?.id) value.tabId = sender.tab.id;
    if (! this.treeViews[key])
      debug(`registered TreeView ${value.treeId} (${value.viewScope} ${value.viewType})`);
    this.treeViews[key] = value;
  }

  pruneDeadTreeViews () {
    const cutoff = Date.now() - (20 * 1000);  // 20 seconds ago
    for (const treeId of Object.keys({ ...this.treeViews })) {
      const data = this.treeViews[treeId];
      if (data.lastPing < cutoff) {
        debug(`pruning TreeView ${treeId}`);
        delete this.treeViews[treeId];
      }
    }
    //debug('treeViews[]:', this.treeViews);
  }

  async bkgd_newNodeId (msg) {
    //debug('bkgd_newNodeId()', msg);
    await this.configLoaded;  // wait for config to finish loading
    const newId = this.idGen.newId();
    //debug(`bkgd_newNodeId() => "${newId}"`);
    return newId;
  }

  async bkgd_setClientId (msg) {
    await this.configLoaded;  // wait for config to finish loading
    const clientId = sanitizeClientId(msg.clientId);
    if (! clientId) {
      warn('bkgd_setClientId(): invalid clientId', msg.clientId);
      return { error: 'Invalid clientId' };
    }
    this.clientId = clientId;
    this.idGen.name = this.clientId;
    await this.cfg.set('clientId', this.clientId);
    return { clientId: this.clientId };
  }

  async bkgd_getTree (msg) {
    await this.treeLoaded;  // ensure tree is loaded before sending it
    // Do not overtake an earlier view mutation awaiting persistence/native APIs.
    const unlock = await this.tree.onMessageMutex.lock();
    try { return JSON.stringify(this.tree.serializeNodes()); }
    finally { unlock(); }
  }

  bkgd_getPersistenceState () {
    return { state: this.tree?.root?.getPersistenceState?.() || { unsaved: false, pending: 0 } };
  }

  async bkgd_retryPersistence () {
    await this.treeLoaded;
    await this.tree.root.flushPendingPersistence();
    return this.bkgd_getPersistenceState();
  }

  publishPersistenceState (state) {
    emit('tree_persistenceState', { state }, { retry: false }).catch(err => {
      debug('Persistence warning delivery failed', err);
    });
  }

  async bkgd_generateTutorial (msg) {
    await this.treeLoaded;
    let parentNode = this.tree.root;
    if (msg.parentId) parentNode = this.tree.nodes[msg.parentId];
    await createNewUserTutorialNodes(this.tree, parentNode);
    return {};
  }

  async bkgd_loadSavedNode (msg) {
    await this.treeLoaded;  // ensure tree is loaded
    const response = {};
    let node = this.tree.nodes[msg.nodeId];
    if (! node) {
      const err = `bkgd_loadSavedNode(): no node found: "${msg.nodeId}"`;
      error(err);
      return { error: err };
    }
    // if already loaded, do nothing
    if (node.isLoaded()) { return response; }
    // - if unloaded window node... grab all "wasLoaded" items and load them?
    if (node.isWindow()) {
      // TODO: is handled in Node.load()
      //   so no need to handle it here
    }
    // some browsers block some types of URLs
    if (isIllegalURL(node.url)) {
      response.result = `Error: Can't load forbidden URL: ${node.url}`;
      return response;
    }
    if (node.browserLoadInProgress) {
      response.result = 'ok pending';
      return response;
    }
    let cookieStoreId;
    try {
      // Validate BEFORE opening a window or loading the URL. Both Firefox
      // creation APIs accept cookieStoreId; no default-container detour.
      cookieStoreId = await this.containers.validateRestore(node, node.getWindowNode(false));
      if (node.restoreError) {
        await node.setTabFields({ restoreError: undefined }, { reason: 'browserContext' });
      }
    } catch (err) {
      const message = String(err?.message || err);
      await node.setTabFields({ restoreError: message }, { reason: 'browserContext' });
      return { error: message, result: `Error: ${message}` };
    }
    // Two callers can overlap while validating the identity above.
    if (node.browserLoadInProgress || node.isLoaded()) return { result: 'ok pending' };
    node.pendingNativeGroupNodeId = node.getNativeGroupNode()?.id;
    node.browserLoadInProgress = true;
    // - otherwise...
    // - get the parent window Node
    let windowNode = node.getWindowNode(false);
    // - if no window node, make one
    if (! windowNode) {
      try {
        const config = await api.storage.local.get({
          openWindowOnRootLoadTopmost: false
        });
        let wrapNode = node.getNativeGroupNode() || node;
        if (config.openWindowOnRootLoadTopmost) {
          while (wrapNode.parent
            && (! wrapNode.parent.isRoot())
            && (! wrapNode.parent.isWindow())) {
            wrapNode = wrapNode.parent;
          }
        }
        // get parent and node index
        const parentNode = wrapNode.parent;
        // insert new window node in place of current node
        windowNode = await parentNode.addChild(wrapNode.indexOf(),
          { type: 'window', incognito: cookieStoreId === 'firefox-private' || node.isIncognito() },
          { reason: 'bkgd_loadSavedNode:autoWindow' });
        // move current node as child of window node
        await this.applyTreeMutation('ensureMoved', {
          nodeId: wrapNode.id,
          destParentId: windowNode.id,
          destIndex: 0,
          reason: 'bkgd_loadSavedNode:autoWindow',
          prevParentId: parentNode ? parentNode.id : null
        });
      } catch (err) {
        node.browserLoadInProgress = false;
        throw err;
      }
    }
    // - if window not loaded, push window node to be loaded
    let needsWindow = false;
    const windowHasId = (
      (undefined !== windowNode.windowId)
      && (null !== windowNode.windowId)
    );
    const windowLoaded = windowNode.isLoaded() && windowHasId;
    if (! windowLoaded) {
      if (windowNode.browserLoadInProgress) {
        const attached = await this.waitForPendingWindowLoad(windowNode);
        node.browserLoadInProgress = false;
        if (attached) {
          return await this.bkgd_loadSavedNode(msg);
        }
        response.result = 'Error: Timed out waiting for saved window';
        return response;
      }
      debug(`bkgd_loadSavedNode(): needsWindow`, windowNode);
      needsWindow = true;
      this.startPendingWindowLoad(windowNode);
    }
    const shouldPinCreatedTab = Boolean(node.isPinned());
    // Existing-window creation can request pinned directly.  New-window
    // creation must pin after the first tab exists, so guard the saved flag
    // against early unpinned events until that follow-up completes.
    if (shouldPinCreatedTab) {
      node.pinRestorePending = true;
      node.pinRestorePendingAt = Date.now();
    }
    // - push node to be loaded, and open it (new window or existing window)
    this.nodesLoading.push(node);
    const popNode = (node, failed = false) => {
      delete node.browserCreateTracked;
      delete node.pendingCreatedTabId;
      if (node.pendingLoadTimer) {
        clearTimeout(node.pendingLoadTimer);
        delete node.pendingLoadTimer;
      }
      const index = this.nodesLoading.indexOf(node);
      if (index !== -1) {
        if (failed) warn('bkgd_loadSavedNode failed:', node);
        this.nodesLoading.splice(index, 1);
      }
      node.browserLoadInProgress = false;
    };
    node.pendingLoadTimer = setTimeout(() => {
      popNode(node, true);
    }, this.pendingBrowserLoadTimeoutMs);  // failsafe
    // Node's timer object supports unref(); browsers return a numeric ID.
    node.pendingLoadTimer.unref?.();

    // actually open the tab
    const createProperties = {};
    if (cookieStoreId !== undefined) createProperties.cookieStoreId = cookieStoreId;
    createProperties.url = this.tree.resolveBrowserTabUrl(node.url);
    // Firefox may initially report extension pages as about:blank with the
    // moz-extension UUID and path in the title.  Match against the fully
    // resolved URL so the creation event reattaches to this saved node.
    node.pendingUrl = createProperties.url;
    // work around Firefox bug https://bugzilla.mozilla.org/show_bug.cgi?id=1412498
    if (isFirefox && ['about:newtab', 'about:home'].includes(node.url))
      createProperties.url = 'about:blank';
    // opening as first tab in new window
    if (needsWindow) {
      const createData = windowNode.windowCreateData();
      createData.url = createProperties.url;
      if (cookieStoreId !== undefined) createData.cookieStoreId = cookieStoreId;
      debug('bkgd_loadSavedNode() creating saved window', createData);
      try {
        let createdWindow;
        try {
          createdWindow = await this.createTrackedSavedTab(node,
            () => api.windows.create(createData), value => value.tabs?.[0]);
        } catch (err) {
          // handle "Error: Invalid value for bounds. Bounds must be at least 50% within visible screen space."
          if (err.message.includes('Invalid value for bounds')) {
            // if user left the window somewhere forbidden,
            // ignore their saved position
            // It's stupid that we have to do this, instead of the browser just
            // moving the window to an allowed position+size.
            debug('deleting invalid window bounds');
            delete createData.width;
            delete createData.height;
            delete createData.left;
            delete createData.top;
            createdWindow = await this.createTrackedSavedTab(node,
              () => api.windows.create(createData), value => value.tabs?.[0]);
          }
          else { throw err; }
        }
        let createdTabId = createdWindow && createdWindow.tabs
          && createdWindow.tabs[0] && createdWindow.tabs[0].id;
        if (shouldPinCreatedTab && (! createdTabId)) {
          for (let i = 0; i < 20 && (! node.tabId); i += 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          createdTabId = node.tabId;
        }
        if (shouldPinCreatedTab && createdTabId && api.tabs.update) {
          try {
            await api.tabs.update(createdTabId, { pinned: true });
            node.pinRestorePending = false;
          } catch (err) {
            node.pinRestorePending = false;
            if (node.pinned) {
              await node.setTabFields(
                { pinned: false },
                { reason: 'onTabUpdated' }
              );
            }
            warn(`bkgd_loadSavedNode(): pin restored tab failed: ${err}`);
          }
        }
        else if (shouldPinCreatedTab) {
          node.pinRestorePending = false;
          if (node.pinned) {
            await node.setTabFields(
              { pinned: false },
              { reason: 'onTabUpdated' }
            );
          }
        }
      } catch (err) {
        this.finishPendingWindowLoad(windowNode, false);
        node.pinRestorePending = false;
        popNode(node);
        warn(`loadSavedTab failed: ${err}`);
        response.error = String(err?.message || err);
        await node.setTabFields({ restoreError: response.error }, { reason: 'browserContext' });
        response.result = err;
      }
    }
    // opening as new tab in existing window
    else {
      createProperties.windowId = windowNode.windowId;
      // maybe don't fully load it?
      if (msg.discarded) {
        if (isFirefox) {
          createProperties.discarded = true;
          // only allowed for discarded URLs
          createProperties.title = node.title;
        }
        else createProperties.active = false;
      }
      // assign an "openerTab" if one exists
      // FIXME: fails sometimes and totally breaks the browser
      //   (like, it becomes unable to return a list of windows)
      //const openerNode = node.getLoadedParent();
      //if (openerNode) createProperties.openerTabId = openerNode.tabId;
      // TODO? set index
      //   (code which executes later fixes the tab order anyway)
      if (shouldPinCreatedTab) {
        createProperties.pinned = true;
        const pinnedTabs = windowNode.getLoadedAndUnloadedTabs()
          .filter((tabNode) => tabNode.isPinned());
        const pinnedIndex = pinnedTabs.indexOf(node);
        if (pinnedIndex >= 0) createProperties.index = pinnedIndex;
      }
      debug('bkgd_loadSavedNode() using existing window', createProperties);
      try {
        await this.createTrackedSavedTab(node, () => api.tabs.create(createProperties));
        if ('userAction' === msg.reason) {
          try {
            await api.windows.update(windowNode.windowId, { focused: true });
          } catch (err) {
            // The tab already exists.  Losing the pending-node association
            // here would make its creation event add a duplicate tree row.
            warn(`bkgd_loadSavedNode(): focus window failed: ${err}`);
          }
        }
      } catch (err) {
        node.pinRestorePending = false;
        popNode(node);
        warn(`loadSavedTab failed: ${err}`);
        response.error = String(err?.message || err);
        await node.setTabFields({ restoreError: response.error }, { reason: 'browserContext' });
        response.result = err;
      }
    }
    //response.tabId = newTab.id;  // doesn't exist yet
    // TODO: need to modify onTabCreated and onWindowCreated
    //   to check a queue of nodes which are in the process of being loaded
    if (! response.result) response.result = 'ok';
    return response;
  }

  async bkgd_focusWindow (msg) {
    const response = {};
    if (! msg) return response;
    let windowId = msg.windowId;
    if (! windowId && msg.nodeId) {
      const node = this.tree.nodes[msg.nodeId];
      if (node) windowId = node.windowId;
      if (node && node.tabId) msg.tabId = node.tabId;
    }
    if (msg.tabId) {
      try {
        const tab = await api.tabs.get(msg.tabId);
        if (tab && tab.windowId) windowId = tab.windowId;
      } catch (err) {
        warn(`bkgd_focusWindow tab lookup failed: ${err}`);
      }
    }
    if (! windowId) return response;
    try {
      await api.windows.update(windowId, { focused: true });
    } catch (err) {
      warn(`bkgd_focusWindow failed: ${err}`);
      response.result = err;
    }
    return response;
  }

  async bkgd_wrapNodeInWindow (msg) {
    await this.treeLoaded;  // ensure tree is loaded
    const response = {};
    const node = this.tree.nodes[msg.nodeId];
    if (! node) {
      const err = `bkgd_wrapNodeInWindow(): no node found: "${msg.nodeId}"`;
      error(err);
      return { error: err };
    }
    if (node.isRoot()) return { error: 'bkgd_wrapNodeInWindow(): root node' };

    const isLabelNode = (! node.isWindow()) && (! node.url) && (! node.title);

    if (node.isWindow()) {
      const hasLoadedDesc = node.hasLoadedTabsDeep
        ? node.hasLoadedTabsDeep()
        : node.hasLoadedTabs();
      const hasLoaded = node.isLoaded() || hasLoadedDesc;
      if (hasLoaded) {
        const parent = node.parent;
        if (! parent) return { error: 'bkgd_wrapNodeInWindow(): no parent' };
        const labelDetails = {
          label: node.label,
          note: node.note,
          expanded: true
        };
        if (node.hasCheckbox()) {
          labelDetails.checkbox = node.checkbox;
          labelDetails.checkboxPx = node.checkboxPx;
        }
        const labelNode = await parent.addChild(node.indexOf(), labelDetails,
          { reason: 'userAction' });
        await this.applyTreeMutation('ensureMoved', {
          nodeId: node.id,
          destParentId: labelNode.id,
          destIndex: 0,
          reason: 'userAction',
          prevParentId: parent.id
        });
        if (node.label || node.note) {
          await node.setNotes('', '', { reason: 'userAction' });
        }
        if (node.hasCheckbox()) {
          await node.setCheckbox(null, { reason: 'userAction' });
        }
        response.result = 'window-to-label';
        response.newLabelId = labelNode.id;
        return response;
      }
      await node.setTabFields({
        type: '',
        windowId: undefined,
        loaded: false,
        active: false,
        wasLoaded: false,
        geometry: undefined,
        incognito: undefined,
        windowState: undefined
      }, { reason: 'userAction' });
      response.result = 'window-to-label';
      return response;
    }

    if (isLabelNode) {
      await node.setTabFields({ type: 'window' }, { reason: 'userAction' });
      const openTabs = (
        node.isLoaded()
        || (node.hasLoadedTabsDeep
          ? node.hasLoadedTabsDeep()
          : node.hasLoadedTabs())
      );
      if (openTabs) {
        await this.bkgd_loadSavedWindow({
          windowNodeId: node.id,
          nodeId: node.id
        });
      }
      response.result = 'label-to-window';
      return response;
    }

    const prevWindowNode = node.getWindowNode(false);
    const prevWindowLoaded = prevWindowNode && prevWindowNode.isLoaded();
    const parent = node.parent;
    if (! parent) return { error: 'bkgd_wrapNodeInWindow(): no parent' };
    const windowNode = await parent.addChild(node.indexOf(), { type: 'window' },
      { reason: 'userAction' });
    await this.applyTreeMutation('ensureMoved', {
      nodeId: node.id,
      destParentId: windowNode.id,
      destIndex: 0,
      reason: 'userAction',
      prevParentId: parent.id
    });
    const openTabs = (
      node.isLoaded()
      || (node.hasLoadedTabsDeep
        ? node.hasLoadedTabsDeep()
        : node.hasLoadedTabs())
    );
    if (prevWindowLoaded && openTabs) {
      await this.bkgd_loadSavedWindow({
        windowNodeId: windowNode.id,
        nodeId: node.id
      });
    }
    response.result = 'wrapped';
    return response;
  }

  async bkgd_convertNodeToLoadedWindow (msg) {
    await this.treeLoaded;
    const response = {};
    const node = this.tree.nodes[msg.nodeId];
    if ((! node) || node.isRoot() || node.url) {
      const err = 'bkgd_convertNodeToLoadedWindow(): invalid node';
      error(err);
      return { error: err };
    }

    const changes = { type: 'window', loaded: false };
    const parentWindowNode = node.getWindowNode();
    if (parentWindowNode) changes.incognito = parentWindowNode.incognito;
    const changed = await node.setTabFields(
      changes,
      { reason: 'convertNodeToWindow' }
    );
    if (! changed) {
      response.result = 'nop';
      return response;
    }

    const result = await this.bkgd_loadSavedWindow({
      windowNodeId: node.id,
      nodeId: node.id
    });
    if (result.result) response.result = result.result;
    if (result.error) response.error = result.error;
    return response;
  }

  async bkgd_convertNodeFromLoadedWindow (msg) {
    await this.treeLoaded;
    const response = {};
    const node = this.tree.nodes[msg.nodeId];
    if ((! node) || (! node.canBeConvertedFromWindow())) {
      const err = 'bkgd_convertNodeFromLoadedWindow(): invalid node';
      error(err);
      return { error: err };
    }

    const parentWindowNode = node.parent.getWindowNode();
    const changed = await node.setTabFields({
      type: '',
      loaded: false,
      wasLoaded: false,
      windowId: undefined,
      incognito: undefined
    }, { reason: 'convertNodeFromWindow' });
    if (! changed) {
      response.result = 'nop';
      return response;
    }

    let result;
    if (parentWindowNode.isLoaded()) {
      result = await this.bkgd_reorderAllTabsInThisWindow({
        nodeId: node.id
      });
    } else {
      result = await this.bkgd_loadSavedWindow({
        windowNodeId: parentWindowNode.id,
        nodeId: node.id
      });
    }
    if (result?.result) response.result = result.result;
    if (result?.error) response.error = result.error;
    return response;
  }

  async bkgd_loadSavedWindow (msg) {
    await this.treeLoaded;  // ensure tree is loaded
    const response = {};
    // this only gets called when moving loaded tab(s) to an unloaded window
    // so it requires the window node and the branch which got moved
    let windowNode = this.tree.nodes[msg.windowNodeId];
    let node = this.tree.nodes[msg.nodeId];
    if ((! windowNode) || (! node)) {
      const err = `bkgd_loadSavedWindow(): no nodes found`;
      error(err);
      return { error: err };
    }
    // if already loaded, do nothing
    const windowHasId = (
      (undefined !== windowNode.windowId)
      && (null !== windowNode.windowId)
    );
    if (windowNode.isLoaded() && windowHasId) { return response; }
    if (windowNode.browserLoadInProgress) {
      response.result = 'ok pending';
      return response;
    }
    if (windowHasId) {
      // onTabCreated can publish a provisional window node before
      // onWindowCreated marks it loaded. Confirm browser truth without
      // waiting for that event (which may be queued behind this move).
      // Opening another window would pull out the group's first member,
      // dissolve its native binding, and then move everything back again.
      let liveWindow;
      try { liveWindow = await api.windows.get(windowNode.windowId); }
      catch { /* An actually closed window still needs normal restoration. */ }
      if (liveWindow && liveWindow.id === windowNode.windowId) {
        await windowNode.setTabFields(
          { loaded: true },
          { reason: 'onWindowCreated' }
        );
        response.result = 'ok';
        return response;
      }
    }
    // list of open tabs in the new window
    const loadedKids = node.findNodes(
      (n) => (n.tabId && (! n.isWindow()))
    );
    if (node.tabId) loadedKids.unshift(node);
    const tabIds = loadedKids.map((n) => n.tabId);
    if (tabIds.length === 0) {
      response.result = 'no-open-tabs';
      return response;
    }
    // push window node to be loaded
    this.startPendingWindowLoad(windowNode);
    // actually open the window
    const createProperties = windowNode.windowCreateData();
    createProperties.tabId = tabIds[0];  // dang, it only allows one
    debug('bkgd_loadSavedWindow() creating saved window', createProperties, windowNode);
    try {
      const winObj = await api.windows.create(createProperties);
      debug('bkgd_loadSavedWindow() created window', winObj);
      const extraTabIds = tabIds.slice(1);
      if (extraTabIds.length > 0) {
        try {
          const movableTabIds = [];
          const throttleMinTabs = 40;
          const throttleBatchSize = 20;
          const throttleDelayMs = 100;
          const throttled = (extraTabIds.length >= throttleMinTabs);
          if (throttled) {
            debug('bkgd_loadSavedWindow() throttling tab moves', {
              count: extraTabIds.length,
              batchSize: throttleBatchSize,
              delayMs: throttleDelayMs
            });
          }
          let checked = 0;
          for (const tabId of extraTabIds) {
            try {
              const tab = await api.tabs.get(tabId);
              if (tab.windowId !== winObj.id) movableTabIds.push(tabId);
            } catch (err) {
              warn(`bkgd_loadSavedWindow() tab missing: ${tabId}`);
            }
            checked += 1;
            if (throttled && (checked % throttleBatchSize === 0)) {
              await new Promise(resolve => setTimeout(resolve, throttleDelayMs));
            }
          }
          debug('bkgd_loadSavedWindow() moving tabs', {
            windowId: winObj.id,
            tabIds: movableTabIds
          });
          if (movableTabIds.length > 0) {
            await api.tabs.move(movableTabIds, { windowId: winObj.id, index: 1 });
          }
        } catch (err) {
          warn(`bkgd_loadSavedWindow() move tabs failed: ${err}`);
        }
      }
    } catch (err) {
      this.finishPendingWindowLoad(windowNode, false);
      warn(`loadSavedWindow failed: ${err}`);
      response.result = err;
    }
    // pull in the other tabs
    // (removed: other code has already done this at least once
    //  by the time this line runs)
    //await node.reorderAllTabsInThisWindow();
    // return success
    if (! response.result) response.result = 'ok';
    return response;
  }

  async bkgd_reorderAllTabsInThisWindow (msg) {
    // This function exists to avoid race conditions caused by multiple
    // threads trying to reorder tabs at the same time.  They are all
    // redirected here, so the requests can be processed without interfering
    // with each other.
    // Duplicate requests are debounced per window.  Requests which arrive
    // during execution trigger one follow-up pass so newer tree state wins.
    await this.treeLoaded;  // ensure tree is loaded
    let node = this.tree.nodes[msg.nodeId];
    if (! node) {
      const err = `bkgd_reorderAllTabsInThisWindow(): no node found: "${msg.nodeId}"`;
      error(err);
      return { error: err };
    }

    const windowNode = node.getWindowNode(false) || node;
    const reorderKey = windowNode.id || msg.nodeId;
    const pending = this.pendingTabReorders.get(reorderKey);
    if (pending) {
      pending.force = pending.force || Boolean(msg.force);
      if (pending.running) pending.dirty = true;
      return { result: 'ok pending' };
    }

    const request = {
      node: windowNode,
      force: Boolean(msg.force),
      running: false,
      dirty: false,
      timer: null
    };
    this.pendingTabReorders.set(reorderKey, request);
    request.timer = setTimeout(() => {
      this.runPendingTabReorder(reorderKey, request).catch((err) => {
        error('Pending tab reorder failed', err);
      });
    }, this.tabReorderDebounceTime);

    return { result: 'ok scheduled' };
  }

  async runPendingTabReorder (reorderKey, request) {
    const unlock = await this.tabReorderRequestMutex.lock();
    try {
      if (this.pendingTabReorders.get(reorderKey) !== request) return;
      request.running = true;
      do {
        request.dirty = false;
        const force = request.force;
        request.force = false;
        if (this.tabGroups?.supported) {
          // Creation-driven reorders must not race the native group/window
          // events which update the same outline. Direct user moves already
          // protect their intent through TabGroups.withOutlineMutation.
          await this.runSerializedBrowserMutation(
            () => request.node.reorderAllTabsInThisWindow({ force })
          );
        } else {
          await request.node.reorderAllTabsInThisWindow({ force });
        }
      } while (request.dirty);
    } catch (err) {
      error(`bkgd_reorderAllTabsInThisWindow error:`, err);
    } finally {
      if (this.pendingTabReorders.get(reorderKey) === request) {
        this.pendingTabReorders.delete(reorderKey);
      }
      unlock();
    }
  }

  async bkgd_importBackupFile (msg) {
    return this.importBackupFileGeneric(msg, this.importBackupFile);
  }

  bkgd_importTabsOutliner (msg) {
    return this.importBackupFileGeneric(msg, this.importTabsOutlinerExport);
  }

  async bkgd_backfillFavicons (msg) {
    // Backfill missing favicons using Google's favicon service
    // This is idempotent - nodes with faviconUrl already set are skipped
    await this.treeLoaded;
    log('bkgd_backfillFavicons: starting');

    let updated = 0;
    let skipped = 0;
    const changedNodes = [];

    // Find all nodes with a URL but no faviconUrl
    const nodesToUpdate = this.tree.root.findNodes(
      (node) => {
        // Must have a URL
        if (!node.url) return false;
        // Skip if already has a faviconUrl
        if (node.faviconUrl) return false;
        // Skip windows
        if (node.isWindow()) return false;
        return true;
      }
    );

    for (const node of nodesToUpdate) {
      try {
        // Extract domain from URL
        const url = new URL(node.url);
        const domain = url.hostname;
        // Skip empty domains or special URLs
        if (!domain || domain === 'localhost') {
          skipped++;
          continue;
        }
        // Use Google's favicon service
        const faviconUrl = `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
        // Update in memory, then commit the whole backfill in one transaction.
        node.faviconUrl = faviconUrl;
        changedNodes.push(node);
        updated++;
      } catch (err) {
        // Invalid URL or other error - skip this node
        skipped++;
      }
    }
    if (changedNodes.length > 0) {
      await this.tree.persistNodes(changedNodes);
    }

    log(`bkgd_backfillFavicons: done - updated ${updated}, skipped ${skipped}`);
    // Notify views to re-render with the new favicons
    await emit('tree_refreshAll', {});
    return { updated, skipped, total: nodesToUpdate.length };
  }

  async importBackupFileGeneric (msg, handler) {
    const response = {};
    let total = 0;
    try {
      const imported = await handler.bind(this)(msg.data, msg.filename);
      total = typeof imported === 'number' ? imported : imported.total;
      if (imported?.warnings?.length) response.warnings = imported.warnings;
      if ((! Number.isFinite(total)) || (total < 0)) {
        throw new Error('File format was not recognized');
      }
      response.status = `${total} nodes imported`;
      if (response.warnings?.length) response.status += ` (${response.warnings.length} recovery warnings; see details)`;
    } catch (err) {
      response.status = `Import error: ${err}`;
      response.error = err?.message || String(err);
      total = 0;
      error(err);
    }
    response.total = total;
    return response;
  }

  async importBackupFile(json, filename) {
    if (! isRecord(json) || jsonSchema !== json.$schema) {
      throw new Error('Does not appear to be a TKTSTO file');
    }
    if (filename != null && typeof filename !== 'string') throw new Error('Invalid import filename');
    if (json.metadata != null && ! isRecord(json.metadata)) throw new Error('Invalid backup metadata');
    for (const key of ['sessionStartDate', 'exportDate']) {
      if (json.metadata?.[key] != null && ! Number.isFinite(json.metadata[key])) {
        throw new Error(`Invalid backup metadata ${key}`);
      }
    }
    const graph = validateNodeGraph(json.nodes, { importing: true });
    const root = graph.records.root;
    root.expanded = false;
    root.label = root.label ? `${filename || 'Imported session'} (${root.label})` : filename || 'Imported session';
    const details = `Filename: ${filename || ''}\nSession Started: ${fmtDate(json.metadata?.sessionStartDate)}\nExported: ${fmtDate(json.metadata?.exportDate)}\nImported: ${fmtDate(Date.now())}`;
    root.note = root.note ? `${details}\n${root.note}` : details;
    // Generated import headers count toward the same limits as persisted
    // data. Never accept an import that would fail validation on next startup.
    validateNodeGraph(graph.records);
    await this.treeLoaded;
    await commitImportedGraph(this.tree, graph);
    return { total: graph.order.length - 1, warnings: graph.warnings };
  }

  async importTabsOutlinerExport(json, filename) {
    //log(typeof(json), json);
    if (! Array.isArray(json)) {
      error('Does not appear to be a Tabs Outliner file.  Outer element is not an array.');
      return -1;
    }
    // step 1: parse the data into a temporary structure
    const parsedNodes = this.parseTabsOutlinerExport(json, filename);
    if (! parsedNodes) return -1;
    // step 2: convert the parsed items into actual tree nodes
    const rootNode = await this.importParsedNodes(parsedNodes);
    if (! rootNode) return -1;
    return rootNode.countNodes();
  }

  parseTabsOutlinerExport (json, filename) {
    let parsedNodes = [];

    // look up a list of indexes in the parsedNodes tree
    function findNode(path) {
      //debug('findNode', path);
      let node = parsedNodes[0];
      let prevNode = node;
      for (const index of path) {
        node = node.nodes[index];
        if (! node) {
          // final index is the destination, and it should not exist yet
          return prevNode;
          //warn(`findNode(): invalid path: ${path}`, parsedNodes);
          //return null;
        }
        prevNode = node;
      }
      return node;
    }

    for (const item of json) {
      //debug('parsing item', item);
      // first item (2000) is a session summary
      // middle items (2001) are the tree nodes
      // last item (11111) is an export summary
      if (item.type) {
        // session summary object
        if ((2000 === item.type)
          || (item.node && ('session' === item.node.type))) {
          // create session root node
          const details = {};
          details.expanded = false;  // collapse new sub-tree
          details.label = `Tabs Outliner Session`;
          // treeId is the session creation time
          details.ctime = Number(item.node.data.treeId);
          details.sessionImportTime = Date.now();
          details.nodes = [];
          parsedNodes.push(details);
        }
        // export summary object
        else if (11111 === item.type) {
          const rootNode = parsedNodes[0];
          rootNode.sessionExportTime = item.time;
          // create the root / session node's long note
          const ctimeStr = fmtDate(rootNode.ctime);
          const itimeStr = fmtDate(rootNode.sessionImportTime);
          const etimeStr = fmtDate(rootNode.sessionExportTime);
          let filenameStr = '';
          if (filename) filenameStr = `Filename: ${filename}\n`;
          rootNode.note = `${filenameStr}Session Started: ${ctimeStr}\nExported: ${etimeStr}\nImported: ${itimeStr}`;
        }
      }
      // regular tree items are Arrays
      else if (Array.isArray(item)) {
        const twoThousandOne = item[0];  // every item starts with 2001
        if (2001 !== twoThousandOne) {
          warn('Unexpected item in import', item);
          continue;
        }
        const fields = item[1];
        const parents = item[2];
        // find the new node's parent node
        const parent = findNode(parents);
        //debug('parent', parent);
        if (! parent) continue;
        // parse the details
        const details = {};
        details.nodes = [];
        // expanded / collapsed state ("colapsed" is TO author's typo)
        if (fields.colapsed) details.expanded = false;
        else details.expanded = true;
        // general
        if (fields.marks) {
          // parse marks.customTitle
          details.label = fields.marks.customTitle;
        }
        if (fields.data) {
          const d = fields.data;
          // parse data.title
          if (d.title) details.title = d.title;
          // parse data.url
          if (d.url) details.url = d.url;
          // parse data.favIconUrl
          if (d.favIconUrl) details.faviconUrl = d.favIconUrl;
          // parse data.lastAccessed
          if (d.lastAccessed) details.atime = Number(d.lastAccessed);
        }
        // window nodes
        if (['win', 'savedwin', 'group'].includes(fields.type)) {
          details.type = 'window';
          details.loaded = false;
          if (! details.label) details.label = 'Window';
          if (fields.data) {
            const d = fields.data;
            // parse data.type for window type
            let winType = '';
            if (d.type && (d.type !== 'normal')) {
              // capitalize 1st letter
              winType = String(d.type).charAt(0).toUpperCase()
                + String(d.type).slice(1);
              details.label = `${winType} ${details.label}`;
            }
            // parse data.crashDetectedDate
            if (d.crashDetectedDate) {
              const dateStr = fmtDate(Number(d.crashDetectedDate));
              details.label = `${details.label} (crashed ${dateStr})`;
            }
          }
          // TODO: parse data.rect
          //details.geometry = [window.width, window.height, window.left, window.top];
          // TODO: parse data.focused
          //debug('window', details);
        }
        else if ('tab' === fields.type) {
          details.wasLoaded = true;  // link was open in a tab
        }
        // label-only nodes
        else if ('textnote' === fields.type) {
          // parse data.note
          details.label = fields.data.note;
          //debug('textnote', details);
        }
        // regular nodes
        else if (! fields.type) {
          // TODO: parse data.openerTabId?
          // TODO: parse data.highlighted?
          // TODO: parse data.audible?
          // TODO: parse data.autoDiscardable?
          // TODO: parse data.discarded?
          // TODO: parse data.frozen?
          // TODO: parse data.groupId?
          // TODO: parse data.mutedInfo?
          // TODO: parse marks.relicons?
        }
        // attach a new node under the parent
        //debug('loaded', details);
        parent.nodes.push(details);
      }
      // unrecognized item
      else {
        warn('Unexpected item in import', item);
      }
    }
    return parsedNodes;
  }

  async importParsedNodes(parsedNodes) {
    const graph = validateNodeGraph(nestedRecordsToHash(parsedNodes), { importing: true });
    await this.treeLoaded;
    return commitImportedGraph(this.tree, graph);
  }

  async onCommand (command, tab) {
    debug(`Bkgd.onCommand(${command})`, tab);
    const bkgdCommands = [
      'unloadCurrentTab',
      'bookmarkCurrentTab',
      'unmarkAll',
      'backupSession',
      //'prevTab',  // TODO
      //'nextTab',  // TODO
    ];
    // decide whether Bkgd or TreeView should handle the command
    if (bkgdCommands.includes(command)) {
      // Bkgd can handle this
      const handler = this[`command_${command}`];
      // actually handle the event
      await handler.bind(this)(tab);
      return;
    }

    // otherwise, send the command to the current window's TreeView
    // get the focused window
    let windowId, origWindowId;
    const window = await api.windows.getLastFocused();
    if (window) windowId = window.id;

    // in "Tabs Outliner mode" (just 1 TreeView in its own window),
    // send commands there instead of the current window
    // (works with any lone TreeView in session mode)
    const treeViewIds = Object.keys(this.treeViews);
    const firstTreeView = this.treeViews[treeViewIds[0]];
    if ((1 === treeViewIds.length)
      && ('session' === firstTreeView?.viewScope)
    ) {
      origWindowId = windowId;
      windowId = firstTreeView.windowId;
    }

    if (windowId) {
      //debug(`Bkgd.onCommand(${command})`, windowId);
      // send a message to the sidepanel of that window
      await emit(`treeview_onCommand`, {
        action: command,
        windowId, tab, origWindowId,
      });
    }
  }

  command_unloadCurrentTab (tab) {
    debug('Bkgd.command_unloadCurrentTab()', tab);
    let tabNode;
    if (tab) {
      tabNode = this.tree.getNodeByTabId(tab.id);
    } else {
      // TODO? find the current tab
      // (maybe ... maybe not, because if 'tab' is undefined,
      //  that probably means there isn't one and we should do nothing)
    }
    if (! tabNode) { return; }
    return this.applyTreeMutation('ensureUnloaded', {
      nodeId: tabNode.id,
      reason: 'userAction'
    });
  }

  async command_bookmarkCurrentTab (tab) {
    if (! tab) return;
    debug(`bookmark(${tab.title})`, tab);
    const tabNode = this.tree.getNodeByTabId(tab.id);
    if (! tabNode) return;
    // add a new bookmark node in place of tabNode,
    // and make tabNode the first child of the bookmark
    const parentNode = tabNode.parent;
    const bmNode = await parentNode.addChild(tabNode.indexOf(),
      { bookmark: true, loaded: false,
        url: tabNode.url, title: tabNode.title,
        label: tabNode.label, note: tabNode.note,
        checkbox: tabNode.checkbox, },
      { reason: 'userAction' });
    if (! bmNode) return error(`failed to add bookmark`, tabNode);
    const moved = await tabNode.moveTo(bmNode, 0, { reason: 'userAction'});
    if (! moved) return error(`failed to move tab into bookmark`,
      tabNode, bmNode);
    return moved;
  }

  command_unmarkAll (tab) {
    debug('Bkgd.command_unmarkAll()');
    return this.tree.unmarkAll({ reason: 'userAction' });
  }

  command_backupSession (tab) {
    debug('Bkgd.command_backupSession()');
    return this.tree.downloadBackupNow();
  }

}

if (! globalThis.__TKTSTO_TEST__) {
  const bkgd = new Bkgd();
  bkgd.init();
}
