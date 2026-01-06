// options/client-id-form.js: client ID options form helpers
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';
import { warn, sanitizeClientId } from '/common/common.js';

export function initClientIdForm () {
  const form = document.getElementById('options-form');
  const clientIdInput = document.getElementById('client-id');

  if (! form || ! clientIdInput) {
    warn('initClientIdForm(): missing options form elements');
    return;
  }

  // load saved client ID
  api.storage.local.get('clientId').then((result) => {
    if (result.clientId) {
      clientIdInput.value = result.clientId;
    }
  });

  clientIdInput.addEventListener('blur', () => {
    const rawClientId = clientIdInput.value;
    const clientId = sanitizeClientId(rawClientId);
    if (clientId !== rawClientId) clientIdInput.value = clientId;
  });

  // save on form submit
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const rawClientId = clientIdInput.value;
    const clientId = sanitizeClientId(rawClientId);
    if (! clientId) {
      warn('Client ID must contain letters or numbers.');
      alert('Client ID must contain letters or numbers.');
      return;
    }
    if (clientId !== rawClientId) clientIdInput.value = clientId;
    api.storage.local.set({ clientId }).then(() => {
      alert('Saved!');
    });
    api.runtime.sendMessage({
      'msg':'bkgd_setClientId',
      'clientId': clientId
    });
  });
}
