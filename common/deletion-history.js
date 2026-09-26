// Bounded local deletion history. No browser bindings or cookie values live here.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";

export const historyDefaults = Object.freeze({
  days: 30,
  entries: 200,
  bytes: 32 * 1024 * 1024
});

export function historyPolicy(value = historyDefaults) {
  const limits = { days: [1, 3650], entries: [1, 1000], bytes: [1048576, 268435456] };
  if (! value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => ! Object.hasOwn(limits, key))) {
    throw new TypeError('Invalid deletion-history limits');
  }
  const result = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = value[key];
    if (! Number.isSafeInteger(number) || number < min || number > max) {
      throw new TypeError(`History ${key} must be an integer between ${min} and ${max}`);
    }
    result[key] = number;
  }
  return result;
}

export function historyKey(value) {
  if (typeof value !== 'string' || ! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) {
    throw new TypeError('Invalid deletion-history identifier');
  }
  return value;
}

export function historyBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function historyPruneIds(rows, policy, now = Date.now(), protectedId = null) {
  const limits = historyPolicy(policy);
  const cutoff = now - limits.days * 86400000;
  const sorted = [...rows].sort((a, b) => b.deletedAt - a.deletedAt
    || String(b.key).localeCompare(String(a.key)));
  const expired = [], deleted = [], receipts = [];
  for (const row of sorted) {
    if (row.deletedAt < cutoff && row.key !== protectedId) expired.push(row.key);
    else if (row.status === 'restored') receipts.push(row);
    else deleted.push(row);
  }
  // Keep the just-deleted action even when multiple actions have the same
  // millisecond timestamp. Never silently delete something too big to recover.
  if (protectedId) {
    const index = deleted.findIndex(row => row.key === protectedId);
    if (index >= 0) deleted.unshift(...deleted.splice(index, 1));
  }
  let total = 0, count = 0, full = false;
  for (const row of deleted) {
    if (! Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new TypeError('Invalid stored history size; history was not changed');
    }
    total += row.bytes;
    full ||= ++count > limits.entries || total > limits.bytes;
    if (full) {
      if (row.key === protectedId) {
        throw new Error('This branch exceeds the history size limit. Increase the limit or export a backup before deleting smaller branches. Nothing was deleted.');
      }
      expired.push(row.key);
    }
  }
  // Small consumed-action receipts make restore retries idempotent across
  // background restarts without retaining the deleted browsing data twice.
  expired.push(...receipts.slice(limits.entries).map(row => row.key));
  return expired;
}
