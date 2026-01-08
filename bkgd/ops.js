// bkgd/ops.js: durable ops queue manager
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { IdGenerator } from '/common/id-generator.js';
import { warn } from '/common/common.js';

export class OpsQueue {

  constructor (db, opts = {}) {
    this.db = db;
    this.idGen = opts.idGen || new IdGenerator('op', 9, 2);
  }

  buildRecord (op) {
    const now = Date.now();
    // Keep records small and replay-friendly; state/cursor drive resumability.
    return {
      opId: op.opId || this.idGen.newId(),
      state: op.state || 'pending',
      type: op.type || 'intent',
      name: op.name || 'unknown',
      source: op.source || 'unknown',
      createdAt: op.createdAt || now,
      updatedAt: now,
      retryCount: op.retryCount || 0,
      lastError: op.lastError || null,
      payload: op.payload || {},
      cursor: op.cursor || null,
    };
  }

  // Store intent before work begins so operations can be resumed safely.
  async enqueue (op) {
    const record = this.buildRecord(op);
    await this.db.enqueueOp(record);
    return record;
  }

  async claimNextOps (limit = 1) {
    const pending = await this.db.listPendingOps(limit);
    const claimed = [];
    const now = Date.now();
    for (const op of pending) {
      const updated = await this.db.updateOp(op.opId, {
        state: 'running',
        updatedAt: now,
      });
      if (updated) {
        claimed.push(updated);
      } else {
        warn(`OpsQueue.claimNextOps: missing op ${op.opId}`);
      }
    }
    return claimed;
  }

  async countPendingOps () {
    return this.db.countOpsByState('pending');
  }

  async listFailedOps (limit = 50) {
    return this.db.listOpsByState('failed', limit);
  }

  async listRunningOps (limit = 50) {
    return this.db.listOpsByState('running', limit);
  }

  async requeueFailedOps ({ limit = 10, maxRetries = 3, minAgeMs = 1000 } = {}) {
    const failed = await this.listFailedOps(limit);
    const now = Date.now();
    let requeued = 0;
    for (const op of failed) {
      const retryCount = op.retryCount || 0;
      const updatedAt = op.updatedAt || 0;
      if (retryCount >= maxRetries) continue;
      if ((now - updatedAt) < minAgeMs) continue;
      const updated = await this.db.updateOp(op.opId, {
        state: 'pending',
        updatedAt: now,
      });
      if (updated) requeued += 1;
    }
    return requeued;
  }

  async requeueStaleRunningOps ({ limit = 10, minAgeMs = 30000 } = {}) {
    const running = await this.listRunningOps(limit);
    const now = Date.now();
    let requeued = 0;
    for (const op of running) {
      const updatedAt = op.updatedAt || 0;
      if ((now - updatedAt) < minAgeMs) continue;
      const updated = await this.db.updateOp(op.opId, {
        state: 'pending',
        updatedAt: now,
      });
      if (updated) requeued += 1;
    }
    return requeued;
  }

  async markDone (opId) {
    const updated = await this.db.updateOp(opId, {
      state: 'done',
      updatedAt: Date.now(),
      lastError: null,
    });
    if (! updated) {
      warn(`OpsQueue.markDone: missing op ${opId}`);
    }
    return updated;
  }

  async markFailed (opId, err) {
    const message = err && err.message ? err.message : String(err || 'unknown error');
    // First load the current op to get retryCount atomically
    const current = await this.db.loadOp(opId);
    if (! current) {
      warn(`OpsQueue.markFailed: missing op ${opId}`);
      return null;
    }
    const newRetryCount = (current.retryCount || 0) + 1;
    const updated = await this.db.updateOp(opId, {
      state: 'failed',
      updatedAt: Date.now(),
      lastError: message,
      retryCount: newRetryCount,
    });
    if (! updated) {
      warn(`OpsQueue.markFailed: op ${opId} disappeared during update`);
      return null;
    }
    return updated;
  }

  async updateCursor (opId, cursor) {
    const updated = await this.db.updateOp(opId, {
      cursor,
      updatedAt: Date.now(),
    });
    if (! updated) {
      warn(`OpsQueue.updateCursor: missing op ${opId}`);
    }
    return updated;
  }

}
