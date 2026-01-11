// options/options.js: options page script
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import { log, warn, debug, emit } from '/common/common.js';
import { buildEventName } from '/common/events.js';
import { defaultKeyBindings, keyBindingActions } from '/common/keybindings.js';
import { initClientIdForm } from '/options/client-id-form.js';

log('options.js running');

function initBackupsForm () {
  // humanFriendlyBackups checkbox
  const $humanFriendlyBackups = document.getElementById('humanFriendlyBackups');
  api.storage.local.get('humanFriendlyBackups').then((result) => {
    if (undefined !== result.humanFriendlyBackups) {
      $humanFriendlyBackups.checked = result.humanFriendlyBackups;
    }
  });
  // save on click
  $humanFriendlyBackups.addEventListener('click', (event) => {
    //debug(`humanFriendlyBackups: ${$humanFriendlyBackups.checked}`, $humanFriendlyBackups);
    const humanFriendlyBackups = $humanFriendlyBackups.checked;
    api.storage.local.set({ humanFriendlyBackups });
  });

  // automatic local backup interval
  const $localBackupHours = document.getElementById('localBackupHours');
  const $backupOnStartup = document.getElementById('backupOnStartup');
  api.storage.local.get(['localBackupInterval'], (result) => {
    if (undefined !== result.localBackupInterval) {
      $localBackupHours.value = result.localBackupInterval / 60;
    }
  });
  api.storage.local.get({ backupOnStartup: true }).then((result) => {
    $backupOnStartup.checked = result.backupOnStartup;
  });
  let localBackupHoursDebounceTimer;
  $localBackupHours.addEventListener("input", () => {
    clearTimeout(localBackupHoursDebounceTimer);

    localBackupHoursDebounceTimer = setTimeout(() => {
      const hours = parseFloat($localBackupHours.value);

      // validate the input
      if (isNaN(hours) || hours < 0 || hours > 1000) {
        warn('User entered invalid data into localBackupHours input');
        return;
      }

      const minutes = hours * 60;
      api.storage.local.set({ localBackupInterval: minutes });
      debug(`User set localBackupInterval = ${minutes} minutes`);
    }, 3000); // 3 second debounce delay
  });
  $backupOnStartup.addEventListener('click', () => {
    api.storage.local.set({ backupOnStartup: $backupOnStartup.checked });
  });
}

function initThemeForm () {
  // theme selector
  const $theme = document.getElementById('theme');
  api.storage.local.get('theme').then((result) => {
    if (undefined !== result.theme) {
      $theme.value = result.theme;
    }
  });
  // save when changed
  $theme.addEventListener('change', (event) => {
    const theme = $theme.value;
    api.storage.local.set({ theme });
  });

  // expandedRowPrefix checkbox
  const $expandedRowPrefix = document.getElementById('expandedRowPrefix');
  api.storage.local.get({'expandedRowPrefix': true}).then((result) => {
    if (undefined !== result.expandedRowPrefix) {
      $expandedRowPrefix.checked = result.expandedRowPrefix;
    }
  });
  // save on click
  $expandedRowPrefix.addEventListener('click', (event) => {
    const expandedRowPrefix = $expandedRowPrefix.checked;
    api.storage.local.set({ expandedRowPrefix });
  });
}

