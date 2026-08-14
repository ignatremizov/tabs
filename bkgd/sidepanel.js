// bkgd/sidepanel.js: sidepanel init script
// Copyright (C) 2025-2026 Selene ToyKeeper
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';
import { log, warn } from '/common/common.js';

export function init() {
  // User can open the side panel by clicking the extension's icon
  if (isChrome) {
    if (undefined === api.sidePanel.close) {
      log('workaround: old Chrome has no sidePanel.close()');
    }
    // Browser-managed action clicks are still more reliable than manually
    // toggling the panel across the supported Chromium versions.
    api.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => warn(`Failed to set side-panel behavior: ${err}`));
  }

  // Firefox
  else if (isFirefox) {
    // Different API for Firefox.
    // This is handled in bkgd.onExtensionIconClicked()
    // So, nothing to do here.
  }
}
