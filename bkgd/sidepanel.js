// bkgd/sidepanel.js: sidepanel init script
// Copyright (C) 2025-2026 Selene ToyKeeper
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';
import { log, warn } from '/common/common.js';

export function init() {
  // User can open the side panel by clicking the extension's icon
  if (isChrome) {
    let oldChrome = false;
    if (undefined === api.sidePanel.close) {
      oldChrome = true;
      log('workaround: old Chrome has no sidePanel.close()');
    }
    // FIXME someday: the oldChrome method works better now, but
    // if they ever finish the sidePanel API, this should be removed
    oldChrome = true;  // <-- temporary override until Chrome is fixed
    api.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: oldChrome })
      .catch((err) => warn(`Failed to set side-panel behavior: ${err}`));

    // try to set which side the panel is on
    // this doesn't exist yet, as of Chrome 143
    // ... but just in case it gets added later, at least try it
    // (getLayout() exists, but there is no setLayout())
    // A left/right preference can be exposed if browsers consistently offer
    // a setter again; some vendors removed the UI/API around 2024.
    if ('function' === typeof api.sidePanel.setLayout) {
      try {
        Promise.resolve(
          api.sidePanel.setLayout({ side: 'left' })
        ).catch(
          (err) => warn(`Failed to set side-panel side: ${err}`)
        );
      } catch (err) {
        warn(`Failed to set side-panel side: ${err}`);
      }
    }
  }

  // Firefox
  else if (isFirefox) {
    // Different API for Firefox.
    // This is handled in bkgd.onExtensionIconClicked()
    // So, nothing to do here.
  }
}
