// options/options.js: options page script
// Copyright (C) 2025-2026 Selene ToyKeeper and Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isFirefox } from '/api.js';

import {
  log, debug, warn, error, emit, sanitizeClientId
} from '/common/common.js';
import {
  buildEventName, normalizeKeyBinding
} from '/common/events.js';
import {
  defaultKeyBindings, keyBindingActions, normalizeKeyBindingOverrides
} from '/common/keybindings.js';
import { ThemedPage } from '/themes/themes.js';

log('options.js running');

class OptionsPage extends ThemedPage {

  constructor () {
    super(
      '/docs/docs',
      '/options/options'
    );
    this.cfgDefaults = {
      ...this.cfgDefaults,
      clientId: null,

      // TreeView behavior
      cursorFollowsActiveTab: true,
      activeTabExpandsItsParents: true,
      pinnedTabsOpenNewTabsPinnedToo: false,
      convertFromWindowWhenDroppedIntoWindow: true,
      hideTopButtonsDuringSearch: false,
      hideCollapsedTabs: false,
      loadExpandedBranchStyle: 'ask',
      loadCollapsedBranchStyle: 'ask',
      unloadExpandedBranchStyle: 'ask',
      unloadCollapsedBranchStyle: 'ask',
      deleteExpandedBranchStyle: 'one',
      deleteCollapsedBranchStyle: 'ask',

      // fork behavior
      defaultViewScope: 'auto',
      openWindowOnRootMove: false,
      openWindowOnRootLoadTopmost: false,
      reorderTabsOnCreate: true,
      focusActiveTabOnLoadOrEdit: false,
      moveDownIntoExpandedSibling: true,
      moveUpIntoExpandedSibling: true,
      dropTextNoteMode: 'prepend',
      nodesPerPage: 20,
      reconcileIntervalMinutes: 5,
      keyBindings: {},

      // backups
      humanFriendlyBackups: false,
      localBackupInterval: 0,
      backupOnStartup: true,

      // display state used outside ThemedPage
      wasLoadedNodeStats: true,
    };
  }

  async init () {
    await super.init();

    const checkboxes = [
      'expandedRowPrefix',
      'alwaysShowNodeStats',
      'wasLoadedNodeStats',
      'hideTreeLines',
      'hideCursorTreeLines',
      'hideWindowTreeLines',
      'showFavicons',
      'compactMode',
      'cursorFollowsActiveTab',
      'activeTabExpandsItsParents',
      'pinnedTabsOpenNewTabsPinnedToo',
      'convertFromWindowWhenDroppedIntoWindow',
      'hideTopButtonsDuringSearch',
      'openWindowOnRootMove',
      'openWindowOnRootLoadTopmost',
      'reorderTabsOnCreate',
      'focusActiveTabOnLoadOrEdit',
      'moveDownIntoExpandedSibling',
      'moveUpIntoExpandedSibling',
      'humanFriendlyBackups',
      'backupOnStartup',
    ];
    const selects = [
      'theme',
      'loadExpandedBranchStyle',
      'loadCollapsedBranchStyle',
      'unloadExpandedBranchStyle',
      'unloadCollapsedBranchStyle',
      'deleteExpandedBranchStyle',
      'deleteCollapsedBranchStyle',
      'defaultViewScope',
      'dropTextNoteMode',
    ];
    const lines = [
      'indentMargin',
      'indentMarginWindow',
      'indentPadding',
      'indentPaddingWindow',
      'expandedBranchBottomPadding',
      'leafToBranchSpacing',
      'windowTopLevelNodeSpacing',
      'detailsBoxHeight',
      'detailsBoxHeightNotesOnly',
    ];
    const presets = [
      'fontFamily',
      'fontSize',
      'rowHeight',
      'indentWidth',
    ];

    this.options = [
      new Option(this, {
        cfgKey: 'clientId',
        inputType: 'line',
        fromStr: (value) => this.parseClientId(value),
        afterSave: (value) => this.notifyClientIdChanged(value),
        debounceTime: 1000,
      }),
      ...selects.map((cfgKey) => new Option(this, {
        cfgKey,
        inputType: 'select',
      })),
      ...checkboxes.map((cfgKey) => new Option(this, {
        cfgKey,
        inputType: 'checkbox',
      })),
      ...lines.map((cfgKey) => new Option(this, {
        cfgKey,
        inputType: 'line',
        debounceTime: 1000,
      })),
      ...presets.map((cfgKey) => new PresetOption(this, {
        cfgKey,
        customElementId: `${cfgKey}Custom`,
        fallbackValue: this.cfgDefaults[cfgKey],
        debounceTime: 500,
      })),
      new Option(this, {
        cfgKey: 'userStyles',
        inputType: 'text',
        debounceTime: 1000,
      }),
      new Option(this, {
        cfgKey: 'nodesPerPage',
        inputType: 'number',
        fromStr: (value) => this.parseNumber(
          value, 'nodesPerPage', 1, 200, true
        ),
        debounceTime: 1000,
      }),
      new Option(this, {
        cfgKey: 'reconcileIntervalMinutes',
        inputType: 'number',
        fromStr: (value) => this.parseNumber(
          value, 'reconcileIntervalMinutes', 0, 120, true
        ),
        debounceTime: 1000,
      }),
      new Option(this, {
        cfgKey: 'localBackupInterval',
        elementId: 'localBackupHours',
        inputType: 'number',
        toStr: (minutes) => (Number(minutes) || 0) / 60,
        fromStr: (value) => {
          const hours = this.parseNumber(
            value, 'localBackupHours', 0, 1000, false
          );
          if (undefined === hours) return;
          return hours * 60;
        },
        debounceTime: 1000,
      }),
    ];

    if (isFirefox) {
      this.options.push(
        new Option(this, {
          cfgKey: 'hideCollapsedTabs',
          inputType: 'checkbox',
        })
      );
    } else {
      this.greyOut('hideCollapsedTabs');
    }

    for (const option of this.options) option.init();

    this.initBackfillFavicons();
    await initKeyBindingsForm();
    this.initSessionRestoreForm();
  }

