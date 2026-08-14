// common/events.js: event helper functions
// Copyright (C) 2025 Selene ToyKeeper
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";

const modifierNames = {
  shift: 'Shift',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
};

const keyNames = {
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  insert: 'Insert',
  none: 'none',
};

export function normalizeKeyBinding (binding) {
  if ('string' !== typeof binding) return '';
  let key = binding.trim();
  if (! key) return '';

  const modifiers = new Set();
  while (true) {
    const separator = key.indexOf('+');
    if (separator < 0) break;
    const rawModifier = key.slice(0, separator).trim().toLowerCase();
    const modifier = modifierNames[rawModifier];
    if (! modifier) break;
    modifiers.add(modifier);
    key = key.slice(separator + 1);
  }
  key = key.trim();

  const knownName = keyNames[key.toLowerCase()];
  if (knownName) key = knownName;
  else if (1 === key.length) key = key.toUpperCase();
  else if (/^f\d+$/i.test(key)) key = key.toUpperCase();

  const orderedModifiers = ['Shift', 'Ctrl', 'Alt', 'Meta']
    .filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].join('+');
}

export function buildEventName (event, eventType) {
  const shift = (event.shiftKey && (event.key !== 'Shift'  )) ? 'Shift+' : '';
  const ctrl  = (event.ctrlKey  && (event.key !== 'Control')) ? 'Ctrl+'  : '';
  const alt   = (event.altKey   && (event.key !== 'Alt'    )) ? 'Alt+'   : '';
  const meta  = (event.metaKey  && (event.key !== 'Meta'   )) ? 'Meta+'  : '';

  let eventName;

  if ('keydown' === event.type) {
    let eventKey = event.key;
    if (eventKey === ' ') eventKey = 'Space';
    eventName = eventKey;
    // override CapsLock
    if (1 === eventName.length) eventName = eventName.toUpperCase();
  }
  else if (['mousedown', 'mouseup',
    'click', 'dblclick'].includes(event.type))
  {
    const buttonNames = ['Left', 'Middle', 'Right'];
    const clickNames = { mousedown: 'Press', mouseup: 'Release',
      click: 'Click', dblclick: 'DblClick' };
    const buttonName = buttonNames[event.button];
    const clickName = clickNames[event.type];
    if (buttonName) {
      eventName = `Mouse${clickName}${buttonName}`;
    }
  }
  else if (['DragStart', 'Drag', 'Drop', 'DragEnd', 'DragLeave',
    'DragOver'].includes(eventType))
  {
    eventName = `Mouse${eventType}`;
  }
  else if ('mouseover' === event.type) {
    eventName = 'MouseOver';
  }

  if (! eventName) {
    event.processedName = '';
    return '';
  }
  const fullEventName = normalizeKeyBinding(
    `${shift}${ctrl}${alt}${meta}${eventName}`
  );
  event.processedName = fullEventName;
  return fullEventName;
}
