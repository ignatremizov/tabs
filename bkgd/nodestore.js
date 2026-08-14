// bkgd/nodestore.js: NodeStore class
// Copyright (C) 2025 Selene ToyKeeper
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { debug } from '/common/common.js';
import { Node } from '/common/node.js';
import { Mutex } from '/common/mutex.js';


// TODO
export class NodeStore extends Node {

  constructor (...args) {
    super(...args);
    // don't write other things during the middle of a transaction
    this.writeLock = new Mutex();
  }

  newNodeId () {
    // NodeView.newNodeId() and NodeStore.newNodeId()
    // are totally different, and Node.newNodeId() doesn't exist
    //super.newNodeId();  // unnecessary, doesn't exist
    const nodeId = this.tree.bkgd.idGen.newId();
    debug(`NodeStore.newNodeId(): ${nodeId}`);
    return nodeId;
  }

  async saveIfChanged (promise, persistNodesLater) {
    const changed = await promise;
    if (changed) {
      if (persistNodesLater instanceof Set) {
        persistNodesLater.add(this);
      } else {
        await this.persistWithLock([this]);
      }
    }
    return changed;
  }

  async persistWithLock (nodes = [], deleteNodeIds = []) {
    const unlock = await this.writeLock.lock();
    try {
      return await this.persistNodes(nodes, deleteNodeIds);
    } finally {
      unlock();
    }
  }

  async persistNodes (nodes = [], deleteNodeIds = []) {
    const nodesById = new Map();
    for (const node of nodes) {
      // Async browser callbacks may still hold a reference after another
      // callback deleted the node.  Never let that stale work recreate the
      // deleted record.
      if (node?.id && (this.tree.nodes[node.id] === node)) {
        nodesById.set(node.id, node);
      }
    }
    for (const nodeId of deleteNodeIds) nodesById.delete(nodeId);
    if ((nodesById.size === 0) && (deleteNodeIds.length === 0)) return;

    if (this.tree.db.writeNodes) {
      return await this.tree.db.writeNodes(
        [...nodesById.values()],
        deleteNodeIds
      );
    }

    // Lightweight test doubles and third-party TreeStore subclasses may only
    // implement the original single-record methods.
    for (const node of nodesById.values()) {
      await this.tree.db.saveNode(node);
    }
    for (const nodeId of deleteNodeIds) {
      await this.tree.db.deleteNode(nodeId);
    }
  }

  async deleteSelf (args) {
    debug(`NodeStore.deleteSelf(${args.reason}, ${this.id})`, args);
    const nodeId = this.id;  // save for later
    const parent = this.parent;

    // let parent class do its thing
    const changed = await super.deleteSelf(args);
    // if delete failed, skip the rest
    if (changed) {
      const nodesToSave = (
        parent && parent.id && (parent.id !== nodeId)
      ) ? [parent] : [];
      await this.persistWithLock(nodesToSave, [nodeId]);
    }

    return changed;
  }

  async addChild (index, details, ...extra) {
    // index is required; assume 1st child if not given
    if (undefined === index) index = 0;

    debug(`NodeStore.addChild(${index})`, details);
    // must allocate ID before creating node and emitting notifications
    if (! details.id) { details.id = this.newNodeId(); }

    // create new Node object
    const newNode = await super.addChild(index, details, ...extra);
    if (newNode) {
      await this.persistWithLock([newNode, this]);
    }

    return newNode;
  }

  async setNotes (label, note, args) {
    debug(`NodeStore.setNotes(${args.reason}, ${this.id})`, args);
    const inherited = args?._persistNodesLater instanceof Set;
    const persistNodesLater = inherited
      ? args._persistNodesLater
      : new Set();
    const operationArgs = inherited
      ? args
      : { ...args, _persistNodesLater: persistNodesLater };
    const changed = await this.saveIfChanged(
      super.setNotes(label, note, operationArgs),
      persistNodesLater
    );
    if ((! inherited) && persistNodesLater.size > 0) {
      await this.persistWithLock([...persistNodesLater]);
    }
    return changed;
  }

  async setCheckbox (value, args) {
    debug(`NodeStore.setCheckbox(${args.reason}, ${this.id})`, args);
    const inherited = args?._persistNodesLater instanceof Set;
    const persistNodesLater = inherited
      ? args._persistNodesLater
      : new Set();
    const operationArgs = inherited
      ? args
      : { ...args, _persistNodesLater: persistNodesLater };
    const changed = await this.saveIfChanged(
      super.setCheckbox(value, operationArgs),
      persistNodesLater
    );
    if ((! inherited) && persistNodesLater.size > 0) {
      await this.persistWithLock([...persistNodesLater]);
    }
    return changed;
  }

  async applyCheckboxUpdates (changedNodes, args) {
    if (changedNodes.length <= 0) return false;
    const persistNodesLater = args?._persistNodesLater;
    if (persistNodesLater instanceof Set) {
      for (const node of changedNodes) persistNodesLater.add(node);
    } else {
      await this.persistWithLock(changedNodes);
    }
    return true;
  }

  async setTabFields (changes, args) {
    debug(`NodeStore.setTabFields(${args.reason}, ${this.id})`, args);
    return await this.saveIfChanged(
      super.setTabFields(changes, args),
      args?._persistNodesLater
    );
  }

  async load (args) {
    debug(`NodeStore.load(${args.reason}, ${this.id})`, args);
    return await this.saveIfChanged(
      super.load(args),
      args?._persistNodesLater
    );
  }

  async unload (args) {
    debug(`NodeStore.unload(${args.reason}, ${this.id})`, args);
    return await this.saveIfChanged(
      super.unload(args),
      args?._persistNodesLater
    );
  }

  async moveTo (destParent, destIndex, args) {
    debug(`NodeStore.moveTo(${args.reason}, ${this.id})`, args);
    const prevParent = this.parent;
    const inherited = args?._persistNodesLater instanceof Set;
    const persistNodesLater = inherited
      ? args._persistNodesLater
      : new Set();
    const operationArgs = inherited
      ? args
      : { ...args, _persistNodesLater: persistNodesLater };

    const changed = await super.moveTo(
      destParent,
      destIndex,
      operationArgs
    );
    if (changed) {
      for (const node of [this, destParent, prevParent]) {
        if (node) persistNodesLater.add(node);
      }
      if (! inherited) {
        await this.persistWithLock([...persistNodesLater]);
      }
    }

    return changed;
  }

  async setExpanded (expanded, args) {
    debug(`NodeStore.setExpanded(${args.reason}, ${this.id})`, args);
    return await this.saveIfChanged(
      super.setExpanded(expanded, args),
      args?._persistNodesLater
    );
  }

  async setMarked (marked, args) {
    debug(`NodeStore.setMarked(${args.reason}, ${this.id})`, args);
    const inherited = args?._persistNodesLater instanceof Set;
    const persistNodesLater = inherited
      ? args._persistNodesLater
      : new Set();
    const operationArgs = inherited
      ? args
      : { ...args, _persistNodesLater: persistNodesLater };
    const changed = await this.saveIfChanged(
      super.setMarked(marked, operationArgs),
      persistNodesLater
    );
    if ((! inherited) && persistNodesLater.size > 0) {
      await this.persistWithLock([...persistNodesLater]);
    }
    return changed;
  }

  async setActive (active, args) {
    debug(`NodeStore.setActive(${args.reason}, ${this.id})`, args);
    return await this.saveIfChanged(
      super.setActive(active, args),
      args?._persistNodesLater
    );
  }

}
