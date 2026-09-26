// Recently deleted management. Text-only metadata; no favicons or network URLs.
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later
"use strict";
import { api } from '/api.js';
import { emit } from '/common/common.js';
import { ThemedPage } from '/themes/themes.js';
import { historyPolicy } from '/common/deletion-history.js';

export class DeletedHistoryView {
  constructor(doc = document, send = emit) {
    this.doc = doc; this.send = send; this.rows = []; this.busy = false;
    this.serial = 0; this.settingsDirty = false; this.hasPolicy = false;
    this.get = id => doc.getElementById(id);
  }

  bind() {
    this.get('history-refresh').addEventListener('click', () => this.refresh());
    this.get('history-search').addEventListener('input', () => this.render());
    this.get('history-policy').addEventListener('input', () => { this.settingsDirty = true; });
    this.get('history-policy').addEventListener('submit', event => {
      event.preventDefault(); this.savePolicy();
    });
    return this.refresh();
  }

  status(text) { this.get('history-status').textContent = text; }
  error(err = null) {
    const element = this.get('history-error'); element.hidden = ! err;
    element.textContent = err ? String(err.message || err) : '';
  }

  async refresh(message = '', fromAction = false) {
    if (this.busy && ! fromAction) { this.refreshPending = true; return; }
    const serial = ++this.serial;
    this.get('history-list').setAttribute('aria-busy', 'true');
    try {
      const data = await this.send('bkgd_listDeleted');
      if (serial !== this.serial) return;
      if (! data || ! Array.isArray(data.entries)) throw new Error('History could not be loaded. Try Refresh.');
      this.rows = data.entries; this.policy = historyPolicy(data.policy);
      this.hasPolicy = true;
      if (! this.settingsDirty) {
        this.get('history-days').value = this.policy.days;
        this.get('history-entries').value = this.policy.entries;
        this.get('history-size').value = this.policy.bytes / 1048576;
      }
      this.error(); this.render();
      const size = data.bytes < 1048576 ? `${Math.ceil(data.bytes / 1024)} KiB`
        : `${(data.bytes / 1048576).toFixed(2)} MiB`;
      this.status(message || `${this.rows.length} recoverable ${this.rows.length === 1 ? 'action' : 'actions'} · ${size} recovery data`);
    } catch (err) {
      if (serial === this.serial) { this.error(err); this.status('History unavailable. Existing records have not been cleared.'); }
    } finally {
      if (serial === this.serial) this.get('history-list').setAttribute('aria-busy', 'false');
    }
  }

  render() {
    const query = this.get('history-search').value.toLocaleLowerCase();
    const shown = this.rows.filter(row => `${row.label} ${row.location}`.toLocaleLowerCase().includes(query));
    const list = this.get('history-list'); list.replaceChildren();
    const text = (name, value, className = '') => {
      const element = this.doc.createElement(name); element.textContent = value;
      if (className) element.className = className;
      return element;
    };
    for (const row of shown) {
      const article = this.doc.createElement('article'); article.className = 'history-entry';
      article.dataset.historyId = row.id;
      const content = this.doc.createElement('div');
      content.append(text('h2', row.label || 'Untitled branch'));
      content.append(text('p', `${row.nodeCount} nodes · ${row.tabCount} pages · ${new Date(row.deletedAt).toLocaleString()}`, 'history-meta'));
      content.append(text('p', `From: ${row.location || 'Session'}`, 'history-location'));
      const actions = this.doc.createElement('div'); actions.className = 'history-actions';
      const restore = text('button', 'Restore as saved'); restore.type = 'button';
      restore.dataset.action = 'restore'; restore.disabled = this.busy;
      restore.addEventListener('click', () => this.restore(row));
      const remove = text('button', 'Delete permanently', 'history-remove'); remove.type = 'button';
      remove.dataset.action = 'purge'; remove.disabled = this.busy;
      remove.addEventListener('click', () => this.purge(row));
      actions.append(restore, remove); article.append(content, actions); list.append(article);
    }
    this.get('history-empty').hidden = shown.length !== 0;
    this.get('history-empty').textContent = this.rows.length && query
      ? 'No branches match this search.' : 'No deleted branches to recover. Future outline deletions will appear here.';
  }

  confirm(message) {
    const dialog = this.get('history-confirm');
    if (dialog.open) return Promise.resolve(false);
    this.get('history-confirm-message').textContent = message;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once: true});
      dialog.showModal();
    });
  }

  async action(operation) {
    if (this.busy) return;
    this.busy = true; ++this.serial; this.error(); this.render();
    for (const control of this.get('history-policy').elements) control.disabled = true;
    let failure;
    try {
      const message = await operation();
      this.refreshPending = false;
      await this.refresh(message, true);
    } catch (err) { failure = err; this.error(err); }
    finally {
      this.busy = false;
      for (const control of this.get('history-policy').elements) control.disabled = false;
      this.render();
      if (this.refreshPending) {
        this.refreshPending = false; await this.refresh();
        if (failure) this.error(failure);
      }
    }
  }

  restore(row) {
    return this.action(async () => {
      const result = await this.send('bkgd_restoreDeleted', {entryId: row.id});
      if (! result?.restored && ! result?.alreadyRestored) throw new Error('Restore was not acknowledged. The entry has been retained.');
      return result.alreadyRestored ? 'This action was already restored; no duplicate was created.'
        : `Restored ${result.restored} nodes as saved${result.fallbackCount ? ' in a recovery location' : ''}. No pages were opened.`;
    });
  }

  async purge(row) {
    if (this.busy || ! await this.confirm(`Permanently remove “${row.label || 'Untitled branch'}” from local recovery history? This cannot be undone. Exported backups are unchanged.`)) return;
    return this.action(async () => {
      const result = await this.send('bkgd_purgeDeleted', {ids: [row.id]});
      if (! result?.purged) throw new Error('Removal was not acknowledged. Refresh before trying again.');
      return 'Removed from local recovery history. Exported backups are unchanged.';
    });
  }

  async savePolicy() {
    if (this.busy || ! this.hasPolicy) return;
    let policy;
    try {
      policy = historyPolicy({days:Number(this.get('history-days').value),
        entries:Number(this.get('history-entries').value), bytes:Number(this.get('history-size').value) * 1048576});
    } catch (err) { this.error(err); return; }
    if (! await this.confirm('Apply these retention limits? Older entries beyond any limit will be permanently removed now. Exported backups are unchanged.')) return;
    return this.action(async () => {
      await this.send('bkgd_historyPolicy', {policy}); this.settingsDirty = false;
      return 'Retention limits applied.';
    });
  }
}

if (! globalThis.__TKTSTO_TEST__) {
  const page = new DeletedHistoryView();
  new ThemedPage('/view/deleted').init().then(() => page.bind()).catch(err => page.error(err));
  const listener = msg => { if (msg?.msg === 'tree_historyChanged') page.refresh(); };
  api.runtime.onMessage.addListener(listener);
  let port, timer, closed = false;
  const connect = () => {
    if (closed) return;
    try {
      port = api.runtime.connect({name:'deletion-history'});
      port.onDisconnect.addListener(() => { timer = setTimeout(connect, 1000); });
    } catch { timer = setTimeout(connect, 1000); }
  };
  connect();
  window.addEventListener('focus', () => page.refresh());
  window.addEventListener('pagehide', () => {
    closed = true; clearTimeout(timer); port?.disconnect();
    api.runtime.onMessage.removeListener(listener);
  }, {once:true});
}
