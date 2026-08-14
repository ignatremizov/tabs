// bkgd/idb.js: IndexedDB manager class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { log, warn } from '/common/common.js';

export class IDB {

  constructor () {
    this.dbSchemaNum = 1;
    this.dbName = 'TKTSTO';
    this.nodeDbName = 'Nodes';
    this.snapDbName = 'Snapshots';
    this.txnDbName = 'Transactions';
  }

  init () {
    this.db = this.openIDB();
  }

  // open IndexedDB and create the ObjectStores if needed
  // use 'await this.db;' before doing any database operations
  openIDB () {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbSchemaNum);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // create 'Nodes'
        if (! db.objectStoreNames.contains(this.nodeDbName)) {
          db.createObjectStore(this.nodeDbName, { keyPath: 'key' });
          log(`IDB created: ${this.nodeDbName}`);
        }
        // create 'Snapshots'
        if (! db.objectStoreNames.contains(this.snapDbName)) {
          db.createObjectStore(this.snapDbName, { keyPath: 'key' });
          log(`IDB created: ${this.snapDbName}`);
        }
        // create 'Transactions'
        if (! db.objectStoreNames.contains(this.txnDbName)) {
          db.createObjectStore(this.txnDbName, { keyPath: 'key' });
          log(`IDB created: ${this.txnDbName}`);
        }
      };
      request.onsuccess = (event) => {
        log(`IDB opened: ${this.dbName}`);
        resolve(event.target.result);
      };
      request.onerror = (event) => {
        warn(`IDB open failed: ${event.target.error}`);
        reject(event.target.error);
      };
    });
  }

  loadNode (nodeId) {
    return this.loadObj(this.nodeDbName, nodeId);
  }

  saveNode (node) {
    return this.saveNodes([node]);
  }

  saveNodes (nodes) {
    return this.writeNodes(nodes);
  }

  deleteNode (nodeId) {
    return this.writeNodes([], [nodeId]);
  }

  writeNodes (nodes = [], deleteNodeIds = []) {
    const nodesById = new Map();
    for (const node of nodes) {
      if (node?.id) nodesById.set(node.id, node);
    }
    const deleteIds = new Set(
      deleteNodeIds.filter((nodeId) => nodeId)
    );
    for (const nodeId of deleteIds) nodesById.delete(nodeId);
    const puts = [...nodesById.values()].map(
      (node) => [node.id, node.toDict()]
    );
    return this.writeObjs(this.nodeDbName, puts, [...deleteIds]);
  }

  async loadAllNodes () {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.nodeDbName, 'readonly');
      const store = txn.objectStore(this.nodeDbName);
      const nodes = {};
      // open a cursor to iterate over all entries
      const request = store.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          try {
            const node = JSON.parse(cursor.value.data);
            nodes[node.id] = node;
            //debug(`IDB.loadAllNodes(${node.id})`);
            cursor.continue();
          } catch (err) {
            reject(err);
          }
        } else {
          resolve(nodes);
        }
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  loadSnapshot (sessionName) {
    return this.loadObj(this.snapDbName, sessionName);
  }

  saveSnapshot (sessionName, tree) {
    return this.saveObj(this.snapDbName, sessionName, tree.serializeNodes());
  }

  deleteSnapshot (sessionName) {
    return this.deleteObj(this.snapDbName, sessionName);
  }

  // load an individual object
  async loadObj (dbName, key) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(dbName, 'readonly');
      const store = txn.objectStore(dbName);
      const request = store.get(key);
      request.onsuccess = (event) => {
        if (event.target.result) {
          // parse the JSON string back to an object
          try {
            resolve(JSON.parse(event.target.result.data));
          } catch (err) {
            reject(err);
          }
        } else {
          resolve(null);
        }
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  // save an individual Object
  async saveObj (dbName, key, obj) {
    //debug(`idb.saveObj(): ${dbName} :: ${key}`, obj);
    return await this.writeObjs(dbName, [[key, obj]]);
  }

  async deleteObj (dbName, key) {
    return await this.writeObjs(dbName, [], [key]);
  }

  async writeObjs (dbName, puts = [], deleteKeys = []) {
    // Serialize before awaiting the database so each record reflects one
    // coherent in-memory mutation, even if another event runs meanwhile.
    const records = puts.map(([key, obj]) => ({
      key,
      data: JSON.stringify(obj)
    }));
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(dbName, 'readwrite');
      const store = txn.objectStore(dbName);
      txn.oncomplete = () => resolve();
      txn.onerror = (event) => {
        reject(txn.error || event?.target?.error
          || new Error(`IndexedDB transaction failed: ${dbName}`));
      };
      txn.onabort = (event) => {
        reject(txn.error || event?.target?.error
          || new Error(`IndexedDB transaction aborted: ${dbName}`));
      };
      for (const record of records) store.put(record);
      for (const key of deleteKeys) store.delete(key);
    });
  }

}