function initBehaviorForm () {
  const $defaultViewScope = document.getElementById('defaultViewScope');
  const $openWindowOnRootMove = document.getElementById('openWindowOnRootMove');
  const $openWindowOnRootLoadTopmost = document.getElementById(
    'openWindowOnRootLoadTopmost'
  );
  const $reorderTabsOnCreate = document.getElementById('reorderTabsOnCreate');
  const $focusActiveTabOnLoadOrEdit = document.getElementById(
    'focusActiveTabOnLoadOrEdit'
  );
  const $moveDownIntoExpandedSibling = document.getElementById(
    'moveDownIntoExpandedSibling'
  );
  const $moveUpIntoExpandedSibling = document.getElementById(
    'moveUpIntoExpandedSibling'
  );
  const $reconcileIntervalMinutes = document.getElementById(
    'reconcileIntervalMinutes'
  );
  const $opsBacklogWarnThreshold = document.getElementById(
    'opsBacklogWarnThreshold'
  );
  api.storage.local.get({
    defaultViewScope: 'auto',
    openWindowOnRootMove: false,
    openWindowOnRootLoadTopmost: false,
    reorderTabsOnCreate: true,
    focusActiveTabOnLoadOrEdit: false,
    moveDownIntoExpandedSibling: true,
    moveUpIntoExpandedSibling: true,
    reconcileIntervalMinutes: 5,
    opsBacklogWarnThreshold: 50
  }).then((result) => {
    $defaultViewScope.value = result.defaultViewScope;
    $openWindowOnRootMove.checked = result.openWindowOnRootMove;
    $openWindowOnRootLoadTopmost.checked =
      result.openWindowOnRootLoadTopmost;
    $reorderTabsOnCreate.checked = result.reorderTabsOnCreate;
    $focusActiveTabOnLoadOrEdit.checked =
      result.focusActiveTabOnLoadOrEdit;
    $moveDownIntoExpandedSibling.checked =
      result.moveDownIntoExpandedSibling;
    $moveUpIntoExpandedSibling.checked =
      result.moveUpIntoExpandedSibling;
    $reconcileIntervalMinutes.value = result.reconcileIntervalMinutes;
    $opsBacklogWarnThreshold.value = result.opsBacklogWarnThreshold;
  });
  $defaultViewScope.addEventListener('change', () => {
    api.storage.local.set({
      defaultViewScope: $defaultViewScope.value
    });
  });
  $openWindowOnRootMove.addEventListener('click', () => {
    api.storage.local.set({
      openWindowOnRootMove: $openWindowOnRootMove.checked
    });
  });
  $openWindowOnRootLoadTopmost.addEventListener('click', () => {
    api.storage.local.set({
      openWindowOnRootLoadTopmost: $openWindowOnRootLoadTopmost.checked
    });
  });
  $reorderTabsOnCreate.addEventListener('click', () => {
    api.storage.local.set({
      reorderTabsOnCreate: $reorderTabsOnCreate.checked
    });
  });
  $focusActiveTabOnLoadOrEdit.addEventListener('click', () => {
    api.storage.local.set({
      focusActiveTabOnLoadOrEdit: $focusActiveTabOnLoadOrEdit.checked
    });
  });
  $moveDownIntoExpandedSibling.addEventListener('click', () => {
    api.storage.local.set({
      moveDownIntoExpandedSibling: $moveDownIntoExpandedSibling.checked
    });
  });
  $moveUpIntoExpandedSibling.addEventListener('click', () => {
    api.storage.local.set({
      moveUpIntoExpandedSibling: $moveUpIntoExpandedSibling.checked
    });
  });

  let reconcileDebounce;
  $reconcileIntervalMinutes.addEventListener('input', () => {
    clearTimeout(reconcileDebounce);
    reconcileDebounce = setTimeout(() => {
      const minutes = parseInt($reconcileIntervalMinutes.value, 10);
      if (isNaN(minutes) || minutes < 0 || minutes > 120) {
        warn('User entered invalid data into reconcileIntervalMinutes');
        return;
      }
      api.storage.local.set({ reconcileIntervalMinutes: minutes });
    }, 1000);
  });

  let backlogDebounce;
  $opsBacklogWarnThreshold.addEventListener('input', () => {
    clearTimeout(backlogDebounce);
    backlogDebounce = setTimeout(() => {
      const threshold = parseInt($opsBacklogWarnThreshold.value, 10);
      if (isNaN(threshold) || threshold < 0 || threshold > 10000) {
        warn('User entered invalid data into opsBacklogWarnThreshold');
        return;
      }
      api.storage.local.set({ opsBacklogWarnThreshold: threshold });
    }, 1000);
  });
}

