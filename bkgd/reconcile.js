// bkgd/reconcile.js: reconcile tree state with browser state
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';
import { debug, log, warn, error, emit } from '/common/common.js';

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

function buildWindowChanges(winNode, window) {
  const changes = {};
  if (winNode.type !== 'window') changes.type = 'window';
  if (winNode.windowId !== window.id) changes.windowId = window.id;
  if (! winNode.isLoaded()) changes.loaded = true;
  if (undefined !== window.focused && winNode.active !== window.focused) {
    changes.active = window.focused;
  }
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

async function detachTabNode(node, reason) {
  if (node.isLoaded()) {
    await node.unload({ reason, wasLoaded: false });
    return true;
  }
  if (node.tabId || node.windowId) {
    await node.setTabFields({
      tabId: undefined,
      windowId: undefined,
      active: false
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
  const changes = node.tree.getBrowserTabChanges(
    node,
    tabInfo.tab,
    tabInfo.windowId
  );
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

export async function runReconcile ({ reason, nativeSnapshot, groupsChanged = false } = {}) {
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

  if (bkgd.tabGroups?.supported && ! nativeSnapshot) {
    if (reason !== 'startup') await bkgd.treeLoaded;
    try {
      return await bkgd.tabGroups.withReconciliation((snapshot, changed) =>
        runReconcile.call(bkgd, { reason, nativeSnapshot: snapshot, groupsChanged: changed })
      );
    } catch (err) {
      warn('Reconciliation retained the prior tree: native snapshot failed', err);
      return null;
    }
  }

  bkgd.reconcileInFlight = true;
  let didWork = groupsChanged;
  try {
    if ('startup' !== reason) {
      await bkgd.treeLoaded;
    }
    let windows;
    try {
      windows = nativeSnapshot?.windows || await api.windows.getAll({ populate: true });
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
        const match = await bkgd.tree.findMatchingWindow(
          window,
          attachedNodeIds
        );
        winNode = match.winNode;
        if (winNode) didWork = true;
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

    // Use the exact nodes selected above for each live browser window.
    // Iterating the whole cache here allows a stale duplicate windowId to
    // overwrite the primary and pull live tabs into the wrong saved branch.
    const windowNodesById = new Map(
      attachedWindows.map(({ winNode, window }) => [window.id, winNode])
    );
    const { tabNodesById } = bkgd.tree.buildTabBindingIndex();

    for (const { winNode, window } of attachedWindows) {
      const tabs = tabsByWindowId.get(window.id) || [];
      for (const tab of tabs) {
        const tabInfo = tabById.get(tab.id);
        const existing = tabNodesById.get(tab.id);
        if (existing && existing.length > 0) {
          const primary = bkgd.tree.choosePreferredTabNode(
            existing,
            tabInfo.windowId
          );
          const wasPinned = Boolean(primary.pinned);
          const changed = await ensureTabNodeAttached(primary, winNode, tabInfo, reason);
          if (changed || primary !== existing[0]) didWork = true;
          const pinned = Boolean(tab.pinned);
          const pinnedBranch = bkgd.tree.getPinnedBranch(winNode);
          const structurallyPinned = Boolean(
            pinnedBranch && primary.isChildOf(pinnedBranch)
          );
          if ((wasPinned !== pinned)
            || (pinnedBranch && (structurallyPinned !== pinned))) {
            const dest = await bkgd.tree.getBrowserEventTabDestination(
              primary,
              winNode,
              tab.index,
              pinned
            );
            await bkgd.tree.moveTabNodeForBrowserEvent(
              primary,
              dest.destParent,
              dest.destIndex,
              reason,
              {
                moveNodeOnly: true,
                windowNode: winNode,
                browserIndex: tab.index,
                pinned
              }
            );
            didWork = true;
          }
          continue;
        }

        let destParent = winNode;
        let destIndex = destParent.nodes.length;
        if (tab.pinned) {
          const pinnedIndex = Number.isInteger(tab.index)
            ? tab.index
            : bkgd.tree.getPinnedLoadedTabs(winNode).length;
          const dest = bkgd.tree.getPinnedInsertDestination(
            winNode,
            pinnedIndex
          );
          destParent = dest.destParent;
          destIndex = dest.destIndex;
        } else if (tab.openerTabId && tab.openerTabId !== tab.id) {
          const openerNodes = tabNodesById.get(tab.openerTabId);
          if (openerNodes && openerNodes.length > 0) {
            destParent = bkgd.tree.choosePreferredTabNode(
              openerNodes,
              tabById.get(tab.openerTabId)?.windowId
            );
            destIndex = destParent.nodes.length;
          }
        }
        const newNode = await destParent.addChild(
          destIndex,
          bkgd.tree.browserTabToNodeDetails(tabInfo.tab, window.id),
          { reason }
        );
        if (newNode && newNode.tabId) {
          tabNodesById.set(newNode.tabId, [newNode]);
        }
        didWork = true;
      }
    }

    for (const [tabId, nodesForTab] of tabNodesById.entries()) {
      if (nodesForTab.length <= 1) continue;
      const tabInfo = tabById.get(tabId);
      const primary = bkgd.tree.choosePreferredTabNode(
        nodesForTab,
        tabInfo?.windowId
      );
      for (const node of nodesForTab) {
        if (node === primary) continue;
        const changed = await detachTabNode(node, reason);
        if (changed) didWork = true;
      }
    }

    const nodesToCheck = Object.values(bkgd.tree.nodes);
    for (const node of nodesToCheck) {
      if (node.isWindow()) continue;
      if ((! node.url) && (! node.tabId) && (! node.windowId)) continue;

      const tabId = node.tabId;
      const inBrowser = tabId && tabById.has(tabId);
      if (! inBrowser && (node.isLoaded() || tabId || node.windowId)) {
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

    // Tab cleanup above can move nodes, but it does not create window nodes,
    // so reuse the same stable snapshot instead of allocating and traversing
    // the entire node cache again.
    for (const node of nodesToCheck) {
      if (! node.isWindow()) continue;
      const primary = windowNodesById.get(node.windowId);
      if (primary && (node !== primary)) {
        await node.setTabFields({
          windowId: undefined,
          loaded: false,
          active: false,
          wasLoaded: Boolean(node.loaded || node.wasLoaded)
        }, { reason });
        didWork = true;
      } else if (node.windowId && (! windowById.has(node.windowId))) {
        await node.windowClosed({ reason });
        didWork = true;
      } else if (primary && ! node.isLoaded()) {
        await node.setTabFields({ loaded: true }, { reason });
        didWork = true;
      }
    }

    if (bkgd.containers) didWork = (await bkgd.containers.refresh()) || didWork;
    if (bkgd.tabGroups) {
      // Bind any members first discovered by generic recovery, using the
      // same native snapshot. The outer reconciliation owns the context lock.
      try {
        didWork = (await (nativeSnapshot
          ? bkgd.tabGroups.syncSnapshot(nativeSnapshot)
          : bkgd.tabGroups.sync())) || didWork;
      }
      catch (err) { warn('Reconciliation retained the prior native group snapshot', err); }
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
