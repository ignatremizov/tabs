// bkgd/containers.js: Firefox container metadata and fail-closed restoration
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isFirefox } from '/api.js';
import { warn } from '/common/common.js';
import { cookieStoreKey, isContainerTab } from '/common/containers.js';

const profileKey = 'nativeContainerProfileId';

export class Containers {
  constructor(bkgd) {
    this.bkgd = bkgd;
    this.profileId = undefined;
    this.identities = new Map();
    this.haveSnapshot = false;
  }

  get supported() {
    return Boolean(api.contextualIdentities?.query && api.contextualIdentities?.get);
  }

  async init() {
    if (! this.supported) return;
    try {
      const saved = await api.storage.local.get({ [profileKey]: null });
      this.profileId = saved[profileKey] || crypto.randomUUID();
      if (! saved[profileKey]) await api.storage.local.set({ [profileKey]: this.profileId });
    } catch (err) {
      // Default tabs remain usable, but named-container restoration cannot be
      // safe without a durable profile scope for the numeric cookie-store ID.
      this.profileId = undefined;
      warn('Could not initialize container profile identity', err);
    }
    await this.refresh();
  }

  fieldsForTab(tab) {
    if (tab?.cookieStoreId === undefined) return {};
    const fields = {
      cookieStoreId: tab.cookieStoreId,
      containerProfileId: undefined,
      containerName: undefined,
      containerColor: undefined,
      containerIcon: undefined,
      containerMissing: undefined
    };
    if (! isContainerTab(tab)) return fields;
    const identity = this.identities.get(tab.cookieStoreId);
    fields.containerProfileId = this.profileId;
    fields.containerMissing = this.haveSnapshot ? ! identity : undefined;
    if (identity) {
      fields.containerName = identity.name;
      fields.containerColor = identity.color;
      fields.containerIcon = identity.icon;
    }
    return fields;
  }

  async refresh() {
    if (! this.supported) return false;
    let identities;
    try {
      identities = await api.contextualIdentities.query({});
    } catch (err) {
      // API/permission failures are not evidence that containers were deleted.
      warn('Could not refresh Firefox containers', err);
      return false;
    }
    this.identities = new Map(identities.map(identity => [identity.cookieStoreId, identity]));
    this.haveSnapshot = true;
    const tree = this.bkgd?.tree;
    if (! tree) return false;
    let changed = false;
    await tree.runPersistenceBatch(async (args) => {
      for (const node of Object.values(tree.nodes)) {
        if (! isContainerTab(node)) continue;
        const local = Boolean(node.containerProfileId && this.profileId
          && node.containerProfileId === this.profileId);
        const identity = local && this.identities.get(node.cookieStoreId);
        const fields = { containerMissing: ! identity };
        if (identity) {
          fields.containerName = identity.name;
          fields.containerColor = identity.color;
          fields.containerIcon = identity.icon;
        }
        const changes = Object.fromEntries(Object.entries(fields)
          .filter(([key, value]) => node[key] !== value));
        if (! Object.keys(changes).length) continue;
        await node.setTabFields(changes, args);
        changed = true;
      }
    }, { reason: 'browserContext' });
    return changed;
  }

  async validateRestore(node, windowNode) {
    const store = cookieStoreKey(node);
    const privateWindow = windowNode
      ? Boolean(windowNode.isIncognito ? windowNode.isIncognito() : windowNode.incognito)
      : (store === 'firefox-private' || Boolean(node.incognito));
    const unknownLegacyStore = ! node.cookieStoreId && node.incognito === undefined;
    if (! isContainerTab(node)) {
      const privateTab = store === 'firefox-private';
      if (! unknownLegacyStore && privateTab !== privateWindow) {
        throw new Error('Cannot restore this tab across the private/regular browsing boundary.');
      }
      if (! isFirefox && ! this.supported) return undefined;
      return privateWindow ? 'firefox-private' : 'firefox-default';
    }
    const label = node.containerName || store;
    if (privateWindow) {
      throw new Error(`Cannot restore container “${label}” in a private window.`);
    }
    if (! this.supported) {
      throw new Error(`Cannot restore “${label}”: Firefox container support is unavailable. The saved tab was not opened in another session.`);
    }
    if (node.containerProfileId && node.containerProfileId !== this.profileId) {
      throw new Error(`Cannot restore “${label}”: this container reference belongs to another Firefox profile. Select the intended container manually in Firefox; no account was substituted.`);
    }
    if (! this.profileId) {
      throw new Error(`Cannot safely verify the Firefox profile for container “${label}”. The saved tab has not been opened.`);
    }
    if (! node.containerProfileId) {
      throw new Error(`Cannot restore “${label}”: the saved container's original Firefox profile is unknown. Open the URL in the intended container manually; no account was substituted.`);
    }
    let identity;
    try {
      // Recheck immediately before tab/window creation, not merely against a
      // startup cache: the user may have just deleted or renamed the identity.
      identity = await api.contextualIdentities.get(store);
    } catch {
      throw new Error(`Cannot restore “${label}”: the saved Firefox container is missing or inaccessible. The tab was not opened in another cookie store.`);
    }
    if (! identity || identity.cookieStoreId !== store) {
      throw new Error(`Cannot restore “${label}”: Firefox did not return the saved container.`);
    }
    this.identities.set(store, identity);
    return store;
  }
}
