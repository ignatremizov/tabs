// bkgd/tab-groups.js: native browser groups and their persistent outline notes
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';
import { error } from '/common/common.js';
import { Mutex } from '/common/mutex.js';

const groupColors = new Set([
  'blue', 'cyan', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'
]);

export function nativeGroupId(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function nearestGroup(node) {
  for (let parent = node; parent && ! parent.isRoot(); parent = parent.parent) {
    if (parent.isWindow()) return null;
    if (parent.nativeGroup === true) return parent;
  }
  return null;
}

function groupTitle(note) {
  if (note.groupTitle === '' && note.label === 'Tab group') return '';
  return String(note.label ?? note.groupTitle ?? '');
}

function fieldsChanged(node, values) {
  return Object.fromEntries(Object.entries(values).filter(
    ([key, value]) => node[key] !== value
  ));
}

function outlineNodes(windowNode) {
  const nodes = [];
  const visit = (parent) => {
    for (const node of parent.nodes) {
      if (node.isWindow()) continue;
      nodes.push(node);
      visit(node);
    }
  };
  visit(windowNode);
  return nodes;
}

export class TabGroups {
  constructor(bkgd) {
    this.bkgd = bkgd;
    // Browser group IDs are session-local. Never initialize this map from
    // persisted numeric IDs: reconnect notes through their member nodes.
    this.bindings = new Map();
    this.syncTimer = null;
    this.applying = 0;
    this.outlineApplying = 0;
    this.syncing = false;
    this.contextMutex = new Mutex();
    this.noteLocks = new WeakMap();
  }

  get supported() {
    return Boolean(api.tabGroups?.query && api.tabGroups?.get
      && api.tabGroups?.update && api.tabGroups?.move
      && api.tabs?.group && api.tabs?.ungroup);
  }

  requestSync() {
    if (! this.supported || this.syncTimer) return;
    // A native group action emits several group/tab events. Reconcile the
    // resulting snapshot once, rather than interpreting intermediate states.
    this.syncTimer = setTimeout(async () => {
      this.syncTimer = null;
      try {
        await this.bkgd.treeLoaded;
        await this.bkgd.runSerializedBrowserMutation(() => this.sync());
      } catch (err) {
        error('Native tab-group synchronization failed', err);
      }
    }, 75);
    this.syncTimer.unref?.();
  }

  async setFields(node, values, args = { reason: 'browserContext' }) {
    const changes = fieldsChanged(node, values);
    if (! Object.keys(changes).length) return false;
    await node.setTabFields(changes, args);
    return true;
  }

  async bind(note, group, args) {
    for (const [id, bound] of this.bindings) {
      if (bound === note && id !== group.id) this.bindings.delete(id);
    }
    this.bindings.set(group.id, note);
    return this.setFields(note, {
      nativeGroup: true,
      groupId: group.id,
      groupWindowId: group.windowId,
      groupTitle: group.title || '',
      label: group.title || 'Tab group',
      groupColor: groupColors.has(group.color) ? group.color : 'gray',
      groupCollapsed: Boolean(group.collapsed),
      expanded: ! group.collapsed
    }, args);
  }

  async sync({ force = false } = {}) {
    if (! this.supported) return false;
    const blocked = () => this.outlineApplying || this.syncing
      || (! force && (this.applying || this.bkgd.tabReorderInProgress));
    if (blocked()) {
      this.requestSync();
      return false;
    }
    const unlock = await this.contextMutex.lock();
    try {
      if (blocked()) {
        this.requestSync();
        return false;
      }
      this.syncing = true;
      try { return await this.syncSnapshot(); }
      finally { this.syncing = false; }
    } finally { unlock(); }
  }

  async withOutlineMutation(operation) {
    // Protect the complete outline move or metadata edit, not just its API
    // call. Renames and collapse changes must announce intent before changing
    // the note, or an older in-flight snapshot can erase the desired value.
    // Otherwise a delayed browser snapshot can move the note back to its old
    // window while the user's move is awaiting persistence or broadcasting.
    // Announce intent BEFORE waiting, so a browser-event callback never holds
    // its own lock waiting on an outline operation that needs more events.
    this.outlineApplying++;
    const unlock = await this.contextMutex.lock();
    try { return await operation(); }
    finally {
      this.outlineApplying--;
      unlock();
      this.requestSync();
    }
  }

  async readSnapshot() {
    // Fetch both before mutating anything. A failed API call must not be
    // interpreted as every group having disappeared.
    const [groups, windows] = await Promise.all([
      api.tabGroups.query({}), api.windows.getAll({ populate: true })
    ]);
    const byId = new Map(groups.map(group => [group.id, group]));
    for (const win of windows) {
      for (const tab of win.tabs || []) {
        if (nativeGroupId(tab.groupId) === undefined) continue;
        if (byId.get(tab.groupId)?.windowId !== win.id) {
          // Queries can straddle a browser-native move/removal. Do not turn
          // a torn snapshot into a destructive ungroup or per-tab move.
          this.requestSync();
          return null;
        }
      }
    }
    return { groups, windows };
  }

  async withReconciliation(operation) {
    // Generic recovery must normalize groups before moving individual tabs.
    // Use one snapshot and the same ownership boundary as outline edits;
    // never wait on a move that needs this browser-event callback to finish.
    const blocked = () => this.outlineApplying || this.syncing || this.applying
      || this.bkgd.tabReorderInProgress;
    if (blocked()) { this.requestSync(); return null; }
    const unlock = await this.contextMutex.lock();
    try {
      if (blocked()) { this.requestSync(); return null; }
      this.syncing = true;
      const snapshot = await this.readSnapshot();
      if (! snapshot || this.outlineApplying) {
        this.requestSync();
        return null;
      }
      const changed = await this.syncSnapshot(snapshot);
      return await operation(snapshot, changed);
    } finally {
      this.syncing = false;
      unlock();
    }
  }

  async syncSnapshot(snapshot) {
    const tree = this.bkgd.tree;
    if (! tree) return false;
    if (! snapshot) snapshot = await this.readSnapshot();
    if (! snapshot) return false;
    const { groups, windows } = snapshot;
    // A user mutation queued while the browser snapshot was in flight. It
    // owns the next transition; discard this stale snapshot without changes.
    if (this.outlineApplying) {
      this.requestSync();
      return false;
    }
    const liveGroups = new Map(groups.map(group => [group.id, group]));
    const liveTabs = new Map();
    for (const window of windows) {
      for (const tab of window.tabs || []) liveTabs.set(tab.id, tab);
    }
    const { tabNodesById } = tree.buildTabBindingIndex();
    const nodesByTab = new Map();
    for (const [id, candidates] of tabNodesById) {
      nodesByTab.set(id, tree.choosePreferredTabNode(
        candidates, liveTabs.get(id)?.windowId
      ));
    }
    // Snapshot ancestry before any move, including saved tabs. A newly
    // grouped parent must not drag unrelated saved descendants into a group.
    const originalParents = new Map();
    const originalGroups = new Map();
    const ranks = new Map();
    let rank = 0;
    for (const win of tree.root.findNodes(node => node.isWindow())) {
      for (const node of outlineNodes(win)) {
        originalParents.set(node, node.parent);
        originalGroups.set(node, nearestGroup(node));
        ranks.set(node, rank++);
      }
    }
    const previousBindings = new Map(this.bindings);
    // Claim surviving bindings first. Matching a new group to a former
    // member's note must never steal a note still bound to another live group.
    const claimed = new Set();
    for (const [id, note] of this.bindings) {
      if (! liveGroups.has(id) || tree.nodes[note.id] !== note) {
        this.bindings.delete(id);
      } else claimed.add(note);
    }
    const members = new Map();
    for (const tab of liveTabs.values()) {
      if (! liveGroups.has(tab.groupId)) continue;
      if (! members.has(tab.groupId)) members.set(tab.groupId, []);
      const node = nodesByTab.get(tab.id);
      if (node) members.get(tab.groupId).push({ node, tab });
    }
    for (const list of members.values()) list.sort((a, b) => a.tab.index - b.tab.index);

    let changed = false;
    await tree.runPersistenceBatch(async (args) => {
      for (const group of groups) {
        const list = members.get(group.id) || [];
        // Creation events can precede tab attachment. Wait for a member;
        // otherwise a temporary empty wrapper becomes a duplicate on restore.
        if (! list.length) continue;
        let win = tree.root.getWindowId(group.windowId);
        if (! win) {
          const browserWindow = windows.find(window => window.id === group.windowId);
          if (! browserWindow) continue;
          win = await tree.onWindowCreated(browserWindow, args);
        }
        let note = this.bindings.get(group.id);
        if (! note) {
          note = list.map(({ node }) => originalGroups.get(node) || nearestGroup(node))
            .find(candidate => candidate && ! claimed.has(candidate));
        }
        if (! note) {
          // Keep native groups as siblings beneath their window. Only actual
          // members move into the note; ordinary outline notes stay notes.
          let anchor = list[0].node;
          while (anchor.parent && anchor.parent !== win
            && ! anchor.parent.isRoot()) anchor = anchor.parent;
          const index = anchor.parent === win ? anchor.indexOf() : win.nodes.length;
          note = await win.addChild(index, {
            nativeGroup: true, label: group.title || 'Tab group'
          }, args);
          ranks.set(note, (ranks.get(list[0].node) ?? rank++) - 0.5);
          changed = true;
        }
        claimed.add(note);
        changed = (await this.bind(note, group, args)) || changed;
        if (note.parent !== win) {
          await note.moveTo(win, win.nodes.length, args);
          changed = true;
        }
      }

      const desiredGroups = new Map();
      for (const [node, savedGroup] of originalGroups) {
        if (node.nativeGroup) continue;
        const tab = liveTabs.get(node.tabId);
        if (tab) {
          desiredGroups.set(node, this.bindings.get(tab.groupId) || null);
          changed = (await this.setFields(node, {
            groupId: nativeGroupId(tab.groupId), windowId: tab.windowId
          }, args)) || changed;
        } else if (node.url) {
          desiredGroups.set(node, savedGroup);
        }
      }
      // Ordinary note children remain annotations of their nearest tab or
      // group. They are never mistaken for native groups based on their name.
      const desiredFor = (node) => {
        if (! node || node.isWindow() || node.isRoot()) return null;
        if (node.nativeGroup) return node;
        if (desiredGroups.has(node)) return desiredGroups.get(node);
        const desired = desiredFor(originalParents.get(node) || node.parent);
        desiredGroups.set(node, desired);
        return desired;
      };
      for (const node of originalParents.keys()) desiredFor(node);

      const moves = [];
      for (const [node, oldParent] of originalParents) {
        if (node.nativeGroup || tree.nodes[node.id] !== node) continue;
        const desired = desiredFor(node);
        let parent = oldParent;
        // Skip ancestors in another membership domain, preserving the nearest
        // compatible ancestor. E.g. G:A -> outside:B -> G:C becomes G:A -> C,
        // with B promoted out, without flattening A's other member children.
        while (parent && ! parent.isWindow() && ! parent.isRoot()) {
          if (desiredFor(parent) === desired) break;
          parent = originalParents.get(parent) || parent.parent;
        }
        if (desired && (! parent || parent.isWindow() || parent.isRoot())) {
          parent = desired;
        }
        const liveTab = liveTabs.get(node.tabId);
        if (! desired && liveTab
          && (! parent || parent.getWindowNode(false)?.windowId !== liveTab.windowId)) {
          parent = tree.root.getWindowId(liveTab.windowId) || parent;
        }
        if (parent && node.parent !== parent) moves.push({ node, parent });
      }
      for (const { node, parent } of moves) {
        const nodeRank = ranks.get(node) ?? Infinity;
        const index = parent.nodes.findIndex(child => (ranks.get(child) ?? Infinity) > nodeRank);
        await node.moveTo(parent, index < 0 ? parent.nodes.length : index, args);
        changed = true;
      }

      // Group moves are block moves; do not replay them as one node-only
      // movement per member, which would destroy the saved member hierarchy.
      for (const group of groups.slice().reverse()) {
        const note = this.bindings.get(group.id);
        const list = members.get(group.id);
        if (! note || ! list?.length) continue;
        const win = note.getWindowNode(false);
        if (! win) continue;
        const tabs = windows.find(window => window.id === group.windowId)?.tabs || [];
        const last = Math.max(...list.map(({ tab }) => tab.index));
        let next = null;
        for (const tab of tabs) {
          if (tab.index <= last) continue;
          let candidate = nodesByTab.get(tab.id);
          if (! candidate) continue;
          while (candidate.parent && candidate.parent !== win
            && ! candidate.parent.isRoot()) candidate = candidate.parent;
          if (candidate.parent === win && candidate !== note) {
            next = candidate;
            break;
          }
        }
        const index = next ? next.indexOf() : win.nodes.length;
        if (note.parent !== win || (note.indexOf() !== index && note.indexOf() + 1 !== index)) {
          await note.moveTo(win, index, args);
          changed = true;
        }
      }
      const activeNotes = new Set(this.bindings.values());
      for (const node of tree.root.findNodes(node => node.nativeGroup === true)) {
        if (! activeNotes.has(node)) {
          changed = (await this.setFields(node, {
            groupId: undefined, groupWindowId: undefined
          }, args)) || changed;
        }
      }
    }, { reason: 'browserContext', skipTabReorder: true, allowWindowProxy: false });
    // Preserve the historical note and its saved members when the browser
    // closes a group. Numeric bindings, not the note, are disposable.
    for (const id of previousBindings.keys()) {
      if (! liveGroups.has(id)) this.bindings.delete(id);
    }
    return changed;
  }

  async isWholeGroupMove(tabId) {
    if (! this.supported || this.applying) return false;
    let tab;
    try { tab = await api.tabs.get(tabId); } catch { return false; }
    const node = this.bkgd.tree.getNodeByTabId(tabId);
    const currentGroup = nativeGroupId(tab.groupId);
    if (currentGroup !== nativeGroupId(node?.groupId)) return true;
    const note = this.bindings.get(tab.groupId);
    if (! note) return currentGroup !== undefined;
    const tabs = await api.tabs.query({ windowId: tab.windowId, groupId: tab.groupId });
    const expected = note.getLoadedTabs().filter(node => nearestGroup(node) === note);
    return tabs.length === expected.length
      && tabs.every((entry, index) => entry.id === expected[index].tabId);
  }

  async restoreTab(node, tab) {
    const noteId = node.pendingNativeGroupNodeId;
    if (! noteId || ! this.supported) return;
    const note = this.bkgd.tree.nodes[noteId];
    if (! note?.nativeGroup || node.isPinned()) {
      delete node.pendingNativeGroupNodeId;
      return;
    }
    this.applying++;
    try {
      await this.ensureGroup(note, [tab.id], tab.windowId);
      delete node.pendingNativeGroupNodeId;
      await this.setFields(node, { groupId: note.groupId });
    } finally {
      this.applying--;
    }
  }

  async ensureGroup(note, tabIds, windowId) {
    if (! this.noteLocks.has(note)) this.noteLocks.set(note, new Mutex());
    const unlock = await this.noteLocks.get(note).lock();
    try { return await this.ensureGroupLocked(note, tabIds, windowId); }
    finally { unlock(); }
  }

  async ensureGroupLocked(note, tabIds, windowId) {
    let group = null;
    const boundId = [...this.bindings].find(([, candidate]) => candidate === note)?.[0];
    if (boundId !== undefined) {
      try { group = await api.tabGroups.get(boundId); } catch { this.bindings.delete(boundId); }
    }
    if (group && group.windowId !== windowId) {
      const oldTabs = await api.tabs.query({ groupId: group.id });
      if (oldTabs.every(tab => tabIds.includes(tab.id))) {
        group = await api.tabGroups.move(group.id, { windowId, index: -1 });
      } else group = null;
    }
    let id;
    if (group) {
      const current = await api.tabs.query({ groupId: group.id });
      const present = new Set(current.map(tab => tab.id));
      const missing = tabIds.filter(tabId => ! present.has(tabId));
      if (missing.length) await api.tabs.group({ groupId: group.id, tabIds: missing });
      id = group.id;
    } else {
      id = await api.tabs.group({ createProperties: { windowId }, tabIds });
      group = await api.tabGroups.get(id);
    }
    const desired = {
      title: groupTitle(note),
      color: groupColors.has(note.groupColor) ? note.groupColor : 'gray',
      collapsed: Boolean(note.groupCollapsed)
    };
    if (Object.keys(desired).some(key => group[key] !== desired[key])) {
      group = await api.tabGroups.update(id, desired);
    }
    await this.bind(note, group);
    return group;
  }

  async reorder(windowNode, nodes, firstIndex) {
    // This replaces the old all-unpinned-tabs move. Operate on whole native
    // groups, or on tabs inside one group, never across every group at once.
    this.applying++;
    try {
      const windowId = windowNode.windowId;
      const blocks = [];
      const byNote = new Map();
      for (const node of nodes) {
        if (! node.tabId || node.isPinned()) continue;
        const note = nearestGroup(node);
        if (! note) blocks.push({ ids: [node.tabId] });
        else {
          if (! byNote.has(note)) {
            const block = { note, ids: [] };
            byNote.set(note, block);
            blocks.push(block);
          }
          byNote.get(note).ids.push(node.tabId);
        }
      }
      const browserTabs = await api.tabs.query({ windowId });
      const known = new Set(nodes.map(node => node.tabId));
      if (browserTabs.some(tab => ! known.has(tab.id))) {
        // A browser creation event is still in flight. Do not reorganize a
        // native group around members not yet attached to the outline.
        this.requestSync();
        return;
      }
      const present = new Set(browserTabs.map(tab => tab.id));
      if (! this.outlineApplying && blocks.some(block => block.ids.some(id => ! present.has(id)))) {
        // A debounced create/reorder request may outlive a native window
        // move. Only an explicit outline mutation can intentionally transfer
        // tabs between windows. Never pull a group back using stale ancestry;
        // let the following snapshot attach the outline to browser truth.
        this.requestSync();
        return;
      }
      for (const block of blocks) {
        const incoming = block.ids.filter(id => ! present.has(id));
        if (incoming.length) {
          let group = null;
          if (block.note && incoming.length === block.ids.length) {
            try { group = await api.tabGroups.get(block.note.groupId); } catch {}
          }
          const whole = group && (await api.tabs.query({ groupId: group.id }))
            .every(tab => incoming.includes(tab.id));
          if (whole) await api.tabGroups.move(group.id, { windowId, index: -1 });
          else await api.tabs.move(incoming, { windowId, index: -1 });
        }
        if (block.note) {
          block.group = await this.ensureGroup(block.note, block.ids, windowId);
        } else {
          const tab = await api.tabs.get(block.ids[0]);
          if (nativeGroupId(tab.groupId) !== undefined) await api.tabs.ungroup(block.ids);
        }
      }
      let index = firstIndex;
      for (const block of blocks) {
        if (block.note) {
          const current = await api.tabs.query({ groupId: block.group.id, windowId });
          if (current.some((tab, at) => tab.id !== block.ids[at])
            || current.length !== block.ids.length) {
            await api.tabs.move(block.ids, { windowId, index: current[0]?.index ?? index });
            block.group = await this.ensureGroup(block.note, block.ids, windowId);
          }
          const first = (await api.tabs.query({ groupId: block.group.id, windowId }))[0];
          if (first?.index !== index) {
            await api.tabGroups.move(block.group.id, { windowId, index });
          }
        } else {
          const tab = await api.tabs.get(block.ids[0]);
          if (tab.index !== index || tab.windowId !== windowId) {
            await api.tabs.move(block.ids, { windowId, index });
          }
          const moved = await api.tabs.get(block.ids[0]);
          if (nativeGroupId(moved.groupId) !== undefined) await api.tabs.ungroup(block.ids);
        }
        index += block.ids.length;
      }
    } finally {
      this.applying--;
    }
  }

  async updateNote(note) {
    if (! this.supported || ! note.nativeGroup) return;
    const ids = note.getLoadedTabs().filter(node => nearestGroup(node) === note)
      .map(node => node.tabId);
    const windowId = note.getWindowNode(false)?.windowId;
    if (! ids.length || windowId === undefined) return;
    this.applying++;
    try { await this.ensureGroup(note, ids, windowId); }
    finally { this.applying--; }
  }
}
