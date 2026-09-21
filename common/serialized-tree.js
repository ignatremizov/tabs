// Validate serialized data before it can become mutable Node instances.
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

export const treeDataLimits = Object.freeze({
  nodes: 200000, edges: 400000, depth: 512,
  fieldLength: 16 * 1024 * 1024, textLength: 128 * 1024 * 1024
});
const strings = new Set([
  'id', 'type', 'cookieStoreId', 'containerProfileId', 'containerName',
  'containerColor', 'containerIcon', 'restoreError', 'groupTitle', 'groupColor',
  'windowState', 'label', 'note', 'title', 'url', 'faviconUrl', 'checkbox',
  'parent', 'parentId'
]);
const booleans = new Set([
  'containerMissing', 'nativeGroup', 'groupCollapsed', 'incognito', 'bookmark',
  'expanded', 'loaded', 'wasLoaded', 'active', 'pinned', 'marked',
  'discarded', 'frozen', 'hidden', 'wasActive'
]);
const integers = new Set(['windowId', 'tabId', 'groupId', 'groupWindowId', 'oldTabId']);
const numbers = new Set(['ctime', 'mtime', 'atime', 'ltime', 'checkboxPx',
  'sessionImportTime', 'sessionExportTime']);
const ignored = new Set(['oldTabId', 'wasActive', 'ltime', 'parentId',
  'sessionImportTime', 'sessionExportTime']);
const foreignBindings = new Set(['tabId', 'oldTabId', 'windowId', 'groupId',
  'groupWindowId', 'restoreError', 'marked']);
const reservedIds = new Set(['__proto__', 'constructor', 'prototype']);

