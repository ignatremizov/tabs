// Persistent deletion recovery regressions.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
import { historyDefaults, historyPolicy, historyPruneIds, historyBytes,
  historyKey } from '/common/deletion-history.js';

export async function registerDeletionHistoryTests(h) {
  const { test, assert, assertEqual: eq } = h;
  const rejects = fn => { try { fn(); } catch { return true; } return false; };
  test('history limits reject invalid, disabled, and unbounded retention values', () => {
    eq(historyPolicy().entries, 200);
    for (const value of [null, [], { ...historyDefaults, days: 0 },
      { ...historyDefaults, entries: 1001 }, { ...historyDefaults, bytes: NaN },
      { ...historyDefaults, days: '30' }, { ...historyDefaults, unexpected: true }]) {
      assert(rejects(() => historyPolicy(value)));
    }
    for (const id of ['', '__proto__', '../entry', 'a'.repeat(161)]) {
      assert(rejects(() => historyKey(id)));
    }
    eq(historyKey('delete-123'), 'delete-123');
  });
  test('history pruning retains newest actions and handles equal timestamps', () => {
    const rows = [1, 2, 3].map(i => ({key: `entry-${i}`, deletedAt: 100,
      status: 'deleted', bytes: 100}));
    const pruned = historyPruneIds(rows, { ...historyDefaults, entries: 1 }, 100, 'entry-1');
    assert(!pruned.includes('entry-1')); eq(pruned.length, 2);
  });
  test('history pruning enforces both age and bytes, never deleting an oversized new action', () => {
    const now = 40 * 86400000;
    const rows = [{key: 'old', deletedAt: 0, bytes: 1, status: 'deleted'},
      {key: 'large', deletedAt: now, bytes: 1048577, status: 'deleted'}];
    assert(rejects(() => historyPruneIds(rows, { ...historyDefaults, bytes: 1048576 }, now, 'large')));
    const pruned = historyPruneIds(rows, historyDefaults, now);
    eq(pruned.join(','), 'old');
  });
  test('consumed history receipts are bounded without crowding out recoverable actions', () => {
    const rows = [1,2,3].map(i => ({key: `receipt-${i}`, deletedAt: i,
      status: 'restored', bytes: 0}));
    rows.push({key: 'recoverable', deletedAt: 0, status: 'deleted', bytes: 100});
    const pruned = historyPruneIds(rows, {...historyDefaults, entries: 1}, 4);
    eq(pruned.length, 2); assert(!pruned.includes('recoverable'));
    assert(historyBytes({text: '🔒'}) > JSON.stringify({text: '🔒'}).length);
  });
}
