// bkgd/reconcile.js: reconcile tree state with browser state
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';
import { debug, log, error, emit } from '/common/common.js';

function buildBrowserSnapshot(tree, windows) {
  const windowById = new Map();
  const tabById = new Map();
  const tabsByWindowId = new Map();
  for (const window of windows) {
    windowById.set(window.id, window);
    const tabs = window.tabs || [];
    tabsByWindowId.set(window.id, tabs);
    for (const tab of tabs) {
      const url = tree.getTabPendingUrl(tab);
      const tabCopy = { ...tab, url };
      tabById.set(tab.id, { tab: tabCopy, windowId: window.id });
    }
  }
  return { windowById, tabById, tabsByWindowId };
}

function isBoringLeaf(node) {
  return (! node.shouldUnloadNotDelete()) && (! node.hasKids());
}

function choosePrimaryTabNode(nodes, tabInfo) {
  if (nodes.length <= 1) return nodes[0];
  const tabWindowId = tabInfo ? tabInfo.windowId : undefined;
  const scored = nodes.map((node) => {
    const windowMatch = (tabWindowId && node.windowId === tabWindowId) ? 1 : 0;
    const loadedScore = node.isLoaded() ? 1 : 0;
    const keepScore = node.shouldUnloadNotDelete() ? 1 : 0;
    return {
      node,
      score: [windowMatch, loadedScore, keepScore, node.ctime || 0, node.id]
    };
  });
  scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) {
      if (a.score[i] < b.score[i]) return 1;
      if (a.score[i] > b.score[i]) return -1;
    }
    return 0;
  });
  return scored[0].node;
}

function buildWindowChanges(winNode, window) {
  const changes = {};
  if (winNode.type !== 'window') changes.type = 'window';
  if (winNode.windowId !== window.id) changes.windowId = window.id;
  if (! winNode.isLoaded()) changes.loaded = true;
  const geom = [window.width, window.height, window.left, window.top];
  const hasGeometry = geom.every((value) => Number.isFinite(value));
  if (hasGeometry) {
    const current = winNode.geometry || [];
    const same = (
      current.length === geom.length &&
      current.every((value, idx) => value === geom[idx])
    );
    if (! same) changes.geometry = geom;
  }
  if (undefined !== window.state && winNode.windowState !== window.state) {
    changes.windowState = window.state;
  }
  if (undefined !== window.incognito && winNode.incognito !== window.incognito) {
    changes.incognito = window.incognito;
  }
  return changes;
}

function buildTabChanges(node, tabInfo) {
  const tab = tabInfo.tab;
  const changes = {};
  if (node.tabId !== tab.id) changes.tabId = tab.id;
  if (node.windowId !== tabInfo.windowId) changes.windowId = tabInfo.windowId;
  if (undefined !== tab.title && node.title !== tab.title) changes.title = tab.title;
  if (undefined !== tab.url && node.url !== tab.url) changes.url = tab.url;
  if (undefined !== tab.favIconUrl && node.faviconUrl !== tab.favIconUrl) {
    changes.favIconUrl = tab.favIconUrl;
  }
  if (! node.isLoaded()) changes.loaded = true;
  if (undefined !== tab.active && node.active !== tab.active) changes.active = tab.active;
  if (undefined !== tab.discarded && node.discarded !== tab.discarded) {
    changes.discarded = tab.discarded;
  }
  if (undefined !== tab.frozen && node.frozen !== tab.frozen) {
    changes.frozen = tab.frozen;
  }
  if (undefined !== tab.hidden && node.hidden !== tab.hidden) {
    changes.hidden = tab.hidden;
  }
  if (undefined !== tab.incognito && node.incognito !== tab.incognito) {
    changes.incognito = tab.incognito;
  }
  if (undefined !== tab.lastAccessed && node.atime !== tab.lastAccessed) {
    changes.atime = tab.lastAccessed;
  }
  return changes;
}

async function detachTabNode(node, reason) {
  if (node.isLoaded()) {
    await node.unload({ reason, wasLoaded: false });
    return true;
  }
  if (node.tabId || node.windowId) {
    await node.setTabFields({
      tabId: undefined,
      windowId: undefined
    }, { reason });
    return true;
  }
  return false;
}

async function cleanupClosedTab(node, reason) {
  if (isBoringLeaf(node)) {
    await node.deleteSelf({ reason });
    return true;
  }
  if (! node.shouldUnloadNotDelete() && node.hasKids()) {
    await node.deleteSelfAndPromoteKids({ reason });
    return true;
  }
  await node.unload({ reason, wasLoaded: true });
  return true;
}

async function ensureTabNodeAttached(node, winNode, tabInfo, reason) {
  let changed = false;
  const changes = buildTabChanges(node, tabInfo);
  if (Object.keys(changes).length > 0) {
    await node.setTabFields(changes, { reason });
    changed = true;
  }
  if (winNode && node.getWindowNode() !== winNode) {
    await node.moveTo(winNode, winNode.nodes.length, { reason });
    changed = true;
  }
  return changed;
}

