// view/view.js: outline view script
// Copyright (C) 2025 Selene ToyKeeper
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { log, error } from '/common/common.js';
import { TreeView } from './treeview.js';

log('/view/view.js running');

function init() {
  const tree = new TreeView();
  tree.init().catch((err) => {
    error('TreeView initialization failed', err);
    tree.setStatus(`Initialization failed: ${err?.message || err}`);
  });
  return tree;
}


// init when page is ready
document.addEventListener('DOMContentLoaded', () => {
  init();
});