  parseClientId (value) {
    const clientId = sanitizeClientId(value);
    const $input = this.$doc.getElementById('clientId');
    if (! clientId) {
      const message = 'Client ID must contain at least one letter or number.';
      $input.setCustomValidity(message);
      $input.reportValidity();
      warn(message);
      return;
    }
    $input.setCustomValidity('');
    return clientId;
  }

  async notifyClientIdChanged (clientId) {
    const response = await emit('bkgd_setClientId', { clientId });
    if (response && response.error) throw new Error(response.error);
  }

  parseNumber (value, name, min, max, integer) {
    const parsed = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
    if (! Number.isFinite(parsed) ||
        parsed < min ||
        parsed > max ||
        (integer && `${parsed}` !== `${value}`.trim())) {
      warn(`User entered invalid data into ${name}`);
      return;
    }
    return parsed;
  }

  initBackfillFavicons () {
    const $button = this.$doc.getElementById('backfillFavicons');
    const $status = this.$doc.getElementById('backfillFaviconsStatus');
    if (! $button || ! $status) return;

    $button.addEventListener('click', async () => {
      $button.disabled = true;
      $status.textContent = ' Working...';
      try {
        const result = await emit('bkgd_backfillFavicons', {});
        const updated = result ? result.updated : 0;
        const skipped = result ? result.skipped : 0;
        $status.textContent =
          ` Done. Updated ${updated} nodes; skipped ${skipped}.`;
      } catch (err) {
        warn('Favicon backfill failed:', err);
        $status.textContent = ` Error: ${err.message || err}`;
      } finally {
        $button.disabled = false;
      }
    });
  }

  initSessionRestoreForm () {
    this.initFileUpload(
      'tktsto-file',
      'bkgd_importBackupFile',
      ['.json']
    );
    this.initFileUpload(
      'tabs-outliner-file',
      'bkgd_importTabsOutliner',
      ['.html', '.tree']
    );
  }

