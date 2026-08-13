#!/usr/bin/env node
// clean-backup-duplicates.mjs: apply a conservative TKTSTO duplicate audit
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function usage () {
  console.error(
    'Usage: node bin/clean-backup-duplicates.mjs'
    + ' BACKUP.json AUDIT.json OUTPUT.json'
  );
}

function isBoringUrlLeaf (node) {
  return Boolean(
    node
    && node.type !== 'window'
    && node.url
    && (! node.label)
    && (! node.note)
    && (undefined === node.checkbox)
    && ((node.nodes || []).length === 0)
  );
}

function main () {
  const [inputPath, auditPath, outputPath, ...extra] =
    process.argv.slice(2);
  if (! inputPath || ! auditPath || ! outputPath || extra.length > 0) {
    usage();
    process.exit(2);
  }

  const inputBytes = readFileSync(inputPath);
  const backup = JSON.parse(inputBytes.toString('utf8'));
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  if (! backup.nodes || ! backup.nodes.root) {
    throw new Error('Backup has no nodes.root');
  }
  if (audit.source.file !== basename(inputPath)) {
    throw new Error(
      `Audit source "${audit.source.file}" does not match "${basename(inputPath)}"`
    );
  }
  const inputHash = createHash('sha256').update(inputBytes).digest('hex');
  if (audit.source.sha256 !== inputHash) {
    throw new Error('Audit checksum does not match backup');
  }
  if (audit.counts.nodes !== Object.keys(backup.nodes).length) {
    throw new Error('Audit node count does not match backup');
  }

  const nodes = backup.nodes;
  const parents = new Map();
  for (const parent of Object.values(nodes)) {
    for (const childId of parent.nodes || []) {
      if (! nodes[childId]) {
        throw new Error(`Missing child "${childId}" of "${parent.id}"`);
      }
      if (parents.has(childId)) {
        throw new Error(`Node "${childId}" has multiple parents`);
      }
      parents.set(childId, parent.id);
    }
  }

  const removeIds = new Set();
  const subtreeRootIds = new Set();
  function markSubtree (nodeId) {
    if (removeIds.has(nodeId)) return;
    const node = nodes[nodeId];
    if (! node) throw new Error(`Cannot remove missing node "${nodeId}"`);
    removeIds.add(nodeId);
    for (const childId of node.nodes || []) markSubtree(childId);
  }

  for (const candidate of
    audit.sameContentSiblingSubtrees.candidates || []) {
    const allIds = [candidate.keeperId, ...candidate.duplicateIds];
    // A larger duplicate subtree may already contain this whole candidate.
    // Let the maximal cleanup own it so a nested group's independently chosen
    // keeper cannot punch a hole in the retained copy.
    if (allIds.some((id) => removeIds.has(id))) continue;
    const parentIds = new Set(allIds.map((id) => parents.get(id)));
    if (parentIds.size !== 1 || parentIds.has(undefined)) {
      throw new Error('Subtree candidate is not a sibling group');
    }
    for (const duplicateId of candidate.duplicateIds) {
      subtreeRootIds.add(duplicateId);
      markSubtree(duplicateId);
    }
  }

  let leafDuplicatesRemoved = 0;
  for (const candidate of
    audit.sameUrlBoringSiblingLeaves.candidates || []) {
    const allIds = [candidate.keeperId, ...candidate.duplicateIds];
    if (allIds.some((id) => removeIds.has(id))) continue;
    const parentIds = new Set(allIds.map((id) => parents.get(id)));
    if (parentIds.size !== 1 || parentIds.has(undefined)) {
      throw new Error('Leaf candidate is not a sibling group');
    }
    if (! allIds.every((id) => isBoringUrlLeaf(nodes[id]))) {
      throw new Error('Leaf candidate contains protected content');
    }
    const urls = new Set(allIds.map((id) => nodes[id].url));
    const pinnedStates = new Set(allIds.map((id) => Boolean(nodes[id].pinned)));
    if (urls.size !== 1 || pinnedStates.size !== 1) {
      throw new Error('Leaf candidate URL or pinned state differs');
    }
    for (const duplicateId of candidate.duplicateIds) {
      if (! removeIds.has(duplicateId)) leafDuplicatesRemoved += 1;
      removeIds.add(duplicateId);
    }
  }

  if (removeIds.has('root')) throw new Error('Refusing to remove root');
  for (const node of Object.values(nodes)) {
    if (! node.nodes) continue;
    node.nodes = node.nodes.filter((childId) => ! removeIds.has(childId));
  }
  for (const nodeId of removeIds) delete nodes[nodeId];

  const reachable = new Set();
  function markReachable (nodeId) {
    if (reachable.has(nodeId)) return;
    const node = nodes[nodeId];
    if (! node) throw new Error(`Cleaned graph references missing "${nodeId}"`);
    reachable.add(nodeId);
    for (const childId of node.nodes || []) markReachable(childId);
  }
  markReachable('root');
  const remainingIds = Object.keys(nodes);
  if (reachable.size !== remainingIds.length) {
    throw new Error(
      `Cleaned graph has ${remainingIds.length - reachable.size} unreachable nodes`
    );
  }

  if (! backup.metadata) backup.metadata = {};
  backup.metadata.deduplication = {
    mode: 'conservative-sibling-only',
    sourceFile: basename(inputPath),
    cleanedAt: Date.now(),
    removedNodes: removeIds.size,
    removedDuplicateLeaves: leafDuplicatesRemoved,
    removedDuplicateSubtreeRoots: subtreeRootIds.size,
    rules: [
      'same-parent metadata-free leaves with identical URL and pinned state',
      'same-parent subtrees with identical user content and tree shape'
    ]
  };

  writeFileSync(outputPath, JSON.stringify(backup));
  console.log(`Source nodes: ${audit.counts.nodes}`);
  console.log(`Removed nodes: ${removeIds.size}`);
  console.log(`Remaining nodes: ${remainingIds.length}`);
  console.log(`Duplicate leaves removed: ${leafDuplicatesRemoved}`);
  console.log(`Duplicate subtree roots removed: ${subtreeRootIds.size}`);
  console.log(`Cleaned backup: ${outputPath}`);
}

main();