function initAppearanceForm () {
  // Helper to set up a dropdown + custom text input pair
  // The dropdown provides quick presets, the text input allows custom values
  // Custom input overrides the dropdown when it has a value
  function setupSelectWithCustom(selectId, customId, storageKey, defaultValue, presetValues) {
    const $select = document.getElementById(selectId);
    const $custom = document.getElementById(customId);
    let debounceTimer;

    // Load saved value
    api.storage.local.get({ [storageKey]: defaultValue }).then((result) => {
      const savedValue = result[storageKey];
      // Check if saved value matches a preset
      if (presetValues.includes(savedValue)) {
        $select.value = savedValue;
        $custom.value = '';
      } else {
        // Custom value - show in custom input, set dropdown to default
        $select.value = defaultValue;
        $custom.value = savedValue;
      }
    });

    // Dropdown change - save immediately and clear custom input
    $select.addEventListener('change', () => {
      $custom.value = '';  // Clear custom when using dropdown
      api.storage.local.set({ [storageKey]: $select.value });
    });

    // Custom input - save with debounce, overrides dropdown
    $custom.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const value = $custom.value.trim();
        if (value) {
          api.storage.local.set({ [storageKey]: value });
        }
      }, 500);
    });

    // Save immediately on blur or Enter
    $custom.addEventListener('blur', () => {
      clearTimeout(debounceTimer);
      const value = $custom.value.trim();
      if (value) {
        api.storage.local.set({ [storageKey]: value });
      } else {
        // If custom is cleared, use dropdown value
        api.storage.local.set({ [storageKey]: $select.value });
      }
    });
    $custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounceTimer);
        const value = $custom.value.trim();
        if (value) {
          api.storage.local.set({ [storageKey]: value });
        }
      }
    });
  }

  // Helper for checkbox inputs
  function setupCheckbox(elementId, storageKey, defaultValue) {
    const $el = document.getElementById(elementId);
    api.storage.local.get({ [storageKey]: defaultValue }).then((result) => {
      $el.checked = result[storageKey];
    });
    $el.addEventListener('click', () => {
      api.storage.local.set({ [storageKey]: $el.checked });
    });
  }

  // Font size - dropdown + custom
  setupSelectWithCustom('fontSize', 'fontSizeCustom', 'fontSize', '1.15rem',
    ['0.85rem', '1rem', '1.15rem', '1.3rem', '1.5rem']);

  // Font family - dropdown + custom
  setupSelectWithCustom('fontFamily', 'fontFamilyCustom', 'fontFamily',
    'Arial, Tahoma, Geneva, sans-serif',
    [
      'Arial, Tahoma, Geneva, sans-serif',
      "'DejaVu Sans', Arial, sans-serif",
      "'Quicksand Medium', Tahoma, Geneva, sans-serif",
      "'Segoe UI', Tahoma, Geneva, sans-serif",
      'Verdana, Geneva, sans-serif',
      "'Trebuchet MS', Arial, sans-serif",
      'Georgia, serif',
      "'Courier New', monospace",
      'monospace'
    ]);

  // Row height - dropdown + custom
  setupSelectWithCustom('rowHeight', 'rowHeightCustom', 'rowHeight', '1.5rem',
    ['1.2rem', '1.5rem', '1.8rem', '2.2rem']);

  // Indent width - dropdown + custom
  setupSelectWithCustom('indentWidth', 'indentWidthCustom', 'indentWidth', '0.8rem',
    ['0.5rem', '0.8rem', '1.2rem', '1.6rem']);

  // Checkboxes
  setupCheckbox('showFavicons', 'showFavicons', true);
  setupCheckbox('compactMode', 'compactMode', false);

  // Backfill favicons button
  const $backfillBtn = document.getElementById('backfillFavicons');
  const $backfillStatus = document.getElementById('backfillFaviconsStatus');
  $backfillBtn.addEventListener('click', async () => {
    $backfillBtn.disabled = true;
    $backfillStatus.textContent = ' Working...';
    try {
      const result = await emit('bkgd_backfillFavicons', {});
      $backfillStatus.textContent = ` Done! Updated ${result.updated} nodes, skipped ${result.skipped}.`;
    } catch (err) {
      $backfillStatus.textContent = ` Error: ${err.message || err}`;
    }
    $backfillBtn.disabled = false;
  });
}