  initFileUpload (baseId, signalName, allowedExtensions) {
    const $button = this.$doc.getElementById(`${baseId}-button`);
    const $input = this.$doc.getElementById(`${baseId}-input`);
    if (! $button || ! $input) {
      warn(`Missing file upload controls for ${baseId}`);
      return;
    }

    $button.addEventListener('click', async () => {
      if (! $input.files.length) {
        alert('Please select a file first.');
        return;
      }

      const originalText = $button.textContent;
      $button.disabled = true;
      try {
        for (const file of $input.files) {
          const filename = file.name.toLowerCase();
          const valid = allowedExtensions.some(
            (extension) => filename.endsWith(extension)
          );
          if (! valid) {
            alert(
              `Unsupported file type. Allowed extensions: `
              + allowedExtensions.join(', ')
            );
            continue;
          }
          if (filename.endsWith('.html') || filename.endsWith('.htm')) {
            alert(
              'HTML import is not implemented yet.\n\n'
              + 'Use Tabs Outliner’s “Export tree” feature to create '
              + 'a .tree file.'
            );
            continue;
          }

          $button.textContent = '... Loading ...';
          log(`loading ${file.name} (${file.size} bytes) ...`);
          try {
            const fileContent = await readFileAsText(file);
            const data = JSON.parse(fileContent);
            // A lost response must not import the same backup a second time.
            const response = await emit(signalName, {
              data,
              filename: file.name,
            }, { retry: false });
            if (response && response.error) {
              throw new Error(response.error);
            }
            const total = response ? response.total : 0;
            log(`${total} nodes imported from: "${file.name}"`);
            alert(`${total} nodes imported from: "${file.name}"`);
          } catch (err) {
            warn(`Could not import "${file.name}":`, err);
            alert(`Could not import "${file.name}": ${err.message || err}`);
          }
        }
      } finally {
        $button.textContent = originalText;
        $button.disabled = false;
      }
    });
  }

  greyOut (elementId) {
    const $elem = this.$doc.getElementById(elementId);
    if (! $elem) return warn(`No such page element: ${elementId}`);
    $elem.disabled = true;
    const $grey = $elem.parentElement || $elem;
    $grey.classList.add('greyed-out');
  }
}

export class Option {

  constructor (page, args) {
    this.page = page;
    this.cfg = page.cfg;
    this.cfgKey = args.cfgKey;
    this.elementId = args.elementId || this.cfgKey;
    this.inputType = args.inputType;
    this.toStr = args.toStr;
    this.fromStr = args.fromStr;
    this.afterSave = args.afterSave;
    this.debounceTime = args.debounceTime;
    this.debounceTimer = null;
  }

  init () {
    const $elem = this.page.$doc.getElementById(this.elementId);
    if (! $elem) {
      error(`No such page element: ${this.elementId}`);
      return;
    }
    this.$elem = $elem;

    debug(`${this.inputType}: ${this.cfgKey} = ${this.cfg[this.cfgKey]}`);
    let value = this.cfg[this.cfgKey];
    if (this.toStr) value = this.toStr(value);
    this.setValue(value);

    let eventName = 'input';
    if ('checkbox' === this.inputType ||
        'select' === this.inputType) {
      eventName = 'change';
    }

    $elem.addEventListener(eventName, () => {
      if (! this.debounceTime) {
        this.parseAndSave();
        return;
      }

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.$elem.classList.add('unsaved');
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.parseAndSave();
      }, this.debounceTime);
    });
  }

  getValue () {
    if ('checkbox' === this.inputType) return this.$elem.checked;
    return this.$elem.value;
  }

  setValue (value) {
    if ('checkbox' === this.inputType) {
      this.$elem.checked = Boolean(value);
      return;
    }
    this.$elem.value = value ?? '';
  }

  async parseAndSave (rawValue = this.getValue()) {
    let value = rawValue;
    if (this.fromStr) value = this.fromStr(value);
    if (undefined === value) return;

    try {
      await this.cfg.set(this.cfgKey, value);
      if (this.afterSave) await this.afterSave(value);

      let displayValue = value;
      if (this.toStr) displayValue = this.toStr(displayValue);
      if (displayValue !== rawValue) this.setValue(displayValue);
      this.$elem.classList.remove('unsaved');
      if (this.$customElem) {
        this.$customElem.classList.remove('unsaved');
      }
    } catch (err) {
      warn(`Could not save option "${this.cfgKey}":`, err);
    }
  }
}

export class PresetOption extends Option {

  constructor (page, args) {
    super(page, {
      ...args,
      inputType: 'select',
    });
    this.customElementId = args.customElementId;
    this.fallbackValue = args.fallbackValue;
  }

