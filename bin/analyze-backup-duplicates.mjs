#!/usr/bin/env node
// analyze-backup-duplicates.mjs: audit duplicate nodes in a TKTSTO backup
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

function usage () {
  console.error(
    'Usage: node bin/analyze-backup-duplicates.mjs BACKUP.json'
    + ' [--report REPORT.json]'
  );
}

function parseArgs (args) {
  let input;
  let report;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ('--report' === arg) {
      report = args[i + 1];
      i += 1;
    } else if (! input) {
      input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (! input) throw new Error('Missing backup path');
  if (report === undefined && args.includes('--report')) {
    throw new Error('Missing --report path');
  }
  return { input, report };
}

function hash (value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function nodeContent (node) {
  // Browser attachment and timestamps are intentionally excluded.  They say
  // when/how a node was observed, not whether two saved nodes mean the same
  // thing to the user.
  return [
    node.type || '',
    node.label || '',
    node.note || '',
    node.title || '',
    node.url || '',
    node.faviconUrl || '',
    Boolean(node.pinned),
    node.checkbox ?? null,
    node.checkboxPx ?? null,
    node.incognito ?? null,
    node.discarded ?? null,
    node.frozen ?? null,
    node.hidden ?? null
  ];
}

function dedupeContent (node) {
  // Titles, favicons, discarded/frozen state, and timestamps routinely differ
  // between two captures of the same URL.  Preserve tree shape and every
  // user-authored field while ignoring those browser-generated differences.
  return [
    node.type || '',
    node.label || '',
    node.note || '',
    node.url || '',
    node.url ? '' : (node.title || ''),
    Boolean(node.pinned),
    node.checkbox ?? null,
    node.checkboxPx ?? null,
    node.incognito ?? null
  ];
}

function isMetadataBearing (node) {
  return Boolean(
    node.label
    || node.note
    || (undefined !== node.checkbox)
    || ((node.nodes || []).length > 0)
  );
}

function chooseKeeper (ids, nodes) {
  return [...ids].sort((a, b) => {
    const left = nodes[a];
    const right = nodes[b];
    const leftScore = [
      left.loaded ? 1 : 0,
      left.active ? 1 : 0,
      left.wasLoaded ? 1 : 0,
      left.atime || 0,
      left.mtime || 0,
      left.ctime || 0,
      left.id || ''
    ];
    const rightScore = [
      right.loaded ? 1 : 0,
      right.active ? 1 : 0,
      right.wasLoaded ? 1 : 0,
      right.atime || 0,
      right.mtime || 0,
      right.ctime || 0,
      right.id || ''
    ];
    for (let i = 0; i < leftScore.length; i += 1) {
      if (leftScore[i] < rightScore[i]) return 1;
      if (leftScore[i] > rightScore[i]) return -1;
    }
    return 0;
  })[0];
}

function buildGroups (items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (! groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.length > 1);
}

function main () {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage();
    throw err;
  }

  const inputBytes = readFileSync(parsedArgs.input);
  const backup = JSON.parse(inputBytes.toString('utf8'));
  if (! backup.nodes || ! backup.nodes.root) {
    throw new Error('Backup has no nodes.root');
  }
  const nodes = backup.nodes;
  const ids = Object.keys(nodes);
  const parents = new Map();
  const missingChildRefs = [];
  const multipleParents = [];

  for (const parent of Object.values(nodes)) {
    for (const childId of parent.nodes || []) {
      if (! nodes[childId]) {
        missingChildRefs.push({ parentId: parent.id, childId });
        continue;
      }
      if (parents.has(childId)) {
        multipleParents.push({
          nodeId: childId,
          parentIds: [parents.get(childId), parent.id]
        });
      } else {
        parents.set(childId, parent.id);
      }
    }
  }

  const reachable = new Set();
  const visiting = new Set();
  const cycles = [];
  function markReachable (nodeId) {
    if (visiting.has(nodeId)) {
      cycles.push(nodeId);
      return;
    }
    if (reachable.has(nodeId) || ! nodes[nodeId]) return;
    visiting.add(nodeId);
    reachable.add(nodeId);
    for (const childId of nodes[nodeId].nodes || []) {
      markReachable(childId);
    }
    visiting.delete(nodeId);
  }
  markReachable('root');

  const subtreeHashes = new Map();
  const dedupeSubtreeHashes = new Map();
  const subtreeSizes = new Map();
  function hashSubtree (nodeId, path = new Set()) {
    if (subtreeHashes.has(nodeId)) return subtreeHashes.get(nodeId);
    if (path.has(nodeId)) return hash(['cycle', nodeId]);
    const node = nodes[nodeId];
    if (! node) return hash(['missing', nodeId]);
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    const childHashes = (node.nodes || [])
      .map((childId) => hashSubtree(childId, nextPath));
    const result = hash([nodeContent(node), childHashes]);
    subtreeHashes.set(nodeId, result);
    let size = 1;
    for (const childId of node.nodes || []) {
      size += subtreeSizes.get(childId) || 0;
    }
    subtreeSizes.set(nodeId, size);
    return result;
  }
  for (const id of ids) hashSubtree(id);

  function hashDedupeSubtree (nodeId, path = new Set()) {
    if (dedupeSubtreeHashes.has(nodeId)) {
      return dedupeSubtreeHashes.get(nodeId);
    }
    if (path.has(nodeId)) return hash(['cycle', nodeId]);
    const node = nodes[nodeId];
    if (! node) return hash(['missing', nodeId]);
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    const childHashes = (node.nodes || [])
      .map((childId) => hashDedupeSubtree(childId, nextPath));
    const result = hash([dedupeContent(node), childHashes]);
    dedupeSubtreeHashes.set(nodeId, result);
    return result;
  }
  for (const id of ids) hashDedupeSubtree(id);

  const nodesWithUrl = ids.filter((id) => Boolean(nodes[id].url));
  const leafIds = ids.filter((id) =>
    id !== 'root'
    && nodes[id].type !== 'window'
    && (nodes[id].nodes || []).length === 0
  );
  const boringUrlLeafIds = leafIds.filter((id) =>
    Boolean(nodes[id].url) && (! isMetadataBearing(nodes[id]))
  );
  const windowIds = ids.filter((id) => nodes[id].type === 'window');

  const urlGroups = buildGroups(nodesWithUrl, (id) => nodes[id].url);
  const leafHash = new Map(
    boringUrlLeafIds.map((id) => [id, hash(nodeContent(nodes[id]))])
  );
  const globalLeafGroups = buildGroups(
    boringUrlLeafIds,
    (id) => leafHash.get(id)
  );
  const siblingLeafGroups = buildGroups(
    boringUrlLeafIds.filter((id) => parents.has(id)),
    (id) => `${parents.get(id)}\u0000${leafHash.get(id)}`
  );
  const dedupeLeafHash = new Map(
    boringUrlLeafIds.map((id) => [id, hash(dedupeContent(nodes[id]))])
  );
  const siblingSameUrlLeafGroups = buildGroups(
    boringUrlLeafIds.filter((id) => parents.has(id)),
    (id) => `${parents.get(id)}\u0000${dedupeLeafHash.get(id)}`
  );
  const subtreeGroups = buildGroups(
    ids.filter((id) => id !== 'root' && subtreeSizes.get(id) > 1),
    (id) => subtreeHashes.get(id)
  );
  const siblingSubtreeGroups = buildGroups(
    ids.filter((id) =>
      id !== 'root'
      && parents.has(id)
      && subtreeSizes.get(id) > 1
    ),
    (id) => `${parents.get(id)}\u0000${subtreeHashes.get(id)}`
  );
  const siblingDedupeSubtreeGroups = buildGroups(
    ids.filter((id) =>
      id !== 'root'
      && parents.has(id)
      && subtreeSizes.get(id) > 1
    ),
    (id) => `${parents.get(id)}\u0000${dedupeSubtreeHashes.get(id)}`
  );
  const windowGroups = buildGroups(
    windowIds,
    (id) => subtreeHashes.get(id)
  );

  function describeLeafGroup ([, groupIds]) {
    const keeperId = chooseKeeper(groupIds, nodes);
    return {
      count: groupIds.length,
      excess: groupIds.length - 1,
      keeperId,
      duplicateIds: groupIds.filter((id) => id !== keeperId),
      parentIds: [...new Set(groupIds.map((id) => parents.get(id) || null))],
      url: nodes[keeperId].url,
      title: nodes[keeperId].title || ''
    };
  }

  function describeSubtreeGroup ([, groupIds]) {
    const keeperId = chooseKeeper(groupIds, nodes);
    const size = subtreeSizes.get(keeperId);
    return {
      count: groupIds.length,
      subtreeSize: size,
      potentialNodeReduction: (groupIds.length - 1) * size,
      keeperId,
      duplicateIds: groupIds.filter((id) => id !== keeperId),
      parentIds: [...new Set(groupIds.map((id) => parents.get(id) || null))],
      type: nodes[keeperId].type || '',
      label: nodes[keeperId].label || '',
      title: nodes[keeperId].title || '',
      url: nodes[keeperId].url || ''
    };
  }

  const report = {
    source: {
      file: basename(parsedArgs.input),
      sha256: createHash('sha256').update(inputBytes).digest('hex'),
      schema: backup.$schema || null,
      exportDate: backup.metadata && backup.metadata.exportDate
    },
    integrity: {
      missingChildRefs,
      multipleParents,
      cycles: [...new Set(cycles)],
      unreachableNodeIds: ids.filter((id) => ! reachable.has(id))
    },
    counts: {
      nodes: ids.length,
      rootChildren: (nodes.root.nodes || []).length,
      windows: windowIds.length,
      nodesWithUrl: nodesWithUrl.length,
      uniqueUrls: nodesWithUrl.length - urlGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length - 1,
        0
      ),
      leafNodes: leafIds.length,
      boringUrlLeaves: boringUrlLeafIds.length,
      metadataBearingNodes: ids.filter((id) =>
        isMetadataBearing(nodes[id])
      ).length
    },
    repeatedUrls: {
      groups: urlGroups.length,
      occurrences: urlGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length,
        0
      ),
      excessOccurrences: urlGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length - 1,
        0
      ),
      largestGroup: Math.max(0, ...urlGroups.map(([, group]) => group.length))
    },
    exactBoringLeaves: {
      globalGroups: globalLeafGroups.length,
      globalExcess: globalLeafGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length - 1,
        0
      ),
      siblingGroups: siblingLeafGroups.length,
      siblingExcess: siblingLeafGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length - 1,
        0
      ),
      siblingCandidates: siblingLeafGroups
        .map(describeLeafGroup)
        .sort((a, b) => b.excess - a.excess)
    },
    sameUrlBoringSiblingLeaves: {
      groups: siblingSameUrlLeafGroups.length,
      excess: siblingSameUrlLeafGroups.reduce(
        (sum, [, groupIds]) => sum + groupIds.length - 1,
        0
      ),
      candidates: siblingSameUrlLeafGroups
        .map(describeLeafGroup)
        .sort((a, b) => b.excess - a.excess)
    },
    exactSubtrees: {
      globalGroups: subtreeGroups.length,
      siblingGroups: siblingSubtreeGroups.length,
      siblingPotentialNodeReduction: siblingSubtreeGroups.reduce(
        (sum, group) => {
          const idsInGroup = group[1];
          return sum + ((idsInGroup.length - 1) * subtreeSizes.get(idsInGroup[0]));
        },
        0
      ),
      siblingCandidates: siblingSubtreeGroups
        .map(describeSubtreeGroup)
        .sort((a, b) =>
          b.potentialNodeReduction - a.potentialNodeReduction
        )
    },
    sameContentSiblingSubtrees: {
      groups: siblingDedupeSubtreeGroups.length,
      potentialNodeReduction: siblingDedupeSubtreeGroups.reduce(
        (sum, group) => {
          const idsInGroup = group[1];
          return sum + ((idsInGroup.length - 1) * subtreeSizes.get(idsInGroup[0]));
        },
        0
      ),
      candidates: siblingDedupeSubtreeGroups
        .map(describeSubtreeGroup)
        .sort((a, b) =>
          b.potentialNodeReduction - a.potentialNodeReduction
        )
    },
    exactWindows: {
      groups: windowGroups.length,
      candidates: windowGroups
        .map(describeSubtreeGroup)
        .sort((a, b) =>
          b.potentialNodeReduction - a.potentialNodeReduction
        )
    }
  };

  if (parsedArgs.report) {
    writeFileSync(parsedArgs.report, JSON.stringify(report, null, 2) + '\n');
  }

  console.log(`Backup: ${report.source.file}`);
  console.log(`Nodes: ${report.counts.nodes}`);
  console.log(
    `Integrity: ${report.integrity.missingChildRefs.length} missing refs, `
    + `${report.integrity.multipleParents.length} multiple parents, `
    + `${report.integrity.cycles.length} cycles, `
    + `${report.integrity.unreachableNodeIds.length} unreachable`
  );
  console.log(
    `URLs: ${report.counts.nodesWithUrl} nodes, `
    + `${report.counts.uniqueUrls} unique, `
    + `${report.repeatedUrls.excessOccurrences} repeated occurrences`
  );
  console.log(
    `Exact boring leaf duplicates: `
    + `${report.exactBoringLeaves.globalExcess} global excess; `
    + `${report.exactBoringLeaves.siblingExcess} sibling excess`
  );
  console.log(
    `Same-URL boring sibling leaves: `
    + `${report.sameUrlBoringSiblingLeaves.groups} groups, `
    + `${report.sameUrlBoringSiblingLeaves.excess} excess`
  );
  console.log(
    `Exact duplicate sibling subtrees: `
    + `${report.exactSubtrees.siblingGroups} groups, `
    + `${report.exactSubtrees.siblingPotentialNodeReduction} potential nodes`
  );
  console.log(
    `Same-content sibling subtrees: `
    + `${report.sameContentSiblingSubtrees.groups} groups, `
    + `${report.sameContentSiblingSubtrees.potentialNodeReduction} potential nodes`
  );
  console.log(
    `Exact duplicate windows: ${report.exactWindows.groups} groups`
  );
  if (parsedArgs.report) {
    console.log(`Detailed report: ${parsedArgs.report}`);
  }
}

main();
