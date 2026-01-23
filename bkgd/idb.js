// bkgd/idb.js: IndexedDB manager class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import { debug, log, warn, error } from '/common/common.js';

export class IDB {

  constructor () {
    this.dbSchemaNum = 2;
    this.dbName = 'TKTSTO';
    this.nodeDbName = 'Nodes';
    this.snapDbName = 'Snapshots';
    this.txnDbName = 'Transactions';
    this.opsDbName = 'Ops';
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
        // create 'Ops'
        if (! db.objectStoreNames.contains(this.opsDbName)) {
          const store = db.createObjectStore(this.opsDbName, { keyPath: 'opId' });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          log(`IDB created: ${this.opsDbName}`);
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

  setDirty () {
    // nodeDb has changed since the latest snapshot
    return api.storage.local.set({ isLatestSnapshotDirty: true });
  }

  loadNode (nodeId) {
    return this.loadObj(this.nodeDbName, nodeId);
  }

  saveNode (node) {
    this.setDirty();
    return this.saveObj(this.nodeDbName, node.id, node.toDict());
  }

  deleteNode (nodeId) {
    this.setDirty();
    return this.deleteObj(this.nodeDbName, nodeId);
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
          const node = JSON.parse(cursor.value.data);
          nodes[node.id] = node;
          //debug(`IDB.loadAllNodes(${node.id})`);
          cursor.continue();
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

  enqueueOp (op) {
    return this.saveOp(op);
  }

  async loadOp (opId) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readonly');
      const store = txn.objectStore(this.opsDbName);
      const request = store.get(opId);
      request.onsuccess = (event) => resolve(event.target.result || null);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async saveOp (op) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readwrite');
      const store = txn.objectStore(this.opsDbName);
      const request = store.put(op);
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async updateOp (opId, updates) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readwrite');
      const store = txn.objectStore(this.opsDbName);
      const getRequest = store.get(opId);
      getRequest.onsuccess = (event) => {
        const existing = event.target.result;
        if (! existing) {
          resolve(null);
          return;
        }
        const updated = { ...existing, ...updates };
        const putRequest = store.put(updated);
        putRequest.onsuccess = () => resolve(updated);
        putRequest.onerror = (evt) => reject(evt.target.error);
      };
      getRequest.onerror = (event) => reject(event.target.error);
    });
  }

  async listPendingOps (limit = 10) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readonly');
      const store = txn.objectStore(this.opsDbName);
      const index = store.index('createdAt');
      const ops = [];
      const request = index.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (! cursor) {
          resolve(ops);
          return;
        }
        const op = cursor.value;
        if (op.state === 'pending') {
          ops.push(op);
          if (ops.length >= limit) {
            resolve(ops);
            return;
          }
        }
        cursor.continue();
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async listOpsByState (state, limit = 50) {
    const db = await this.db;
    const enforceLimit = Number.isFinite(limit) && (limit > 0);
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readonly');
      const store = txn.objectStore(this.opsDbName);
      const index = store.index('state');
      const ops = [];
      const request = index.openCursor(IDBKeyRange.only(state));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (! cursor) {
          resolve(ops);
          return;
        }
        ops.push(cursor.value);
        if (enforceLimit && (ops.length >= limit)) {
          resolve(ops);
          return;
        }
        cursor.continue();
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async countOpsByState (state) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readonly');
      const store = txn.objectStore(this.opsDbName);
      const index = store.index('state');
      const request = index.count(IDBKeyRange.only(state));
      request.onsuccess = (event) => resolve(event.target.result || 0);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async deleteOp (opId) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.opsDbName, 'readwrite');
      const store = txn.objectStore(this.opsDbName);
      const request = store.delete(opId);
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
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
          resolve(JSON.parse(event.target.result.data));
        } else {
          resolve(null);
        }
      };
      request.onerror = (event) => reject(event.target.error);
    });
  }

  // save an individual Object
  async saveObj (dbName, key, obj) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(dbName, 'readwrite');
      const store = txn.objectStore(dbName);
      const data = JSON.stringify(obj);
      const request = store.put({ key, data });
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
  }

  async deleteObj (dbName, key) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(dbName, 'readwrite');
      const store = txn.objectStore(dbName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(event.target.error);
    });
  }

}