  init () {
    this.$elem = this.page.$doc.getElementById(this.elementId);
    this.$customElem = this.page.$doc.getElementById(this.customElementId);
    if (! this.$elem || ! this.$customElem) {
      error(
        `Missing preset option controls: `
        + `${this.elementId}, ${this.customElementId}`
      );
      return;
    }

    this.presetValues = new Set(
      [...this.$elem.options].map((option) => option.value)
    );
    if (! this.presetValues.has(this.fallbackValue)) {
      this.fallbackValue = this.$elem.options[0]?.value ?? '';
    }

    debug(`preset: ${this.cfgKey} = ${this.cfg[this.cfgKey]}`);
    this.setValue(this.cfg[this.cfgKey]);

    this.$elem.addEventListener('change', () => {
      this.cancelDebounce();
      this.$customElem.value = '';
      return this.parseAndSave(this.$elem.value);
    });
    this.$customElem.addEventListener('input', () => {
      return this.scheduleCustomSave();
    });
    this.$customElem.addEventListener('blur', () => {
      return this.flushCustomValue();
    });
    this.$customElem.addEventListener('keydown', (event) => {
      if ('Enter' !== event.key) return;
      event.preventDefault();
      return this.flushCustomValue();
    });
  }

  setValue (value) {
    const stringValue = value ?? '';
    if (this.presetValues.has(stringValue)) {
      this.$elem.value = stringValue;
      this.$customElem.value = '';
      return;
    }
    this.$elem.value = this.fallbackValue;
    this.$customElem.value = stringValue;
  }

  customValue () {
    return this.$customElem.value.trim() || this.$elem.value;
  }

  cancelDebounce () {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.$customElem.classList.remove('unsaved');
  }

  scheduleCustomSave () {
    this.cancelDebounce();
    this.$customElem.classList.add('unsaved');
    if (! this.debounceTime) {
      return this.parseAndSave(this.customValue());
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.parseAndSave(this.customValue());
    }, this.debounceTime);
  }

  flushCustomValue () {
    this.cancelDebounce();
    return this.parseAndSave(this.customValue());
  }
}

function readFileAsText (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error || new Error('File read failed'));
    };
    reader.onload = (event) => resolve(event.target.result);
    reader.readAsText(file);
  });
}

function buildDefaultBindingsByAction () {
  const defaults = {};
  for (const binding of keyBindingActions) {
    defaults[binding.action] = '';
  }
  for (const [key, action] of Object.entries(defaultKeyBindings)) {
    if ('none' === action) continue;
    if (! Object.prototype.hasOwnProperty.call(defaults, action)) continue;
    if (! defaults[action]) defaults[action] = key;
  }
  return defaults;
}

