// common/keybindings.js: default key bindings and metadata
// Copyright (C) 2025 Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

export const defaultKeyBindings = {
  // test
  //'a': 'addNode',
  // add / remove nodes
  'Enter': 'loadOrEditNode',
  'd': 'deleteNode',
  'l': 'loadNode',
  'u': 'unloadNode',
  'Shift+U': 'forceToggleLoad',
  'o': 'addNodeAsNextVisibleRow',
  'Shift+O': 'addNodeAsPrevVisibleRow',
  'w': 'wrapNodeInWindow',
  // edit nodes
  'Space': 'toggleExpanded',
  'e': 'editNode',
  // task status
  //'x': 'toggleTaskDone',
  //'t': 'taskLeaderKey',
  't': 'taskEdit',
  // search
  '/': 'beginSearch',
  'Shift+*': 'searchForCurrent',  // match current label, url, or title
  //'Ctrl+f': 'beginSearch',
  //'Ctrl+g': 'nextSearchResult',
  'n': 'nextSearchResult',
  'Shift+N': 'prevSearchResult',
  'Escape': 'endSearch',
  // cursor movement
  'ArrowUp': 'cursorUp',
  'ArrowDown': 'cursorDown',
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
  // move to first / last position
  'Shift+Home': 'moveNodeHome',
  'Shift+End': 'moveNodeEnd',
  // mark / paste
  'm': 'toggleMarked',
  'Shift+M': 'unmarkAll',
  'p': 'pasteMarked',
  'Shift+P': 'pasteMarkedBefore',
  // TODO: leader key for batch processing of other things,
  //   like delete and maybe sort and checkbox actions and ...
  // buttons
  'b': 'backupSession',
  // misc
  'i': 'detailsButton',
  'Shift+?': 'generateTutorial',
  'Tab': 'none',
  'none': 'none'
};

export const keyBindingActions = [
  { action: 'loadOrEditNode', label: 'Open/load node (or edit label)' },
  { action: 'deleteNode', label: 'Delete node' },
  { action: 'loadNode', label: 'Load node or branch' },
  { action: 'unloadNode', label: 'Unload node' },
  { action: 'forceToggleLoad', label: 'Force load/unload' },
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
