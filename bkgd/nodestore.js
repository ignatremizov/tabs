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
    // Coordinate persistence for the whole tree.  A lock per node consumes
    // memory without preventing transactions on different nodes from racing.
    if (! this.tree.persistenceMutex) {
      this.tree.persistenceMutex = new Mutex();
    }
  }

  newNodeId () {
    // NodeView.newNodeId() and NodeStore.newNodeId()
    // are totally different, and Node.newNodeId() doesn't exist
    const nodeId = this.tree.bkgd.idGen.newId();
    debug(`NodeStore.newNodeId(): ${nodeId}`);
    return nodeId;
  }

  async withPersistenceBatch (mutator, args) {
    const inherited = args?._persistNodesLater instanceof Set;
    const persistNodesLater = inherited
      ? args._persistNodesLater
      : new Set();
    const deleteNodeIdsLater = args?._deleteNodeIdsLater instanceof Set
      ? args._deleteNodeIdsLater
      : new Set();
    const operationArgs = (
      inherited
      && (args._deleteNodeIdsLater === deleteNodeIdsLater)
    )
      ? args
      : {
          ...args,
          _persistNodesLater: persistNodesLater,
          _deleteNodeIdsLater: deleteNodeIdsLater
        };
    const result = await mutator(
      operationArgs,
      persistNodesLater,
      deleteNodeIdsLater
    );
    if ((! inherited)
      && ((persistNodesLater.size > 0) || (deleteNodeIdsLater.size > 0))) {
      await this.persistWithLock(
        [...persistNodesLater],
        [...deleteNodeIdsLater]
      );
    }
    return result;
  }

  async persistMutation (mutator, args) {
    return await this.withPersistenceBatch(
      async (operationArgs, persistNodesLater) => {
        const changed = await mutator(operationArgs);
        if (changed) persistNodesLater.add(this);
        return changed;
      },
      args
    );
  }

  async persistWithLock (nodes = [], deleteNodeIds = []) {
    const unlock = await this.tree.persistenceMutex.lock();
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
    return await this.withPersistenceBatch(
      async (
        operationArgs,
        persistNodesLater,
        deleteNodeIdsLater
      ) => {
        const changed = await super.deleteSelf(operationArgs);
        if (changed) {
          if (parent && parent.id && (parent.id !== nodeId)) {
            persistNodesLater.add(parent);
          }
          persistNodesLater.delete(this);
          deleteNodeIdsLater.add(nodeId);
        }
        return changed;
      },
      args
    );
  }

  async deleteSelfAndPromoteKids (args) {
    return await this.withPersistenceBatch(
      (operationArgs) => super.deleteSelfAndPromoteKids(operationArgs),
      args
    );
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
      const persistNodesLater = extra[0]?._persistNodesLater;
      if (persistNodesLater instanceof Set) {
        persistNodesLater.add(newNode);
        persistNodesLater.add(this);
      } else {
        await this.persistWithLock([newNode, this]);
      }
    }

    return newNode;
  }

  async setNotes (label, note, args) {
    debug(`NodeStore.setNotes(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.setNotes(label, note, operationArgs),
      args
    );
  }

  async setCheckbox (value, args) {
    debug(`NodeStore.setCheckbox(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.setCheckbox(value, operationArgs),
      args
    );
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
    return await this.persistMutation(
      (operationArgs) => super.setTabFields(changes, operationArgs),
      args
    );
  }

  async load (args) {
    debug(`NodeStore.load(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.load(operationArgs),
      args
    );
  }

  async unload (args) {
    debug(`NodeStore.unload(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.unload(operationArgs),
      args
    );
  }

  async moveTo (destParent, destIndex, args) {
    debug(`NodeStore.moveTo(${args.reason}, ${this.id})`, args);
    const prevParent = this.parent;
    return await this.withPersistenceBatch(
      async (operationArgs, persistNodesLater) => {
        const changed = await super.moveTo(
          destParent,
          destIndex,
          operationArgs
        );
        if (changed) {
          for (const node of [this, destParent, prevParent]) {
            if (node) persistNodesLater.add(node);
          }
        }
        return changed;
      },
      args
    );
  }

  async applyActiveTabUpdates (tabList, activeTabNode, args) {
    return await this.withPersistenceBatch(
      (operationArgs) => super.applyActiveTabUpdates(
        tabList,
        activeTabNode,
        operationArgs
      ),
      args
    );
  }

  async setExpanded (expanded, args) {
    debug(`NodeStore.setExpanded(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.setExpanded(expanded, operationArgs),
      args
    );
  }

  async setMarked (marked, args) {
    debug(`NodeStore.setMarked(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.setMarked(marked, operationArgs),
      args
    );
  }

  async setActive (active, args) {
    debug(`NodeStore.setActive(${args.reason}, ${this.id})`, args);
    return await this.persistMutation(
      (operationArgs) => super.setActive(active, operationArgs),
      args
    );
  }

}