async function initKeyBindingsForm () {
  const $groups = document.getElementById('keybindings-groups');
  const $reset = document.getElementById('keybindings-reset');
  if (! $groups || ! $reset) return;

  const actionDefinitions = {};
  for (const binding of keyBindingActions) {
    actionDefinitions[binding.action] = binding;
  }

  const keyBindingGroups = [
    {
      label: 'Add / Remove',
      actions: [
        'loadOrEditNode',
        'deleteNode',
        'toggleLoad',
        'forceToggleLoad',
        'addNodeAsNextVisibleRow',
        'addNodeAsPrevVisibleRow',
      ],
    },
    {
      label: 'Edit',
      actions: [
        'wrapNodeInWindow',
        'toggleExpanded',
        'editNode',
        'detailsButton',
      ],
    },
    {
      label: 'Task',
      actions: ['taskEdit'],
    },
    {
      label: 'Search',
      actions: [
        'beginSearch',
        'searchForCurrent',
        'nextSearchResult',
        'prevSearchResult',
        'endSearch',
      ],
    },
    {
      label: 'Navigation',
      actions: [
        'cursorUp',
        'cursorDown',
        'cursorPrevSibling',
        'cursorNextSibling',
        'cursorLeft',
        'cursorRight',
        'cursorPgUp',
        'cursorPgDown',
        'cursorHome',
        'cursorEnd',
      ],
    },
    {
      label: 'Move',
      actions: [
        'moveNodeUp',
        'moveNodeDown',
        'moveNodeUpInvertNest',
        'moveNodeDownInvertNest',
        'moveNodeUpNoDescend',
        'moveNodeDownNoDescend',
        'moveNodeLeft',
        'moveNodeRight',
        'promoteChildren',
        'moveNodeHome',
        'moveNodeEnd',
      ],
    },
    {
      label: 'Mark / Paste',
      actions: [
        'toggleMarked',
        'unmarkAll',
        'pasteMarked',
        'pasteMarkedBefore',
      ],
    },
    {
      label: 'Miscellaneous',
      actions: [
        'backupSession',
        'generateTutorial',
      ],
    },
  ];

  const groupedActions = new Set(
    keyBindingGroups.flatMap((group) => group.actions)
  );
  const ungroupedActions = keyBindingActions
    .map((binding) => binding.action)
    .filter((action) => ! groupedActions.has(action));
  if (ungroupedActions.length) {
    keyBindingGroups.push({
      label: 'Other',
      actions: ungroupedActions,
    });
  }

  const defaultBindings = buildDefaultBindingsByAction();
  const stored = await api.storage.local.get({ keyBindings: {} });
  const storedBindings = normalizeKeyBindingOverrides(stored.keyBindings);
  const effectiveBindings = {};
  const inputs = {};

  function setInputValue (action) {
    inputs[action].value = effectiveBindings[action] || '';
  }

  function persistBindings () {
    const overrides = {};
    for (const binding of keyBindingActions) {
      const action = binding.action;
      const value = effectiveBindings[action] || '';
      const defaultValue = defaultBindings[action] || '';
      if (value !== defaultValue) overrides[action] = value;
    }
    api.storage.local.set({ keyBindings: overrides }).catch((err) => {
      error('Could not save keyboard shortcuts:', err);
    });
  }

  function applyBinding (action, newValue) {
    const normalized = normalizeKeyBinding(newValue);
    if (normalized && normalized !== effectiveBindings[action]) {
      for (const binding of keyBindingActions) {
        const otherAction = binding.action;
        if (otherAction === action) continue;
        if (effectiveBindings[otherAction] === normalized) {
          effectiveBindings[otherAction] = '';
          setInputValue(otherAction);
        }
      }
    }
    effectiveBindings[action] = normalized;
    setInputValue(action);
    persistBindings();
  }

  $groups.replaceChildren();

  const $header = document.createElement('div');
  $header.classList.add('shortcut-grid', 'shortcut-grid-header');
  for (const label of ['Action', 'Shortcut', 'Default']) {
    const $column = document.createElement('div');
    $column.textContent = label;
    $header.append($column);
  }
  $groups.append($header);

  for (const group of keyBindingGroups) {
    const $group = document.createElement('div');
    $group.classList.add('shortcut-group');

    const $title = document.createElement('div');
    $title.classList.add('shortcut-group-title');
    $title.textContent = group.label;
    $group.append($title);

    const $grid = document.createElement('div');
    $grid.classList.add('shortcut-grid');

    for (const action of group.actions) {
      const definition = actionDefinitions[action];

      const $label = document.createElement('div');
      $label.classList.add('shortcut-label');
      $label.textContent = definition ? definition.label : action;

      const $input = document.createElement('input');
      $input.type = 'text';
      $input.readOnly = true;
      $input.classList.add('shortcut-input');
      $input.dataset.action = action;
      $input.spellcheck = false;

      let value = defaultBindings[action] || '';
      if (Object.prototype.hasOwnProperty.call(storedBindings, action)) {
        value = storedBindings[action];
      }
      effectiveBindings[action] = value || '';
      inputs[action] = $input;
      setInputValue(action);

      const $default = document.createElement('div');
      $default.classList.add('shortcut-default');
      $default.textContent = defaultBindings[action]
        ? `Default: ${defaultBindings[action]}`
        : 'Default: (unbound)';

      $grid.append($label, $input, $default);

      $input.addEventListener('keydown', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if ('Escape' === event.key) {
          setInputValue(action);
          $input.blur();
          return;
        }
        if ('Backspace' === event.key || 'Delete' === event.key) {
          applyBinding(action, '');
          return;
        }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
          return;
        }
        applyBinding(action, buildEventName(event));
      });

      $input.addEventListener('focus', () => $input.select());
    }

    $group.append($grid);
    $groups.append($group);
  }

  $reset.addEventListener('click', () => {
    for (const binding of keyBindingActions) {
      const action = binding.action;
      effectiveBindings[action] = defaultBindings[action] || '';
      setInputValue(action);
    }
    api.storage.local.set({ keyBindings: {} }).catch((err) => {
      error('Could not reset keyboard shortcuts:', err);
    });
  });
}

if (! globalThis.__TKTSTO_TEST__) {
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const optionsPage = new OptionsPage();
      await optionsPage.init();
      log('options.js loaded');
    } catch (err) {
      error('Could not initialize options page:', err);
    }
  });
}