function buildDefaultBindingsByAction () {
  const defaults = {};
  for (const binding of keyBindingActions) {
    defaults[binding.action] = '';
  }
  for (const key of Object.keys(defaultKeyBindings)) {
    const action = defaultKeyBindings[key];
    if (action === 'none') continue;
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
        'unloadNode',
        'forceToggleLoad',
        'addNodeAsNextVisibleRow',
        'addNodeAsPrevVisibleRow'
      ]
    },
    {
      label: 'Edit',
      actions: [
        'toggleExpanded',
        'editNotes'
      ]
    },
    {
      label: 'Task',
      actions: [
        'taskEdit'
      ]
    },
    {
      label: 'Navigation',
      actions: [
        'cursorUp',
        'cursorDown',
        'cursorLeft',
        'cursorRight',
        'cursorPgUp',
        'cursorPgDown',
        'cursorHome',
        'cursorEnd'
      ]
    },
    {
      label: 'Move',
      actions: [
        'moveNodeUp',
        'moveNodeDown',
        'moveNodeUpNoDescend',
        'moveNodeDownNoDescend',
        'moveNodeLeft',
        'moveNodeRight',
        'moveNodeHome',
        'moveNodeEnd'
      ]
    },
    {
      label: 'Mark / Paste',
      actions: [
        'toggleMarked',
        'unmarkAll',
        'pasteMarked',
        'pasteMarkedBefore'
      ]
    },
    {
      label: 'Buttons / Misc',
      actions: [
        'backupSession',
        'generateTutorial'
      ]
    }
  ];

  const groupedActions = new Set();
  for (const group of keyBindingGroups) {
    for (const action of group.actions) {
      groupedActions.add(action);
    }
  }
  const ungroupedActions = [];
  for (const binding of keyBindingActions) {
    if (! groupedActions.has(binding.action)) {
      ungroupedActions.push(binding.action);
    }
  }
  if (ungroupedActions.length) {
    keyBindingGroups.push({
      label: 'Other',
      actions: ungroupedActions
    });
  }

  const defaultBindings = buildDefaultBindingsByAction();
  const data = await api.storage.local.get({ keyBindings: {} });
  const storedBindings = data.keyBindings || {};
  const effectiveBindings = {};
  const inputs = {};

  function setInputValue (action) {
    const value = effectiveBindings[action] || '';
    inputs[action].value = value;
  }

  function persistBindings () {
    const overrides = {};
    for (const binding of keyBindingActions) {
      const action = binding.action;
      const value = effectiveBindings[action] || '';
      const defaultValue = defaultBindings[action] || '';
      if (value === defaultValue) continue;
      overrides[action] = value;
    }
    api.storage.local.set({ keyBindings: overrides });
  }

  function applyBinding (action, newValue) {
    const normalized = newValue ? newValue.trim() : '';
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

  $groups.textContent = '';

  const $header = document.createElement('div');
  $header.classList.add('shortcut-grid', 'shortcut-grid-header');
  const $headerAction = document.createElement('div');
  $headerAction.textContent = 'Action';
  const $headerShortcut = document.createElement('div');
  $headerShortcut.textContent = 'Shortcut';
  const $headerDefault = document.createElement('div');
  $headerDefault.textContent = 'Default';
  $header.append($headerAction, $headerShortcut, $headerDefault);
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
      const binding = actionDefinitions[action];
      const label = binding ? binding.label : action;

      const $label = document.createElement('div');
      $label.classList.add('shortcut-label');
      $label.textContent = label;

      const $input = document.createElement('input');
      $input.type = 'text';
      $input.readOnly = true;
      $input.classList.add('shortcut-input');
      $input.dataset.action = action;
      $input.spellcheck = false;

      let storedValue = defaultBindings[action] || '';
      if (Object.prototype.hasOwnProperty.call(storedBindings, action)) {
        storedValue = storedBindings[action];
      }
      effectiveBindings[action] = storedValue || '';
      $input.value = effectiveBindings[action];
      inputs[action] = $input;

      const $default = document.createElement('div');
      $default.classList.add('shortcut-default');
      if (defaultBindings[action]) {
        $default.textContent = `Default: ${defaultBindings[action]}`;
      } else {
        $default.textContent = 'Default: (unbound)';
      }

      $grid.append($label, $input, $default);

      $input.addEventListener('keydown', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
          setInputValue(action);
          $input.blur();
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          applyBinding(action, '');
          return;
        }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
          return;
        }

        const bindingName = buildEventName(event);
        applyBinding(action, bindingName);
      });

      $input.addEventListener('focus', () => {
        $input.select();
      });
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
    api.storage.local.set({ keyBindings: {} });
  });
}