export function isRecord(value) {
  if (! value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
    && ! reservedIds.has(id) && ! /[\u0000-\u001f]/.test(id);
}

function invalid(message) { throw new TypeError(`Invalid tree data: ${message}`); }

export function validateNodeGraph(hash, { importing = false, rootId = 'root' } = {}) {
  if (! isRecord(hash)) invalid('node dictionary is not an object');
  const ids = Object.keys(hash);
  if (! ids.length || ids.length > treeDataLimits.nodes) invalid('node count exceeds limits');
  if (! validId(rootId) || ! Object.hasOwn(hash, rootId)) invalid('root is missing');
  const records = Object.create(null), sourceChildren = new Map();
  let textLength = 0, edges = 0;
  for (const id of ids) {
    if (! validId(id)) invalid('unsafe node identifier');
    const source = Object.getOwnPropertyDescriptor(hash, id);
    if (! source || ! Object.hasOwn(source, 'value') || ! isRecord(source.value)) {
      invalid(`record ${id} is not plain data`);
    }
    const data = source.value;
    const record = { id, nodes: [] };
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(data))) {
      if (! Object.hasOwn(descriptor, 'value')) invalid(`accessor field ${key}`);
      const value = descriptor.value;
      if (! strings.has(key) && ! booleans.has(key) && ! numbers.has(key)
        && ! integers.has(key) && ! ['nodes', 'geometry'].includes(key)) {
        invalid(`unsupported field ${key}`);
      }
      // Null/undefined optional fields in old backups mean "not specified".
      if (value == null) continue;
      if (strings.has(key)) {
        if (typeof value !== 'string' || value.length > treeDataLimits.fieldLength) {
          invalid(`invalid text field ${key}`);
        }
        textLength += value.length;
        if (textLength > treeDataLimits.textLength) invalid('text size exceeds limits');
        if (key === 'id' && value !== id) invalid(`record ID differs from key ${id}`);
        if (key === 'type' && ! ['', 'window', 'tab'].includes(value)) invalid('unknown node type');
        if (key === 'checkbox' && value.length > 1) invalid('invalid checkbox');
      } else if (booleans.has(key)) {
        if (typeof value !== 'boolean') invalid(`invalid boolean ${key}`);
      } else if (numbers.has(key) || integers.has(key)) {
        if (! Number.isFinite(value) || (integers.has(key) && ! Number.isSafeInteger(value))) {
          invalid(`invalid number ${key}`);
        }
      } else if (key === 'geometry') {
        if (! Array.isArray(value) || value.length !== 4 || ! value.every(Number.isFinite)) {
          invalid('invalid window geometry');
        }
      } else if (key === 'nodes') {
        if (! Array.isArray(value) || ! value.every(validId)) invalid(`invalid children of ${id}`);
        edges += value.length;
        if (edges > treeDataLimits.edges) invalid('edge count exceeds limits');
        sourceChildren.set(id, [...value]);
        continue;
      }
      if (ignored.has(key) || (importing && foreignBindings.has(key))) continue;
      record[key] = Array.isArray(value) ? [...value] : value;
    }
    if (importing) {
      if (record.loaded) record.wasLoaded = true;
      record.loaded = false;
      record.active = false;
      record.marked = false;
    }
    records[id] = record;
  }

  const warnings = [], warningLimit = 50, order = [], parents = new Map();
  let warningCount = 0;
  const report = message => {
    if (! importing) invalid(message);
    warningCount++;
    if (warnings.length < warningLimit) warnings.push(message);
  };
  const traverse = (startId, parentId) => {
    const stack = [{ id: startId, parentId, depth: startId === rootId ? 0 : 1 }];
    while (stack.length) {
      const next = stack.pop();
      const { id, parentId: parent, depth } = next;
      if (depth > treeDataLimits.depth - (importing ? 1 : 0)) invalid('tree depth exceeds limits');
      if (! Object.hasOwn(records, id)) { report(`Missing child ${id}`); continue; }
      if (parents.has(id)) { report(`Repeated or cyclic edge to ${id}`); continue; }
      const record = records[id];
      if (! importing && record.parent != null && record.parent !== parent) {
        invalid(`parent/child relationship disagrees at ${id}`);
      }
      parents.set(id, parent); record.parent = parent; order.push(id);
      if (id !== rootId) records[parent].nodes.push(id);
      const children = sourceChildren.get(id) || [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ id: children[i], parentId: id, depth: depth + 1 });
      }
    }
  };
  traverse(rootId, rootId);
  for (const id of ids) {
    if (parents.has(id)) continue;
    if (! importing) invalid(`unreachable record ${id}`);
    report(`Recovered disconnected record ${id} under the imported root`);
    traverse(id, rootId);
  }
  if (warningCount > warnings.length) warnings.push(`${warningCount - warnings.length} additional graph warnings`);
  return { records, order, rootId, warnings };
}

// Convert the existing Tabs Outliner parser's nested data without recursive
// traversal or executing arbitrary properties. Validation still happens below.
export function nestedRecordsToHash(nodes) {
  if (! Array.isArray(nodes) || ! nodes.length) invalid('import has no roots');
  const hash = Object.create(null), seen = new Set();
  const rootId = 'root';
  hash[rootId] = { id: rootId, label: 'Imported sessions', nodes: [] };
  const stack = nodes.slice().reverse().map(node => ({ node, parent: rootId, depth: 0 }));
  let sequence = 0;
  while (stack.length) {
    const { node, parent, depth } = stack.pop();
    if (! isRecord(node) || seen.has(node)) invalid('cyclic or invalid nested import');
    if (depth > treeDataLimits.depth || ++sequence >= treeDataLimits.nodes) invalid('nested import exceeds limits');
    seen.add(node);
    const id = `nested-${sequence}`;
    const data = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      if (! Object.hasOwn(descriptor, 'value')) invalid(`accessor field ${key}`);
      if (key !== 'nodes') Object.defineProperty(data, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    }
    data.id = id; data.nodes = [];
    hash[id] = data; hash[parent].nodes.push(id);
    const children = node.nodes ?? [];
    if (! Array.isArray(children)) invalid('invalid nested children');
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], parent: id, depth: depth + 1 });
  }
  // Preserve the original single-root workflow without an unnecessary wrapper.
  if (hash[rootId].nodes.length === 1) {
    const only = hash[rootId].nodes[0];
    hash[rootId] = { ...hash[only], id: rootId };
    delete hash[only];
  }
  return hash;
}