export async function runReconcile ({ reason } = {}) {
  const bkgd = this;
  if (! bkgd || ! bkgd.tree) {
    return error('runReconcile() missing bkgd tree');
  }
  if (bkgd.reconcileInFlight) {
    debug('runReconcile: already running, skipping');
    return null;
  }
  // Conflict policy: browser truth for loaded tabs/windows, tree truth for saved nodes.
  if (! reason) reason = 'reconcile';

  bkgd.reconcileInFlight = true;
  let didWork = false;
  try {
    if ('startup' !== reason) {
      await bkgd.treeLoaded;
    }
    let windows;
    try {
      windows = await api.windows.getAll({ populate: true });
    } catch (err) {
      error('runReconcile: failed to get windows', err);
      return null;
    }

    const { windowById, tabById, tabsByWindowId } = buildBrowserSnapshot(
      bkgd.tree,
      windows
    );

    const attachedNodeIds = new Set();
    const attachedWindows = [];
    for (const window of windows) {
      let winNode = bkgd.tree.root.getWindowId(window.id);
      if (! winNode) {
        winNode = await bkgd.tree.findMatchingWindow(window, attachedNodeIds);
      }
      if (winNode) {
        const changes = buildWindowChanges(winNode, window);
        if (Object.keys(changes).length > 0) {
          await winNode.setTabFields(changes, { reason });
          didWork = true;
        }
      } else {
        winNode = await bkgd.tree.onWindowCreated(window, { reason });
        didWork = true;
      }
      if (winNode) {
        attachedNodeIds.add(winNode.id);
        attachedWindows.push({ winNode, window });
      }
    }

    const windowNodesById = new Map();
    const tabNodesById = new Map();
    const nodes = Object.values(bkgd.tree.nodes);
    for (const node of nodes) {
      if (node.isWindow() && node.windowId) {
        windowNodesById.set(node.windowId, node);
      }
      if (node.tabId) {
        if (! tabNodesById.has(node.tabId)) {
          tabNodesById.set(node.tabId, []);
        }
        tabNodesById.get(node.tabId).push(node);
      }
    }

    for (const { winNode, window } of attachedWindows) {
      const tabs = tabsByWindowId.get(window.id) || [];
      for (const tab of tabs) {
        const tabInfo = tabById.get(tab.id);
        const existing = tabNodesById.get(tab.id);
        if (existing && existing.length > 0) {
          const primary = choosePrimaryTabNode(existing, tabInfo);
          const changed = await ensureTabNodeAttached(primary, winNode, tabInfo, reason);
          if (changed || primary !== existing[0]) didWork = true;
          continue;
        }

        let destParent = winNode;
        if (tab.openerTabId && tab.openerTabId !== tab.id) {
          const openerNodes = tabNodesById.get(tab.openerTabId);
          if (openerNodes && openerNodes.length > 0) {
            destParent = openerNodes[0];
          }
        }
        const newNode = await destParent.addChild(destParent.nodes.length, {
          windowId: window.id,
          tabId: tab.id,
          title: tab.title,
          url: tabInfo.tab.url,
          faviconUrl: tab.favIconUrl,
          loaded: true,
          active: tab.active,
          discarded: tab.discarded,
          frozen: tab.frozen,
          hidden: tab.hidden,
          incognito: tab.incognito,
          atime: tab.lastAccessed
        }, { reason });
        if (newNode && newNode.tabId) {
          tabNodesById.set(newNode.tabId, [newNode]);
        }
        didWork = true;
      }
    }

    for (const [tabId, nodesForTab] of tabNodesById.entries()) {
      if (nodesForTab.length <= 1) continue;
      const tabInfo = tabById.get(tabId);
      const primary = choosePrimaryTabNode(nodesForTab, tabInfo);
      for (const node of nodesForTab) {
        if (node === primary) continue;
        const changed = await detachTabNode(node, reason);
        if (changed) didWork = true;
      }
    }

    const nodesToCheck = Object.values(bkgd.tree.nodes);
    for (const node of nodesToCheck) {
      if (node.isWindow() || (! node.url)) continue;

      const tabId = node.tabId;
      const inBrowser = tabId && tabById.has(tabId);
      if (! inBrowser && (node.isLoaded() || tabId)) {
        if (node.isLoaded()) {
          await cleanupClosedTab(node, reason);
        } else {
          await detachTabNode(node, reason);
        }
        didWork = true;
        continue;
      }

      if (inBrowser) {
        const tabInfo = tabById.get(tabId);
        const windowNode = windowNodesById.get(tabInfo.windowId);
        if (node.windowId !== tabInfo.windowId) {
          await node.setTabFields({ windowId: tabInfo.windowId }, { reason });
          didWork = true;
        }
        if (windowNode && node.getWindowNode() !== windowNode) {
          await node.moveTo(windowNode, windowNode.nodes.length, { reason });
          didWork = true;
        }
      }
    }

    const windowsToCheck = Object.values(bkgd.tree.nodes);
    for (const node of windowsToCheck) {
      if (! node.isWindow()) continue;
      if (node.windowId && (! windowById.has(node.windowId))) {
        await node.windowClosed({ reason });
        didWork = true;
      } else if (node.windowId && ! node.isLoaded()) {
        await node.setTabFields({ loaded: true }, { reason });
        didWork = true;
      }
    }

    if (didWork && ('startup' !== reason)) {
      await emit('tree_refreshAll', {});
    }
    log(`runReconcile(${reason}) done; changed=${didWork}`);
    return { changed: didWork };
  } finally {
    bkgd.reconcileInFlight = false;
  }
}
