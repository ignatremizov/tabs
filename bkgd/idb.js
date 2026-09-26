// bkgd/idb.js: IndexedDB manager class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { log, warn } from '/common/common.js';
import { isRecord } from '/common/serialized-tree.js';
import { historyDefaults, historyPolicy, historyPruneIds } from '/common/deletion-history.js';

export class IDB {

  constructor () {
    this.dbSchemaNum = 2;
    this.dbName = 'TKTSTO';
    this.nodeDbName = 'Nodes';
    this.historyDbName = 'DeletedBranches';
    this.historySettingsDbName = 'DeletionHistorySettings';
  }

  init () {
    this.db = this.openIDB();
    this.db.catch(() => {});
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
        // Additive migration: preserve every existing Nodes record verbatim.
        if (! db.objectStoreNames.contains(this.historyDbName)) {
          const history = db.createObjectStore(this.historyDbName, { keyPath: 'key' });
          history.createIndex('deletedAt', 'deletedAt');
        }
        if (! db.objectStoreNames.contains(this.historySettingsDbName)) {
          db.createObjectStore(this.historySettingsDbName, { keyPath: 'key' });
        }
      };
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Outline storage is blocked by another open connection. Close other extension views and retry.'));
      };
      request.onsuccess = (event) => {
        const db = event.target.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        log(`IDB opened: ${this.dbName}`);
        resolve(db);
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
      const nodes = Object.create(null);
      // open a cursor to iterate over all entries
      const request = store.openCursor();
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          try {
            const node = JSON.parse(cursor.value.data);
            const key = cursor.primaryKey ?? cursor.key ?? cursor.value.key;
            if (! isRecord(node) || typeof key !== 'string' || node.id !== key
              || Object.hasOwn(nodes, key)) {
              throw new TypeError('Stored record identity is invalid; export recovery data before repairing.');
            }
            nodes[key] = node;
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
      txn.onabort = () => reject(txn.error || new Error('Outline storage read aborted'));
    });
  }

  async loadHistoryState () {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction([this.historyDbName, this.historySettingsDbName], 'readonly');
      const rows = txn.objectStore(this.historyDbName).getAll();
      const settings = txn.objectStore(this.historySettingsDbName).get('retention');
      txn.oncomplete = () => {
        try { resolve({ rows: rows.result, policy: historyPolicy(settings.result?.policy || historyDefaults) }); }
        catch (err) { reject(err); }
      };
      txn.onerror = txn.onabort = () => reject(txn.error || new Error('History read failed'));
    });
  }

  async commitHistoryChange({ nodes = [], deleteNodeIds = [], add = null,
    consume = null, purge = [], policy = null, now = Date.now() } = {}) {
    // One transaction contains the recovery record, all affected tree records,
    // and pruning. No deleted branch can commit without its recovery data.
    const records = nodes.map(node => ({ key: node.id, data: JSON.stringify(node) }));
    const addition = add ? structuredClone(add) : null;
    const consumption = consume ? structuredClone(consume) : null;
    const chosenPolicy = policy ? historyPolicy(policy) : null;
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction([this.nodeDbName, this.historyDbName,
        this.historySettingsDbName], 'readwrite');
      const store = txn.objectStore(this.historyDbName);
      let failure, result;
      txn.oncomplete = () => resolve(result);
      txn.onerror = txn.onabort = () => reject(failure || txn.error || new Error('History transaction aborted'));
      const settings = txn.objectStore(this.historySettingsDbName).get('retention');
      const read = store.getAll();
      read.onsuccess = () => {
        try {
          const limits = chosenPolicy || historyPolicy(settings.result?.policy || historyDefaults);
          const rows = new Map(read.result.map(row => [row.key, row]));
          if (addition) {
            if (rows.has(addition.key)) throw new Error('This deletion action was already recorded');
            rows.set(addition.key, addition);
          }
          if (consumption) {
            const old = rows.get(consumption.key);
            if (! old || old.status !== 'deleted' || old.data !== consumption.expectedData) {
              throw new Error('This history entry changed or was already restored');
            }
            rows.set(old.key, { key: old.key, deletedAt: old.deletedAt,
              status: 'restored', result: consumption.result, bytes: 0 });
          }
          for (const key of purge) rows.delete(key);
          const pruned = historyPruneIds([...rows.values()], limits, now, addition?.key);
          for (const key of [...pruned, ...purge]) store.delete(key);
          if (addition) store.add(addition);
          if (consumption && ! pruned.includes(consumption.key)) store.put(rows.get(consumption.key));
          if (chosenPolicy) txn.objectStore(this.historySettingsDbName).put({ key: 'retention', policy: limits });
          const nodeStore = txn.objectStore(this.nodeDbName);
          for (const record of records) nodeStore.put(record);
          for (const key of deleteNodeIds) nodeStore.delete(key);
          result = { pruned: pruned.length, policy: limits };
        } catch (err) {
          failure = err;
          txn.abort();
        }
      };
    });
  }

  async loadRawRecords () {
    // Recovery exports retain opaque stored values, including malformed JSON.
    // Never parse, sanitize, rewrite, or silently discard the original data.
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const txn = db.transaction(this.nodeDbName, 'readonly');
      const request = txn.objectStore(this.nodeDbName).openCursor();
      const records = [];
      request.onsuccess = event => {
        const cursor = event.target.result;
        if (! cursor) { resolve(records); return; }
        records.push({ key: cursor.primaryKey ?? cursor.key ?? cursor.value.key,
          value: cursor.value });
        cursor.continue();
      };
      request.onerror = event => reject(event.target.error);
      txn.onabort = () => reject(txn.error || new Error('Recovery export read aborted'));
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