function initSessionRestoreForm () {
  // generate an onClicked handler
  function fileUploadHandler($id, signalName, allowedExtensions = ['.json']) {
    function onClicked () {
      log(`${$id}-button clicked`);
      const $button = document.getElementById(`${$id}-button`);
      const fileInput = document.getElementById(`${$id}-input`);
      const $buttonOrigText = $button.innerText;
      if (fileInput.files.length === 0) {
        alert("Please select a file first.");
        return;
      }

      //const file = fileInput.files[0]; {
      for (const file of fileInput.files) {
        log(`loading ${file.name} (${file.type}) (${file.size} bytes) ...`);
        const reader = new FileReader();

        // Check file extension instead of MIME type (more reliable for .tree files)
        const fileName = file.name.toLowerCase();
        const hasValidExtension = allowedExtensions.some(ext => fileName.endsWith(ext));
        if (!hasValidExtension) {
          alert(`Unsupported file type. Allowed extensions: ${allowedExtensions.join(', ')}`);
          return;
        }

        // HTML parsing from "Save Page As..." of TO is not yet implemented
        if (fileName.endsWith('.html') || fileName.endsWith('.htm')) {
          alert('HTML file import is not yet implemented.\n\nPlease use Tabs Outliner\'s "Export tree" feature instead, which creates a .tree file.');
          return;
        }

        reader.onerror = function (event) {
          err = 'file load failed';
          warn(err, event);
          alert(err);
        }

        reader.onload = function (event) {
          log(`${$id} loaded`);
          let fileContent = event.target.result;
          // try parsing as json
          try {
            const jsonData = JSON.parse(fileContent);
            // send to bkgd
            emit(signalName,
              { data: jsonData, filename: file.name })
              .then((response) => {
                log(`${response.total} nodes imported from: "${file.name}"`);
                $button.innerText = $buttonOrigText;
                alert(`${response.total} nodes imported from: "${file.name}"`);
              });
          } catch (error) {
            warn("Error parsing JSON:", error);
            $button.innerText = $buttonOrigText;
            alert(`The file is not valid JSON: "${file.name}"`);
          }
        };

        // read the file; it'll trigger reader.onload when it's ready
        log(`loading ${file.name} now ...`);
        reader.readAsText(file);
        $button.innerText = '... Loading ...';
      }
    }
    return onClicked;
  }

  let base;

  // handle tktsto imports
  base = 'tktsto-file';
  const importBackupButtonClicked = fileUploadHandler(
    base, 'bkgd_importBackupFile', ['.json']);
  document.getElementById(`${base}-button`).addEventListener("click",
    importBackupButtonClicked);

  // handle tabs-outliner imports (.tree and .html are native Tabs Outliner exports)
  base = 'tabs-outliner-file';
  const tabsOutlinerButtonClicked = fileUploadHandler(
    base, 'bkgd_importTabsOutliner', ['.html', '.tree']);
  document.getElementById(`${base}-button`).addEventListener("click",
    tabsOutlinerButtonClicked);

}

// pre-populate form with saved user options,
// and store new values when the user hits "save"
document.addEventListener('DOMContentLoaded', () => {
  log('options.js loaded');
  initClientIdForm();
  initThemeForm();
  initBehaviorForm();
  initAppearanceForm();
  initKeyBindingsForm();
  initBackupsForm();
  initSessionRestoreForm();
});
