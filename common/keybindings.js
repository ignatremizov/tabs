// common/keybindings.js: default key bindings and metadata
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

import { normalizeKeyBinding } from '/common/events.js';

export const defaultKeyBindings = {
  // test
  //'A': 'addNode',
  // add / remove nodes
  'Enter': 'loadOrEditNode',
  'D': 'deleteNode',
  'U': 'toggleLoad',
  'Shift+U': 'forceToggleLoad',
  'O': 'addNodeAsNextVisibleRow',
  'Shift+O': 'addNodeAsPrevVisibleRow',
  'W': 'wrapNodeInWindow',
  // edit nodes
  'Space': 'toggleExpanded',
  'E': 'editNode',
  // task status
  //'X': 'toggleTaskDone',
  //'T': 'taskLeaderKey',
  'T': 'taskEdit',
  // search
  '/': 'beginSearch',
  'Shift+*': 'searchForCurrent',  // match current label, url, or title
  //'Ctrl+F': 'beginSearch',
  //'Ctrl+G': 'nextSearchResult',
  'N': 'nextSearchResult',
  'Shift+N': 'prevSearchResult',
  'Escape': 'endSearch',
  // cursor movement
  'ArrowUp': 'cursorUp',
  'ArrowDown': 'cursorDown',
  'Ctrl+ArrowUp': 'cursorPrevSibling',
  'Ctrl+ArrowDown': 'cursorNextSibling',
  'ArrowLeft': 'cursorLeft',
  'ArrowRight': 'cursorRight',
  'PageUp': 'cursorPgUp',
  'PageDown': 'cursorPgDown',
  'Home': 'cursorHome',
  'End': 'cursorEnd',
  // move current node
  // move by one visible row, period
  'Shift+ArrowUp': 'moveNodeUp',
  'Shift+ArrowDown': 'moveNodeDown',
  'Shift+Alt+ArrowUp': 'moveNodeUpInvertNest',
  'Shift+Alt+ArrowDown': 'moveNodeDownInvertNest',
  // move by one sibling, never going to a deeper level (but maybe higher)
  'Shift+PageUp': 'moveNodeUpNoDescend',
  'Shift+PageDown': 'moveNodeDownNoDescend',
  // move shallower or deeper
  'Shift+ArrowLeft': 'moveNodeLeft',
  'Shift+ArrowRight': 'moveNodeRight',
  'Shift+Ctrl+ArrowLeft': 'promoteChildren',
  // move to first / last position
  'Shift+Home': 'moveNodeHome',
  'Shift+End': 'moveNodeEnd',
  // mark / paste
  'M': 'toggleMarked',
  'Shift+M': 'unmarkAll',
  'P': 'pasteMarked',
  'Shift+P': 'pasteMarkedBefore',
  // TODO: leader key for batch processing of other things,
  //   like delete and maybe sort and checkbox actions and ...
  // buttons
  'B': 'backupSession',
  // misc
  'I': 'detailsButton',
  'Shift+?': 'generateTutorial',
  'Tab': 'none',
  'none': 'none'
};

export const keyBindingActions = [
  { action: 'loadOrEditNode', label: 'Open/load node (or edit label)' },
  { action: 'deleteNode', label: 'Delete node' },
  { action: 'toggleLoad', label: 'Load/unload node or branch' },
  { action: 'forceToggleLoad', label: 'Force load/unload (skip prompts)' },
  { action: 'addNodeAsNextVisibleRow', label: 'Add node below' },
  { action: 'addNodeAsPrevVisibleRow', label: 'Add node above' },
  { action: 'wrapNodeInWindow', label: 'Wrap in window / convert label' },
  { action: 'toggleExpanded', label: 'Expand/collapse branch' },
  { action: 'editNode', label: 'Edit node' },
  { action: 'taskEdit', label: 'Edit task/checkbox' },
  { action: 'beginSearch', label: 'Begin search' },
  { action: 'searchForCurrent', label: 'Search for current node' },
  { action: 'nextSearchResult', label: 'Next search result' },
  { action: 'prevSearchResult', label: 'Previous search result' },
  { action: 'endSearch', label: 'End search' },
  { action: 'cursorUp', label: 'Cursor up' },
  { action: 'cursorDown', label: 'Cursor down' },
  {
    action: 'cursorPrevSibling',
    label: 'Cursor to previous sibling or parent'
  },
  {
    action: 'cursorNextSibling',
    label: 'Cursor to next sibling after this branch'
  },
  { action: 'cursorLeft', label: 'Cursor left (parent)' },
  { action: 'cursorRight', label: 'Cursor right (child)' },
  { action: 'cursorPgUp', label: 'Cursor page up' },
  { action: 'cursorPgDown', label: 'Cursor page down' },
  { action: 'cursorHome', label: 'Cursor to first node' },
  { action: 'cursorEnd', label: 'Cursor to last node' },
  { action: 'moveNodeUp', label: 'Move node up' },
  { action: 'moveNodeDown', label: 'Move node down' },
  { action: 'moveNodeUpInvertNest', label: 'Move node up (invert nesting)' },
  { action: 'moveNodeDownInvertNest', label: 'Move node down (invert nesting)' },
  { action: 'moveNodeUpNoDescend', label: 'Move node up (same level)' },
  { action: 'moveNodeDownNoDescend', label: 'Move node down (same level)' },
  { action: 'moveNodeLeft', label: 'Move node left (outdent)' },
  { action: 'moveNodeRight', label: 'Move node right (indent)' },
  {
    action: 'promoteChildren',
    label: 'Promote children and keep current node'
  },
  { action: 'moveNodeHome', label: 'Move node to top' },
  { action: 'moveNodeEnd', label: 'Move node to bottom' },
  { action: 'toggleMarked', label: 'Toggle mark' },
  { action: 'unmarkAll', label: 'Unmark all' },
  { action: 'pasteMarked', label: 'Paste marked' },
  { action: 'pasteMarkedBefore', label: 'Paste marked before' },
  { action: 'backupSession', label: 'Backup session' },
  { action: 'detailsButton', label: 'Toggle details' },
  { action: 'generateTutorial', label: 'Generate tutorial' }
];

export function normalizeKeyBindingOverrides (bindings) {
  if (! bindings || ('object' !== typeof bindings)) return {};

  const normalized = {};
  for (const [action, key] of Object.entries(bindings)) {
    if ('string' !== typeof key) continue;
    normalized[action] = normalizeKeyBinding(key);
  }

  if (! Object.prototype.hasOwnProperty.call(normalized, 'toggleLoad')) {
    const hasLegacyLoad =
      Object.prototype.hasOwnProperty.call(normalized, 'loadNode');
    const hasLegacyUnload =
      Object.prototype.hasOwnProperty.call(normalized, 'unloadNode');
    if (hasLegacyLoad || hasLegacyUnload) {
      // Older fork builds exposed separate fields. Prefer the unload binding
      // when both differ because that was the original fork action.
      normalized.toggleLoad =
        normalized.unloadNode || normalized.loadNode || '';
    }
  }
  delete normalized.loadNode;
  delete normalized.unloadNode;

  return normalized;
}
