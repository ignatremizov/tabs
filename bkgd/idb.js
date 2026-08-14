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

  saveNode (node) {
    return this.saveNodes([node]);
  }

  saveNodes (nodes) {
    return this.writeNodes(nodes);
  }

  deleteNode (nodeId) {
    return this.writeNodes([], [nodeId]);
  }

  async writeNodes (nodes = [], deleteNodeIds = []) {
    const nodesById = new Map();
    for (const node of nodes) {
      if (node?.id) nodesById.set(node.id, node);
    }
    const deleteIds = new Set(
      deleteNodeIds.filter((nodeId) => nodeId)
    );
    for (const nodeId of deleteIds) nodesById.delete(nodeId);
    // Serialize before awaiting the database so each record reflects one
    // coherent in-memory mutation, even if another event runs meanwhile.
    const records = [...nodesById.values()].map((node) => ({
      key: node.id,
      data: JSON.stringify(node.toDict())
    }));
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.nodeDbName, 'readwrite');
      const store = txn.objectStore(this.nodeDbName);
      txn.oncomplete = () => resolve();
      txn.onerror = (event) => {
        reject(txn.error || event?.target?.error
          || new Error(`IndexedDB transaction failed: ${this.nodeDbName}`));
      };
      txn.onabort = (event) => {
        reject(txn.error || event?.target?.error
          || new Error(`IndexedDB transaction aborted: ${this.nodeDbName}`));
      };
      for (const record of records) store.put(record);
      for (const key of deleteIds) store.delete(key);
    });
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

  async loadNode (nodeId) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.nodeDbName, 'readonly');
      const store = txn.objectStore(this.nodeDbName);
      const request = store.get(nodeId);
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

}
