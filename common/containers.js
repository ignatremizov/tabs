// common/containers.js: cookie-store identity comparisons, without cookie data
// Copyright (C) 2026 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

export function cookieStoreKey(value) {
  const id = value?.cookieStoreId;
  if (typeof id === 'string' && id.length) return id;
  return value?.incognito ? 'firefox-private' : 'firefox-default';
}

export function sameCookieStore(left, right) {
  return cookieStoreKey(left) === cookieStoreKey(right);
}

export function isContainerTab(value) {
  return ! ['firefox-default', 'firefox-private'].includes(cookieStoreKey(value));
}
