// view/treeview.js: TreeView class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import {
  emit, log, debug, warn, error
} from '/common/common.js';
import { ThemedPage } from '/themes/themes.js';
import { buildEventName } from '/common/events.js';
import {
  defaultKeyBindings,
  keyBindingActions,
  normalizeKeyBindingOverrides
} from '/common/keybindings.js';
import { inputDialog, checkboxDialog, nodeEditDialog } from '/common/dialog.js';
import { NodeView } from './nodeview.js';
import { Tree } from '/common/tree.js';
import { Mutex } from '/common/mutex.js';


export class TreeView extends Tree {

  constructor (args = {}) {
    super(NodeView);

    this.document = args.document || globalThis.document;
    this.window = args.window || globalThis.window;

    this.treeViewLoaded = new Promise(resolve => {
      this.resolveTreeViewLoaded = resolve;
    });

    // false = interactive "real" TreeView
    // true = static read-only TreeView for demonstration purposes
    this.isInert = Boolean(args.isInert || (! this.document));

    this.cfgDefaults = { ...this.cfgDefaults,
      cursorFollowsActiveTab: true,
      activeTabExpandsItsParents: true,
      nodesPerPage: 20,
      doubleClickMs: 500,
      treeViewZoomLevel: 1.0,
      alwaysShowNodeStats: true,
      wasLoadedNodeStats: true,
      hideTopButtonsDuringSearch: false,
      loadCollapsedBranchStyle: 'ask',
      loadExpandedBranchStyle: 'ask',
      unloadCollapsedBranchStyle: 'ask',
      unloadExpandedBranchStyle: 'ask',
      deleteExpandedBranchStyle: 'ask',
      defaultViewScope: 'auto',
      openWindowOnRootMove: false,
      openWindowOnRootLoadTopmost: false,
      focusActiveTabOnLoadOrEdit: false,
      moveDownIntoExpandedSibling: true,
      moveUpIntoExpandedSibling: true,
      dropTextNoteMode: 'prepend',
      keyBindings: {},
    };
    // TODO: determine whether full view or single-window

    if (! this.isInert) {
      this.initElements();
    }

    // table mapping keys to actions
    this.keyEventMutex = new Mutex();
    this.keyBindings = { ...defaultKeyBindings };
    this.keyBindingsByAction = this.buildActionKeyMap(this.keyBindings);
    this.activeDialogCount = 0;
    this.actionLabels = {};
    for (const binding of keyBindingActions) {
      this.actionLabels[binding.action] = binding.label;
    }
    // mouse click bindings
    this.mouseBindings = {
      // mouseover should show a hover menu thingy
      'MouseOver': 'mouseHoverMenu',
      // drag-n-drop stuff
      'MouseDragStart': 'mouseDragStart',
      'MouseDrag': 'mouseDrag',
      'MouseDrop': 'mouseDrop',
      'MouseDragEnd': 'mouseDragEnd',
      'MouseDragLeave': 'mouseDragLeave',
      'MouseDragOver': 'mouseDragOver',
      // do nothing on 'click' event
      'MouseClickLeft': 'rejectEvent',
      // double click does the same thing as 'Enter'
      'MouseDblClickLeft': 'loadOrEditNode',
      // place cursor and maybe expand/collapse node
      'MousePressLeft': 'mousePressLeft',
      // allow middle click to pass as-is, and open link in a new tab
      'MousePressMiddle': 'none',
      // allow right click to open normal context menu
      'MousePressRight': 'none',
    };

    this.openWindowOnRootMove = false;
    this.openWindowOnRootLoadTopmost = false;
    this.focusActiveTabOnLoadOrEdit = false;
    this.moveDownIntoExpandedSibling = true;
    this.moveUpIntoExpandedSibling = true;
    this.dropTextNoteMode = 'prepend';

    // { nodeId: node, ... }
    this.expandOverrides = {};
  }

  destroy () {
    this.destroyed = true;
    if (this.bkgdPing) {
      clearInterval(this.bkgdPing);
      this.bkgdPing = null;
    }
    if (this.onEmitFailure && this.window && this.window.removeEventListener) {
      this.window.removeEventListener('tktsto_emit_failure', this.onEmitFailure);
      this.onEmitFailure = null;
    }
  }

  initElements () {
    if (this.elementsInitialized) return;
    this.elementsInitialized = true;
    const doc = this.document;
    this.$body = doc.getElementById('body');
    if (! this.$) this.$ = doc.getElementById('tree-view');
    if (! this.$treeRoot) this.$treeRoot = doc.getElementById('tree-root');

    this.cursor = null;

    this.$topBar = doc.getElementById('top-bar');
    this.$bottomBar = doc.getElementById('bottom-bar');

    this.$viewScopeBtn = doc.getElementById('view-scope-btn');

    // zoom buttons
    this.$zoomOutBtn = doc.getElementById('zoom-out-btn');
    this.$zoomInBtn = doc.getElementById('zoom-in-btn');
    // number of steps per "octave"
    this.zoomSteps = 12;
    this.zoomMax = 3;
    this.zoomMin = 1 / this.zoomMax;

    this.$searchBar = doc.getElementById('search-bar');
    this.$searchEntry = doc.getElementById('search-entry');
    this.$searchCount = doc.getElementById('search-count');
    if ((! this.isInert) && this.$searchEntry) {
      this.$searchEntry.addEventListener('input', (event) => {
        this.runUiAction(
          'Search update',
          () => this.onSearchEntryUpdated(event)
        );
      });
      this.$searchEntry.addEventListener('focus', (event) => {
        return this.onSearchEntryFocused(event);
      });
      this.$searchEntry.addEventListener('blur', (event) => {
        return this.onSearchEntryUnfocused(event);
      });
    }

    // drag-n-drop scroll zone size
    this.dragScrollZone = 0.15;  // 15% top and bottom

    // shows info about most recent event
    //this.$statusBar = doc.getElementById('status-bar');
    this.$statusText = doc.getElementById('status-text');
    this.onEmitFailure = (event) => {
      const detail = event && event.detail ? event.detail : {};
      const status = detail.status || 'Background not responding.';
      this.setStatus(status);
    };
    if (this.window && this.window.addEventListener) {
      this.window.addEventListener('tktsto_emit_failure', this.onEmitFailure);
    }
    this.$detailsBox = doc.getElementById('details-box');
    this.$detailsBtn = doc.getElementById('details-btn');
    // TODO: this should load from config
    this.detailsState = 1;  // 0=off, 1=notes, 2=details
    // open a tree view in a new tab
    this.$treeViewInTabBtn = doc.getElementById('tree-view-in-tab-btn');
    // click to save a session backup
    this.$backupBtn = doc.getElementById('backup-btn');
    // open the extension's options page
    this.$optionsBtn = doc.getElementById('options-btn');
    // help the project survive, and help me pay rent
    this.$donateBtn = doc.getElementById('donate-btn');
    // open the extension's help page
    this.$helpBtn = doc.getElementById('help-btn');

    // count of marked nodes when non-zero
    this.$markedCount = doc.getElementById('marked-count');

    // node row hover menu
    this.$hoverMenu = doc.getElementById('hover-menu');

    // some functions don't work in incognito windows in Chrome-based browsers
    // because of its "spanning" vs "split" modes for incognito extensions
    // (we use "spanning" mode, because "split" mode would break tktsto)
    if (isChrome && (! this.isInert)) {
      api.windows.getCurrent({ populate: false}, win => {
        if (win.incognito) {
          // grey out buttons to warn the user they won't work as expected
          if (this.$treeViewInTabBtn) this.$treeViewInTabBtn.classList.add('greyed-out');
          if (this.$optionsBtn) this.$optionsBtn.classList.add('greyed-out');
          if (this.$helpBtn) this.$helpBtn.classList.add('greyed-out');
        }
      });
    }
  }

  async init () {
    await super.init();

    this.initElements();

    if (! this.isInert) {
      this.themedPage = new ThemedPage('/view/sidepanel');
      await this.themedPage.init();

      this.keyEventMutex = new Mutex();

      // misc handlers
      this.initBodyHandlers();
      this.initKeyHandler();
      this.initMouseHandler();
      this.initButtonHandlers();

      this.openWindowOnRootMove = this.cfg.openWindowOnRootMove;
      this.openWindowOnRootLoadTopmost =
        this.cfg.openWindowOnRootLoadTopmost;
      this.focusActiveTabOnLoadOrEdit =
        this.cfg.focusActiveTabOnLoadOrEdit;
      this.moveDownIntoExpandedSibling =
        this.cfg.moveDownIntoExpandedSibling;
      this.moveUpIntoExpandedSibling =
        this.cfg.moveUpIntoExpandedSibling;
      this.nodesPerPage = Number.isFinite(this.cfg.nodesPerPage)
        && (this.cfg.nodesPerPage > 0)
        ? this.cfg.nodesPerPage
        : 20;
      this.dropTextNoteMode = ['prepend', 'append'].includes(
        this.cfg.dropTextNoteMode
      ) ? this.cfg.dropTextNoteMode : 'prepend';
      await this.updateKeyBindings();

      for (const [key, property] of [
        ['openWindowOnRootMove', 'openWindowOnRootMove'],
        ['openWindowOnRootLoadTopmost', 'openWindowOnRootLoadTopmost'],
        ['focusActiveTabOnLoadOrEdit', 'focusActiveTabOnLoadOrEdit'],
        ['moveDownIntoExpandedSibling', 'moveDownIntoExpandedSibling'],
        ['moveUpIntoExpandedSibling', 'moveUpIntoExpandedSibling'],
        ['nodesPerPage', 'nodesPerPage']
      ]) {
        this.cfg.watch(key, (cfgKey, newValue) => {
          this[property] = newValue;
        });
      }
      this.cfg.watch('dropTextNoteMode', (key, newValue) => {
        this.dropTextNoteMode = ['prepend', 'append'].includes(newValue)
          ? newValue
          : 'prepend';
      });
      this.cfg.watch('keyBindings', () => {
        this.runUiAction(
          'Key binding update',
          () => this.updateKeyBindings()
        );
      });

      // config watchers
      this.cfg.watch('treeViewZoomLevel',
        (key, newVal, oldVal) => {
          this.runUiAction(
            'Zoom update',
            () => this.setZoomLevel(newVal, oldVal)
          );
        });
      await this.setZoomLevel(
        this.cfg.treeViewZoomLevel,
        this.cfg.treeViewZoomLevel
      );

      // clear "expanded" overrides when this option is turned off
      this.cfg.watch('activeTabExpandsItsParents',
        (key, newVal, oldVal) => {
          if (! newVal) {
            this.runUiAction('Expansion override update', async () => {
              await this.expandOverrideClear();
              await this.ensureCursorVisible();
              this.$renderWholeTree();
            });
          }
        },
        1000  // debounce a bit since this change is expensive
      );
    }

    // config watchers for inert DocTreeViews
    this.cfg.watch('alwaysShowNodeStats', () => this.$renderWholeTree());
    this.cfg.watch('wasLoadedNodeStats', () => this.$renderWholeTree());

    this.nodeIdMimeType = 'application/x-tktsto-node-id';
    // get the window this view is attached to
    this.windowObj = await api.windows.getCurrent();
    this.windowId = this.windowObj.id;

    if (! this.isInert) {
      // init connection to bkgd
      await this.initBkgdPort();
      this.initBkgdPing();
      this.id = await this.newNodeId();
      // TODO: load the nodes from storage and render them
      await this.loadTreeFromBkgd(false);
    }

    //this.root = new NodeView(this, null, this.window);
    this.root.window = this.window;

    // figure out which window we are and whether to view the whole tree
    if (this.isInert) {
      this.viewScope = 'session';
    } else {
      this.windowNode = this.root.getWindowId(this.windowId);
      let defaultViewScope = this.cfg.defaultViewScope;
      if (! ['session', 'window'].includes(defaultViewScope)) {
        defaultViewScope = 'window';
        // 1st window defaults to Session mode, others use Window mode
        if (this.windowNode && this.windowNode.parent.isRoot()
          && (0 === this.windowNode.indexOf())) {
          defaultViewScope = 'session';
        }
      }
      this.viewScope = await this.getWindowConfig('viewScope', defaultViewScope);
      if (! this.viewScope) this.viewScope = defaultViewScope;
      const savedDetailsState = await this.getWindowConfig(
        'detailsState',
        this.detailsState
      );
      if (undefined !== savedDetailsState) {
        this.detailsState = savedDetailsState;
      }

      await this.detectTabOrSidepanel();
      this.registerWithBkgd();
    }

    this.$renderViewScopeBtn();

    this.$renderWholeTree();

    // apply the user's detail box setting
    this.$renderDetailsBtn();

    // build the hover menu
    this.$renderHoverMenu();

    // let listeners know the tree is loaded
    this.resolveTreeViewLoaded();

    // ensure the cursor is somewhere sane when sidepanel opens
    await this.ensureCursorVisible();
  }

  async loadTreeFromBkgd (render = true) {
    // save any state which needs to be restored on new Tree
    let oldCursor;
    if (this.cursor) {
      oldCursor = this.cursor.id;
    }

    // load the tree
    await super.loadTreeFromBkgd();

    // render ... everything
    if (render) this.$renderWholeTree();

    this.updateMarkedCount();

    // restore state
    if (oldCursor) {
      const newCursor = this.nodes[oldCursor];
      await this.setCursor(newCursor, { instant: true });
    }
  }

  $renderWholeTree () {
    // display the entire tree
    if (('session' === this.viewScope) || (! this.windowNode))
      this.viewRoot = this.root;
    // display only this window
    else if ('window' === this.viewScope)
      this.viewRoot = this.windowNode;
    // show the nodes
    this.viewRoot.$render();
    this.viewRoot.$renderChildren();
    if (this.root.$) this.root.$.classList.add('root-nodes');
    // add the view root node to the page
    this.$treeRoot.replaceChildren(this.viewRoot.$);
  }

  setStatus (msg) {
    if (this.$statusText) this.$statusText.textContent = msg;
  }

  async runUiAction (context, action) {
    try {
      return await action();
    } catch (err) {
      error(`${context} failed`, err);
      this.setStatus(`${context} failed: ${err?.message || err}`);
      return undefined;
    }
  }

  get dialogActive () {
    return this.activeDialogCount > 0;
  }

  buildActionKeyMap (keyBindings) {
    const byAction = {};
    for (const key of Object.keys(keyBindings)) {
      const action = keyBindings[key];
      if (! byAction[action]) byAction[action] = [];
      byAction[action].push(key);
    }
    return byAction;
  }

  getKeyBindingForAction (action) {
    const bindings = this.keyBindingsByAction[action];
    if (bindings && bindings.length) return bindings[0];
    return '';
  }

  formatModifierLabel (modifier) {
    const map = {
      'Shift': 'S',
      'Ctrl': 'C',
      'Alt': 'A',
      'Meta': 'M'
    };
    return map[modifier] || modifier;
  }

  formatKeyLabel (key) {
    if (! key) return '';
    const map = {
      'ArrowUp': 'Up',
      'ArrowDown': 'Dn',
      'ArrowLeft': 'Lt',
      'ArrowRight': 'Rt',
      'PageUp': 'PgUp',
      'PageDown': 'PgDn',
      'Home': 'Home',
      'End': 'End',
      'Enter': 'Ent',
      'Space': 'Spc',
      'Tab': 'Tab',
      'Backspace': 'Bksp',
      'Delete': 'Del',
      'Escape': 'Esc'
    };
    if (key.length === 1) return key.toUpperCase();
    return map[key] || key;
  }

  formatBindingLabel (binding, fallback) {
    if (! binding) return fallback || '';
    const parts = binding.split('+');
    const key = parts.pop();
    const keyLabel = this.formatKeyLabel(key);
    if (! parts.length) return keyLabel;
    const modLabels = parts.map((part) => this.formatModifierLabel(part));
    return `${modLabels.join('+')}+${keyLabel}`;
  }

  setHoverMenuButtonLabel ($button, action, fallback) {
    if (! $button) return;
    const binding = this.getKeyBindingForAction(action);
    const label = this.formatBindingLabel(binding, fallback);
    $button.innerText = label || '';
    const actionLabel = this.actionLabels[action] || action;
    if (binding) $button.title = `${actionLabel} (${binding})`;
    else $button.title = `${actionLabel} (unbound)`;
  }

  updateHoverMenuLabels () {
    this.setHoverMenuButtonLabel(this.$hoverMenuUnload, 'toggleLoad', 'U');
    this.setHoverMenuButtonLabel(this.$hoverMenuLoad, 'toggleLoad', 'U');
    this.setHoverMenuButtonLabel(this.$hoverMenuTask, 'taskEdit', 'T');
    this.setHoverMenuButtonLabel(this.$hoverMenuEdit, 'editNode', 'E');
    this.setHoverMenuButtonLabel(this.$hoverMenuMark, 'toggleMarked', 'M');
    this.setHoverMenuButtonLabel(this.$hoverMenuWindow, 'wrapNodeInWindow', 'W');
    this.setHoverMenuButtonLabel(this.$hoverMenuDelete, 'deleteNode', 'D');
  }

  applyKeyBindings (userBindings) {
    const keyBindings = { ...defaultKeyBindings };
    const defaultByAction = this.buildActionKeyMap(keyBindings);
    const allowedActions = new Set(
      keyBindingActions.map((binding) => binding.action)
    );

    const normalizedBindings = normalizeKeyBindingOverrides(userBindings);
    if (normalizedBindings) {
      for (const action of Object.keys(normalizedBindings)) {
        if (! allowedActions.has(action)) continue;
        const existingKeys = defaultByAction[action] || [];
        for (const existingKey of existingKeys) {
          delete keyBindings[existingKey];
        }
        const rawKey = normalizedBindings[action];
        if ('string' === typeof rawKey) {
          const key = rawKey.trim();
          if (key) keyBindings[key] = action;
        }
      }
    }

    this.keyBindings = keyBindings;
    this.keyBindingsByAction = this.buildActionKeyMap(this.keyBindings);
  }

  async updateKeyBindings () {
    const data = await api.storage.local.get({ keyBindings: {} });
    this.applyKeyBindings(data.keyBindings);
    this.updateHoverMenuLabels();
  }

  async getWindowConfig (varName, defaultValue) {
    // can't do anything unless we know which window we are
    if (! this.windowNode) return;
    // load from config, per window
    const key = `TreeView.${varName}.${this.windowNode.id}`;
    if (this.cfg[key]) return this.cfg[key];
    else return this.cfg.get(key, defaultValue);
  }

  setWindowConfig (varName, value) {
    // can't do anything unless we know which window we are
    if (! this.windowNode) return;
    // save to config, per window
    const key = `TreeView.${varName}.${this.windowNode.id}`;
    return this.cfg.set(key, value);
  }

  updateMarkedCount () {
    // add a "+" to the number if any marked nodes have kids
    let plus = '';
    for (const nodeId of this.markedNodes) {
      const node = this.nodes[nodeId];
      if (node.hasKids()) {
        plus = '+';
        break;
      }
    }
    // update the counter widget
    this.$markedCount.innerText = `${this.markedNodes.length}${plus}`;
    if (this.markedNodes.length <= 0)
      this.$markedCount.classList.add('hidden');
    else this.$markedCount.classList.remove('hidden');
  }

  onMarkedCountHover () {
    this.hideHoverMenu();
  }

  onMarkedCountClick (event) {
    return this.action_pasteMarked(event);
  }

  showSearch () {
    this.$searchBar.classList.remove('hidden');
    this.$searchCount.classList.remove('hidden');
  }

  hideSearch () {
    this.$searchBar.classList.add('hidden');
    this.$searchCount.classList.add('hidden');
  }

  focusSearchBar () {
    this.$searchEntry.classList.add('focus');
    this.$searchEntry.focus();
  }

  unfocusSearchBar () {
    this.$searchEntry.classList.remove('focus');
    this.$searchEntry.blur();
  }

  async startSearch () {
    // hover menu unfocuses $searchEntry, force hide it
    this.hideHoverMenu();
    // disable the main key event handler while $searchEntry is focused
    this.searchCaptureInput = true;
    // separate flag for whether a search is in progress,
    // even when main key event handler is enabled
    this.searchActive = true;
    this.showSearch();
    if (this.cfg.hideTopButtonsDuringSearch) {
      this.$topBar.classList.add('hidden');
    }
    await this.updateSearch();
    this.focusSearchBar();
  }

  keepSearchAndReleaseFocus () {
    // give keyboard focus back to main TreeView
    // but let the search stay active
    debug('keepSearchAndReleaseFocus');
    this.searchCaptureInput = false;
    this.searchActive = true;
    this.unfocusSearchBar();
  }

  async cancelSearch () {
    this.$topBar.classList.remove('hidden');
    this.unfocusSearchBar();
    this.hideSearch();
    this.searchString = '';
    this.$searchEntry.value = '';
    this.searchMatchNum = 0;
    this.searchTotal = 0;
    await this.updateSearch();
    this.searchCaptureInput = false;
    this.searchActive = false;
  }

  async updateSearch () {
    if (! this.searchString) {
      this.searchMatchNum = 0;
      this.searchTotal = 0;
      this.searchMatches = [];
      this.updateSearchCount();
      // don't collapse the most recent match yet
      //await this.activateSearchMatch(null);
      return;
    }

    const matches = this.viewRoot.search(this.searchString);
    this.searchMatches = matches;
    this.searchTotal = matches.length;
    if (matches.length <= 0) {
      this.searchMatchNum = 0;
      this.searchTotal = 0;
      await this.activateSearchMatch(null);
    }
    else if (matches.includes(this.cursor)) {
      await this.activateSearchMatch(this.cursor);
    }
    else {
      await this.activateSearchMatch(matches[0]);
    }
  }

  async activateSearchMatch (node) {
    debug(`${node?.toLine()}`);
    const oldMatch = this.searchMatch;
    const newMatch = node;
    this.searchMatch = newMatch;

    if (newMatch) {
      this.hideHoverMenu();
      await this.expandOverride(newMatch, true);
    }
    if (oldMatch && (oldMatch !== newMatch))
      await this.expandOverride(oldMatch, null);
    if (newMatch) {
      // wait for expansion changes to take effect before moving cursor
      setTimeout(() => {
        this.runUiAction(
          'Search cursor update',
          () => this.setCursor(newMatch)
        );
      }, 1);
    }
    this.updateSearchCount();
  }

  updateSearchCount () {
    let num, denom;
    if (this.searchMatches) {
      this.searchTotal = this.searchMatches.length;
      if (this.searchMatch)
        this.searchMatchNum = this.searchMatches.indexOf(this.searchMatch);
      else this.searchMatchNum = 0;
      num = this.searchMatchNum + 1;
      denom = this.searchTotal;
      if (! denom) num = '-';
    } else {
      this.searchTotal = 0;
      this.searchMatchNum = 0;
      num = '-';
      denom = '0';
    }
    this.$searchCount.innerText = `${num}/${denom}`;
  }

  async action_beginSearch () {
    // search by text entry
    debug('beginSearch');
    await this.startSearch();
  }

  async action_searchForCurrent (event) {
    // search by node
    debug('searchForCurrent');
    const cursor = this.whichCursor(event);
    if (! cursor) return;
    this.searchString = cursor;
    this.$searchEntry.value = `node:${cursor.id}`;
    await this.startSearch();
    await this.keepSearchAndReleaseFocus();
  }

  async action_endSearch () {
    // cancel the search, or un-override expanded branches
    debug('endSearch');
    if (this.searchActive) await this.cancelSearch();
    else await this.expandOverrideClear();
  }

  async action_nextSearchResult (event, prev = false) {
    debug(`prev: ${prev}`);
    if (this.searchMatches.length > 0) {
      if (prev) {
        this.searchMatchNum --;
        if (this.searchMatchNum < 0)
          this.searchMatchNum = this.searchMatches.length - 1;
      } else {
        this.searchMatchNum = (this.searchMatchNum + 1) % this.searchTotal;
      }
      const newMatch = this.searchMatches[this.searchMatchNum];
      await this.activateSearchMatch(newMatch);
    }
  }

  action_prevSearchResult (event) {
    return this.action_nextSearchResult(event, true);
  }

  searchKeyHandler (event) {
    const keyName = buildEventName(event);
    // allow specific events to fall through to non-search key handler
    const passThru = {
      //'Escape' : true,
      'ArrowUp' : true,
      'ArrowDown' : true,
      'PageUp' : true,
      'PageDown' : true,
    };
    if (passThru[keyName]) return true;

    switch (keyName) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.runUiAction('Search cancellation', () => this.cancelSearch());
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        this.keepSearchAndReleaseFocus();
        break;
      default:
        // gaaaaah, search entry keeps getting unfocused
        // after each keystroke... why???
        // (but only if I haven't clicked in it)
        //setTimeout(() => this.$searchEntry.focus(), 1);
        // okay, the problem was the hover menu... it blurs $searchEntry
        // as soon as it appears ... so hiding it eliminated the need
        // for this icky kludge
        break;
    }
  }

  async onSearchEntryUpdated (event) {
    if (! this.searchActive) return;

    // debounce, so it won't update too fast while typing
    if (this.onSearchEntryUpdatedTimer)
      clearTimeout(this.onSearchEntryUpdatedTimer);
    this.onSearchEntryUpdatedTimer = setTimeout(() => {
      const oldVal = this.searchString;
      const newVal = this.$searchEntry.value;
      debug(`search: ${newVal}`);
      this.searchString = newVal;
      if (newVal !== oldVal) {
        this.runUiAction('Search update', () => this.updateSearch());
      }
    }, 250);
  }

  onSearchEntryFocused (event) {
    debug('focus');
    this.searchCaptureInput = true;
    this.$searchEntry.classList.add('focus');
  }

  onSearchEntryUnfocused (event) {
    debug('unfocus');
    this.searchCaptureInput = false;
    this.$searchEntry.classList.remove('focus');
  }

  async expandOverrideClear () {
    // un-override all locally-expanded nodes
    for (const [nodeId, node] of Object.entries(this.expandOverrides)) {
      await this.expandOverride(node, null);
    }
  }

  async expandOverride (node, expand) {
    // expand: true or null
    // (expand or unset)
    // (was going to support "false = collapse" too, but there's no need)
    if (! node) return;
    //debug(`${expand}, ${node.toLine()}`)
    const viewRoot = this.viewRoot;
    if (expand) {
      this.expandOverrides[node.id] = node;
      // force expand
      const origNode = node;
      node = node.parent;
      // override a node and all its parents
      while (node && node.isChildOf(viewRoot)) {
        //debug(`override ${node.toLine()}`);
        await node.setExpanded(true, {
          reason: 'override', localOverride: true,
        });
        node = node.parent;
      }
    }
    //else if (false === expand) {
    //}
    else if (this.expandOverrides[node.id]) {
      // TODO: redraw affected node
      delete this.expandOverrides[node.id];
      let n = node;
      // un-override a node and its parents,
      // until it intersects another override's parents
      while (n && n.isChildOf(viewRoot) && (! n.isExpandedOverride())) {
        await n.setExpanded(n.expanded, {
          reason: 'override', localOverride: true,
        });
        n = n.parent;
      }
    }
  }

  async runDialog (dialogFunction, args) {
    this.activeDialogCount += 1;
    try {
      return await dialogFunction(...args);
    } finally {
      this.activeDialogCount -= 1;
    }
  }

  inputDialog (...args) {
    return this.runDialog(inputDialog, args);
  }

  nodeEditDialog (...args) {
    return this.runDialog(nodeEditDialog, args);
  }

  checkboxDialog (...args) {
    return this.runDialog(checkboxDialog, args);
  }

  resolveMoveAction (action) {
    // Keybinding actions are swapped when the nesting toggle is off.
    // This keeps action methods deterministic while the toggle only
    // affects which action gets invoked for Shift vs Shift+Alt.
    if (! action) return action;
    if (action === 'moveNodeUp' || action === 'moveNodeUpInvertNest') {
      if (! this.moveUpIntoExpandedSibling) {
        return (action === 'moveNodeUp')
          ? 'moveNodeUpInvertNest'
          : 'moveNodeUp';
      }
      return action;
    }
    if (action === 'moveNodeDown' || action === 'moveNodeDownInvertNest') {
      if (! this.moveDownIntoExpandedSibling) {
        return (action === 'moveNodeDown')
          ? 'moveNodeDownInvertNest'
          : 'moveNodeDown';
      }
      return action;
    }
    return action;
  }

  describeMoveAction (action) {
    if (! action) return action;
    if (action === 'moveNodeUp') return 'moveNodeUp (nest)';
    if (action === 'moveNodeUpInvertNest') return 'moveNodeUp (no nest)';
    if (action === 'moveNodeDown') return 'moveNodeDown (nest)';
    if (action === 'moveNodeDownInvertNest') return 'moveNodeDown (no nest)';
    return action;
  }

  initBodyHandlers () {
    // absolutely NEVER scroll horizontally
    this.$body.addEventListener('scroll', () => { this.$body.scrollLeft = 0; });
    //
    this.window.addEventListener('focus', () => {
      this.$body.classList.remove('unfocused');
    });
    this.window.addEventListener('blur', () => {
      this.$body.classList.add('unfocused');
    });
  }

  initKeyHandler () {
    // must wrap it in an anon function to fix scoping issues
    // (calling this.keyHandler unwrapped runs in HtmllDocument scope
    //  instead of Tree scope)
    this.document.addEventListener('keydown',
      (event) => {
        this.runUiAction('Keyboard action', () => this.keyHandler(event));
      }
    );
  }

  initMouseHandler () {
    const handleMouse = (target, domEvent, eventType) => {
      target.addEventListener(domEvent, (event) => {
        this.runUiAction(
          `Mouse ${eventType} action`,
          () => this.mouseEvent(eventType, event)
        );
      });
    };
    // block default click on tree nodes (left click shouldn't open links)
    handleMouse(this.$treeRoot, 'click', 'click');
    handleMouse(this.$treeRoot, 'mousedown', 'mousedown');
    handleMouse(this.$treeRoot, 'dblclick', 'dblclick');
    // drag-n-drop
    handleMouse(this.$, 'dragstart', 'DragStart');
    handleMouse(this.$, 'drag', 'Drag');
    handleMouse(this.$, 'drop', 'Drop');
    handleMouse(this.$, 'dragend', 'DragEnd');
    handleMouse(this.$, 'dragleave', 'DragLeave');
    handleMouse(this.$, 'dragover', 'DragOver');
    // show/hide the hover menu
    handleMouse(this.$treeRoot, 'mouseover', 'mouseover');
    // hide the hover menu when the mouse leaves the tree view
    this.$.addEventListener('mouseleave',
      (event) => { this.mouseLeave(event) });
  }

  keyHandler (event) {
    // don't try to handle key events while a dialog is visible
    if (this.dialogActive) return;
    // pause regular handling while user is typing in search terms
    if (this.searchCaptureInput) {
      const passThru = this.searchKeyHandler(event);
      if (! passThru) return;
    }
    // calculate a more complete name for this event,
    // then call the keyboard event dispatcher
    const keyName = buildEventName(event);
    this.setStatus(`keydown: ${keyName}`);
    return this.dispatchInputEvent(event);
  }

  async dispatchInputEvent (event) {
    // look up the event name to see if it's mapped to an action
    // ... then call that action
    const requestedAction = this.keyBindings[event.processedName];
    const resolvedAction = this.resolveMoveAction(requestedAction);
    if (resolvedAction) {
      // bindable actions detectable by naming convention
      const handler = this[`action_${resolvedAction}`];
      if (handler) {
        // unsure if necessary
        event.preventDefault();
        event.stopPropagation();
        this.hideHoverMenu();
        // actually handle the event, but only one at a time
        const unlock = await this.keyEventMutex.lock();
        try {
          const requestedLabel = this.describeMoveAction(requestedAction);
          const resolvedLabel = this.describeMoveAction(resolvedAction);
          if (requestedAction && resolvedAction !== requestedAction) {
            this.setStatus(`key: ${requestedLabel} -> ${resolvedLabel}`);
          } else {
            this.setStatus(`key: ${resolvedLabel}`);
          }
          await handler.bind(this)(event);  // equivalent to this.handler(event);
        }
        finally { unlock(); }
      }
      else {
        this.setStatus(`handler not found: ${resolvedAction}`);
      }
    }
  }

  async mouseEvent (eventType, event) {
    //debug(`TreeView.mouseEvent(${eventType})`, event);
    // don't try to handle mouse events while a dialog is visible
    if (this.dialogActive) return;
    if (this.searchCaptureInput) return;

    // stop scrolling if mouse left the tree view
    if ((isFirefox && (! event.relatedTarget))
      || ((0 === event.x) && (0 === event.y)))
      this.dragScrollSpeed = 0;

    //debug(`mouseEvent(${eventType}):`, event);
    // ensure nothing gets focused / highlighted
    this.document.activeElement.blur();
    // assign an event name based on modifier keys, event type, mouse button
    const eventName = buildEventName(event, eventType);
    //this.setStatus(`mouse: ${eventName}`);
    // identify which row the event was in, if any
    let node = this.root;  // which Tree Node object was clicked?
    let $target = event.target;
    let $node;  // Node's ul.node element
    let $row;  // Node's div.row element
    let $elem;  // most specific element we care about
    //debug(`mouseEvent(${eventType}):`, $target, event);
    while ($target && $target.classList) {
      const className = $target.classList[0];
      if ((! $elem) && [
        'node-stats', 'node-link', 'node-label', 'node-checkbox',
        'row', 'node' ].includes(className)
      ) $elem = $target;
      if ($target.classList.contains('row')) $row = $target;
      if ($target.classList.contains('node')) {
        $node = $target;
        break;  // don't search outside the current node
      }
      $target = $target.parentNode;
    }
    if ($node && $node.id.startsWith('node')) {
      const nodeId = $node.id.slice(4);
      node = this.nodes[nodeId];
    }
    // save these so event handlers can use them
    this.mouseNode = node;
    this.$mouseNode = $node;
    this.$mouseRow = $row;
    this.$mouseElem = $elem;
    this.mouseNodeNonRoot = this.mouseNode;

    // sometimes we need a non-root node, like for drag-n-drop
    if (this.mouseNode?.isRoot()) {
      // check the bounding box of each root-level item,
      // find the closest one above the mouse
      const y = event.clientY;
      let bestTop = -Infinity;
      for (const node of this.viewRoot.nodes) {
        const rect = node.$.getBoundingClientRect();
        if (rect.top <= y && rect.top > bestTop) {
          this.mouseNodeNonRoot = node;
          bestTop = rect.top;
        }
      }
    }

    //debug(`${eventName} ${node.id} `, node, this.$mouseRow);
    //debug(`node: ${node.id}: ${node.toLine()}`, node);
    // identify which part of the row the event was in
    const zoomLevel = this.cfg.treeViewZoomLevel;
    let rowX, rowY, rowWid, rowHgt;
    if ($row) {
      //debug(`clientXY(${event.clientX},${event.clientY}), rowOffset(${$row.offsetLeft},${$row.offsetTop})`);
      rowX = event.clientX - ($row.offsetLeft * zoomLevel);
      rowY = event.clientY - ($row.offsetTop * zoomLevel);
      rowWid = $row.clientWidth * zoomLevel;
      rowHgt = $row.clientHeight * zoomLevel;
    }
    this.$mouseRowX = rowX;
    this.$mouseRowY = rowY;
    this.$mouseRowWid = rowWid;
    this.$mouseRowHgt = rowHgt;
    //debug(`mouseEvent(): rowXY(${rowX},${rowY}) rowWidHgt(${rowWid}x${rowHgt})`);

    // call a handler
    const handlerName = this.mouseBindings[eventName];
    if (handlerName) {
      const handler = this[`action_${handlerName}`];
      if (handler) {
        if (! [
          'mouseHoverMenu', 'rejectEvent', 'mouseDragEnd'
        ].includes(handlerName))
          this.setStatus(`mouse: ${handlerName}`);
        // equivalent to this.handler(event);
        await handler.bind(this)(event);
      }
    }
  }

  mouseLeave (event) {
    //debug('TreeView.mouseLeave()');
    this.hideHoverMenu();
    this.dragScrollSpeed = 0;
  }

  whichCursor (event) {
    // decide whether to act on mouse hover node or keyboard cursor node
    // based on the event type
    if ('click' === event.type) return this.mouseNode;
    if (! this.cursor) return null;
    // do nothing if cursor is outside of viewRoot
    else if (! this.cursor.isInViewScope()) return null;
    // normal keyboard event
    else return this.cursor;
  }

  action_none (event) { }

  action_rejectEvent (event) {  // block browser's default handler
    event.preventDefault();
    event.stopPropagation();
  }

  async action_cursorUp (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move up one row
    await this.setCursor(this.cursor.prevVisibleNode(this.viewRoot));
  }

  async action_cursorDown (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move down one row
    await this.setCursor(this.cursor.nextVisibleNode(this.viewRoot));
  }

  async action_cursorLeft (event) {  // move cursor to parent
    if (! this.cursor) return await this.setCursor(this.root);
    // ignore if root
    if (this.cursor.isRoot()) return;
    if (this.viewRoot === this.cursor) return;
    // move to parent
    await this.setCursor(this.cursor.parent);
  }

  async action_cursorRight (event) {
    // expand current node and move cursor to 1st child
    // default
    if (! this.cursor) return await this.setCursor(this.root);

    // if no kids, do nothing
    if (this.cursor.isLeaf()) return;

    // expand if necessary
    if (! this.cursor.isExpanded()) {
      await this.cursor.setExpanded(true, { reason: 'userAction' });
    }

    // move to 1st child
    await this.setCursor(this.cursor.nodes[0]);
  }

  async action_cursorHome (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move to first sibling
    const node = this.cursor.firstSibling();
    if (node.isChildOf(this.viewRoot, true))
      await this.setCursor(node);
  }

  async action_cursorEnd (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move to last sibling
    const node = this.cursor.lastSibling();
    if (node.isChildOf(this.viewRoot, true))
      await this.setCursor(node);
  }

  async action_cursorPgUp (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move up N rows
    let node = this.cursor;
    for (let i=0; i<this.cfg.nodesPerPage; i++)
      node = node.prevVisibleNode(this.viewRoot);
    await this.setCursor(node);
  }

  async action_cursorPgDown (event) {
    if (! this.cursor) return await this.setCursor(this.root);
    // move up N rows
    let node = this.cursor;
    for (let i=0; i<this.cfg.nodesPerPage; i++)
      node = node.nextVisibleNode(this.viewRoot);
    await this.setCursor(node);
  }

  async cursorNodeMoveTo(destParent, destIndex, direction) {
    const moved = await this.cursor.moveTo(
      destParent, destIndex,
      { reason: 'userAction' });
    if (moved) this.setStatus(`moved ${direction}: ${this.cursor.toLine()}`);
    return moved;
  }

  getOnlyChildLoadedWindowProxy () {
    if (! this.cursor) return null;
    if (! this.cursor.hasKids || (! this.cursor.hasKids())) return null;
    const isLoadedSelf = (this.cursor.isLoaded && this.cursor.isLoaded());
    const hasLoadedDesc = (
      this.cursor.hasLoadedTabsDeep
        ? this.cursor.hasLoadedTabsDeep()
        : (this.cursor.hasLoadedTabs && this.cursor.hasLoadedTabs())
    );
    if (! isLoadedSelf && ! hasLoadedDesc) return null;
    const parent = this.cursor.parent;
    if (! parent || ! parent.isWindow || (! parent.isWindow())) return null;
    if (! parent.isLoaded || (! parent.isLoaded())) return null;
    if ((undefined === parent.windowId) || (null === parent.windowId)) return null;
    if (parent.nodes.length !== 1) return null;
    return parent;
  }

  async moveWindowProxy (windowNode, direction, nestIntoExpandedSibling, opts = {}) {
    if (! windowNode) return;
    const originalCursor = this.cursor;
    this.cursor = windowNode;
    try {
      if ('up' === direction) {
        await this.moveNodeUpWithNest(nestIntoExpandedSibling, opts);
      } else {
        await this.moveNodeDownWithNest(nestIntoExpandedSibling, opts);
      }
    } finally {
      this.cursor = originalCursor;
      await this.setCursor(originalCursor);
    }
  }

  async moveNodeUpWithNest (nestIntoExpandedSibling, opts = {}) {

    // if root or 1st child of root, or if outside of root, do nothing
    const cursor = this.cursor;
    if (! cursor) return;
    if (cursor.isRoot()) return;
    if (! cursor.isChildOf(this.viewRoot, false)) return;
    if (cursor.parent.isRoot() && (0 === cursor.indexOf())) return;
    if ((cursor.parent === this.viewRoot) && (0 === cursor.indexOf())) return;

    const windowProxy = this.getOnlyChildLoadedWindowProxy();
    let forceWindowProxy = false;
    const sourceWindow = (
      cursor.parent
      && cursor.parent.isWindow
      && cursor.parent.isWindow()
    ) ? cursor.parent : null;
    const sourceWindowLoaded = Boolean(
      sourceWindow
      && sourceWindow.isLoaded
      && sourceWindow.isLoaded()
    );
    const sourceIsOnlyWindowChild = Boolean(
      sourceWindow && (sourceWindow.nodes.length === 1)
    );
    const cursorHasLoadedTabs = (
      (this.cursor.isLoaded && this.cursor.isLoaded())
      || (this.cursor.hasLoadedTabsDeep
        ? this.cursor.hasLoadedTabsDeep()
        : (this.cursor.hasLoadedTabs && this.cursor.hasLoadedTabs()))
    );
    const canNestIntoWindow = (node) => {
      if (! node || ! node.isWindow || (! node.isWindow())) return false;
      if (node.isLoaded && node.isLoaded()) return true;
      return nestIntoExpandedSibling;
    };
    const canNestIntoNonWindow = (node) => {
      if (! node || ! node.hasKids || (! node.hasKids())) return false;
      return nestIntoExpandedSibling;
    };

    // node can be moved up; take position of previous visible row
    const prevRow = this.cursor.prevVisibleNode();
    const resolveAnchor = (row) => {
      let anchor = row;
      if (! row.isParentOf(this.cursor)) {
        while (anchor.parent &&
          (anchor.parent !== this.cursor.parent) &&
          (! anchor.parent.isRoot())) {
          anchor = anchor.parent;
        }
      }
      return anchor;
    };
    const resolveAnchorForParent = (row, targetParent) => {
      if (! row || ! targetParent) return null;
      let anchor = row;
      while (anchor.parent &&
        (anchor.parent !== targetParent) &&
        (! anchor.parent.isRoot())) {
        anchor = anchor.parent;
      }
      if (anchor.parent !== targetParent) return null;
      if (anchor.isRoot && anchor.isRoot()) return null;
      return anchor;
    };
    const canNestInto = (node) => (
      canNestIntoWindow(node) || canNestIntoNonWindow(node)
    );
    const anchor = resolveAnchor(prevRow);
    if (prevRow.isParentOf(this.cursor)) {
      let altPrevRow = this.cursor.parent.prevVisibleNode(this.viewRoot);
      if (altPrevRow && (altPrevRow !== this.cursor.parent)) {
        const targetParent = this.cursor.parent.parent;
        const altAnchor = resolveAnchorForParent(altPrevRow, targetParent);
        const canCrossWindowBoundary = (
          (! sourceWindow)
          || (
            sourceWindowLoaded
            && (nestIntoExpandedSibling || sourceIsOnlyWindowChild)
          )
        );
        if (altAnchor
          && canNestInto(altAnchor)
          && canCrossWindowBoundary) {
          if (windowProxy &&
            (! altAnchor.isWindow || (! altAnchor.isWindow()))) {
            await this.moveWindowProxy(
              windowProxy,
              'up',
              nestIntoExpandedSibling,
              opts
            );
            return;
          }
          const destParent = altAnchor;
          const destIndex = altAnchor.nodes.length;
          await this.cursor.moveTo(destParent, destIndex, { reason: 'userAction' });
          this.setStatus(`moved up: ${this.cursor.toLine()}`);
          return;
        }
        const atFirstWindowTop = (
          (! altAnchor)
          && anchor
          && anchor.isWindow && anchor.isWindow()
          && anchor.parent
          && anchor.parent.isRoot
          && anchor.parent.isRoot()
          && (anchor.indexOf() === 0)
        );
        if (atFirstWindowTop && cursorHasLoadedTabs) return;
      }
    }
    if (nestIntoExpandedSibling &&
      (anchor.parent === this.cursor.parent) &&
      canNestInto(anchor)) {
      const destParent = anchor;
      const destIndex = anchor.nodes.length;
      await this.cursor.moveTo(destParent, destIndex, { reason: 'userAction' });
      this.setStatus(`moved up: ${this.cursor.toLine()}`);
      return;
    }
    const destParent = anchor.parent;
    const destIndex = anchor.indexOf();
    const leavingWindow = (
      this.cursor.parent
      && this.cursor.parent.isWindow
      && this.cursor.parent.isWindow()
    );
    const movingToRoot = (
      destParent.isRoot
      && destParent.isRoot()
    );

    if (! forceWindowProxy && windowProxy &&
      (! destParent.isWindow || (! destParent.isWindow()))) {
      forceWindowProxy = true;
    }
    if (forceWindowProxy) {
      if (windowProxy) {
        await this.moveWindowProxy(
          windowProxy,
          'up',
          nestIntoExpandedSibling,
          opts
        );
      }
      return;
    }

    // move it
    const moveArgs = { reason: 'userAction' };
    if (leavingWindow
      && cursorHasLoadedTabs
      && movingToRoot) {
      moveArgs.allowWindowProxy = false;
    }
    await this.cursor.moveTo(destParent, destIndex, moveArgs);
    this.setStatus(`moved up: ${this.cursor.toLine()}`);
  }

  async action_moveNodeUp (event) {
    debug('TreeView.action_moveNodeUp()');
    await this.moveNodeUpWithNest(true);
  }

  async action_moveNodeUpInvertNest (event) {
    debug('TreeView.action_moveNodeUpInvertNest()');
    await this.moveNodeUpWithNest(false);
  }

  async moveNodeDownWithNest (nestIntoExpandedSibling, opts = {}) {

    // if root, or outside of root, do nothing
    const cursor = this.cursor;
    if (! cursor) return;
    if (cursor.isRoot()) return;
    if (! cursor.isChildOf(this.viewRoot, false)) return;

    const windowProxy = this.getOnlyChildLoadedWindowProxy();
    const canNestIntoWindow = (node) => {
      if (! node || ! node.isWindow || (! node.isWindow())) return false;
      if (node.isLoaded && node.isLoaded()) return true;
      return nestIntoExpandedSibling;
    };
    const canNestIntoNonWindow = (node) => {
      if (! node || ! node.hasKids || (! node.hasKids())) return false;
      return nestIntoExpandedSibling;
    };

    // take position of next visible row outside our own branch, probably
    const nextRow = cursor.nextVisibleNodeNotMyChild(this.viewRoot);
    // figure out where to move to
    let destParent;
    let destIndex;
    // if we're the last row in the tree, promote to last child of parent
    if (nextRow === cursor) {
      if (cursor.parent.isRoot()) return;
      if (cursor.parent === this.viewRoot) return;
      destParent = cursor.parent.parent;
      destIndex = cursor.parent.indexOf() + 1;
    }
    // if next row is a parent (window nodes included), move before 1st child
    else if ((canNestIntoWindow(nextRow) || canNestIntoNonWindow(nextRow))) {
      destParent = nextRow;
      destIndex = 0;
    }
    else {
      destParent = nextRow.parent;
      if (destParent === this.cursor.parent) {
        destIndex = nextRow.indexOf() + 1;
      } else {
        destIndex = nextRow.indexOf();
      }
    }

    if (windowProxy && (! destParent.isWindow || (! destParent.isWindow()))) {
      await this.moveWindowProxy(windowProxy, 'down', nestIntoExpandedSibling);
      return;
    }

    // move it
    await this.cursorNodeMoveTo(destParent, destIndex, 'down');
  }

  async action_moveNodeDown (event) {
    debug('TreeView.action_moveNodeDown()');
    await this.moveNodeDownWithNest(true);
  }

  async action_moveNodeDownInvertNest (event) {
    debug('TreeView.action_moveNodeDownInvertNest()');
    await this.moveNodeDownWithNest(false);
  }

  async action_moveNodeUpNoDescend (event) {
    debug('TreeView.action_moveNodeUpNoDescend()');

    const cursor = this.cursor;
    const viewRoot = this.viewRoot;

    // if root, or 1st child of root, do nothing
    if (! cursor) return;
    if (cursor.isRoot() || (cursor === viewRoot)) return;
    if ((cursor.parent.isRoot() || (cursor.parent === viewRoot))
      && (0 === cursor.indexOf())) return;
    if (! cursor.isInViewScope()) return;

    // node can be moved up
    let destParent;
    let destIndex;
    // if 1st child, take parent's parent and index
    if (0 === cursor.indexOf()) {
      destParent = cursor.parent.parent;
      destIndex = cursor.parent.indexOf();
    }
    // if prev sibling, take its index
    else {
      destParent = cursor.parent;
      destIndex = cursor.indexOf() - 1;
    }

    // actually move it
    await this.cursorNodeMoveTo(destParent, destIndex, 'up');
  }

  async action_moveNodeDownNoDescend (event) {
    debug('TreeView.action_moveNodeDownNoDescend()');

    // if last child of root, do nothing
    if (! this.cursor) return;
    if (this.cursor.isRoot()) return;
    if (! this.cursor.isChildOf(this.viewRoot, false)) return;
    const lastIndex = this.cursor.parent.nodes.length - 1;
    if (this.cursor.parent.isRoot() && (lastIndex === this.cursor.indexOf())) return;
    if ((this.cursor.parent === this.viewRoot) && (lastIndex === this.cursor.indexOf()))
      return;

    let destParent;
    let destIndex;
    // if last child, take parent's parent and index after parent
    if (lastIndex === this.cursor.indexOf()) {
      destParent = this.cursor.parent.parent;
      destIndex = this.cursor.parent.indexOf() + 1;
    }
    // if next sibling, move after it
    else {
      destParent = this.cursor.parent;
      destIndex = this.cursor.indexOf() + 2;
    }

    await this.cursor.moveTo(destParent, destIndex, { reason: 'userAction' });
    this.setStatus(`moved down: ${this.cursor.toLine()}`);
  }

  async action_moveNodeRight (event) {
    // skip no-op cases
    if (! this.cursor) return;
    if (this.cursor.isRoot()) return;
    if (! this.cursor.isChildOf(this.viewRoot, false)) return;
    // if already first child, do nothing
    if (0 === this.cursor.indexOf()) return;

    // TODO? move this logic to Node class
    // new parent is previous sibling
    const destParent = this.cursor.parent.nodes[this.cursor.indexOf() - 1];

    let destIndex;
    // if destParent expanded, make this node the last child
    if (destParent.isExpanded()) {
      destIndex = destParent.nodes.length;
    }
    // if new parent collapsed, make this node the *first* child
    // TODO: destination should be configurable
    else {
      destIndex = 0;
    }

    // move it
    const moved = await this.cursorNodeMoveTo(destParent, destIndex, 'right');
  }

  async action_moveNodeLeft (event) {
    // skip no-op cases
    if (! this.cursor) return;
    if (this.cursor.isRoot()) return;
    if (this.cursor.parent.isRoot()) return;
    if (! this.cursor.isChildOf(this.viewRoot, false)) return;
    if (! this.cursor.parent.isChildOf(this.viewRoot, false)) return;

    // become next sibling of parent
    const destParent = this.cursor.parent.parent;
    const destIndex = this.cursor.parent.indexOf() + 1;

    // move it
    await this.cursorNodeMoveTo(destParent, destIndex, 'left');
  }

  async getActiveTabThisWindow () {
    // find our window
    let winNode = viewRoot;
    if ('session' === this.viewScope) {
      // find the current window in the tree
      const win = await api.windows.getCurrent();
      let found = viewRoot.findNodes((node) => {
        return (node.isWindow() && (win.id === node.windowId));
      });
      if (found.length > 0) winNode = found[0];
    }
    const activeTabNode = winNode.getActiveTab();
    return activeTabNode;
  }

  async action_prevOrNextTab (event, which = 'next') {
    debug(`action_prevOrNextTab(${which})`, event);
    if ('command' !== event.type) {
      return;  // this is a command-only action
    }

    const winNode = this.root.getWindowId(this.windowId);
    let activeTabNode = this.getNodeByTabId(event.tab.id);
    if (! activeTabNode) activeTabNode = winNode.getActiveTab();
    const loadedTabNodes = winNode.getLoadedTabs();
    let oldTabIndex = loadedTabNodes.indexOf(activeTabNode);
    debug(`action_prevOrNextTab(${which} ${oldTabIndex})`, winNode, activeTabNode, loadedTabNodes);
    if (oldTabIndex < 0) {
      warn('action_prevOrNextTab(): current tab not found');
      return;
    }

    let newTabIndex = oldTabIndex;
    if ('next' === which) {
      newTabIndex ++;
      if (newTabIndex >= loadedTabNodes.length) newTabIndex = 0;
    } else {
      newTabIndex --;
      if (newTabIndex < 0) newTabIndex = loadedTabNodes.length - 1;
    }
    const newTab = loadedTabNodes[newTabIndex];
    await newTab.setActive(true, { reason: 'userAction' });
  }

  action_prevTab (event) {
    return this.action_prevOrNextTab(event, 'prev');
  }

  action_nextTab (event) {
    return this.action_prevOrNextTab(event, 'next');
  }

  async addNodeAsPrevOrNextVisibleRow (position) {
    // ensure valid position: prev or next
    if (undefined === position) position = 'next';
    if ('next' !== position) position = 'prev';

    // pretend to be a node
    const fake = {
      label: '', note: '',
      isWindow: () => false,
      isLoaded: () => false,
      isRoot: () => false,
    };
    // prompt for details
    const result = await this.nodeEditDialog({
      doc: this.document, title: 'Add Node', node: fake
    });

    // abort if user cancelled
    if ((!result) || ('OK' !== result.button)) return;

    // figure out where to put the new node (determine parent and index)
    let destParent = this.root;  // default if empty tree or no cursor
    let destIndex = 0;
    if (this.cursor) {
      // if root, just make new 1st child
      if (this.cursor.isRoot() || (this.cursor === this.viewRoot)) {
        destParent = this.cursor;
        destIndex = 0;
      }
      // add new row before this one
      else if ('prev' === position) {
        // in all 'prev' cases, just insert a new sibling before self
        destParent = this.cursor.parent;
        destIndex = this.cursor.indexOf();
      }
      // if leaf node: add as next sibling
      // or collapsed branch: add as next sibling
      else if (this.cursor.isLeaf() || this.cursor.isCollapsed()) {
        //log('add to leaf or collapsed');
        destParent = this.cursor.parent;
        destIndex = this.cursor.indexOf() + 1;
      }
      // expanded branch: add as first child
      else {
        //log('add to expanded branch');
        destParent = this.cursor;
        destIndex = 0;
      }
    }

    // don't unpin "Pinned"
    let destNode = destParent.nodes[destIndex];
    if (destNode?.isPinnedBranch()) {
      if (destNode.isCollapsed()) { destIndex ++; }  // next sibling
      else { destParent = destNode; destIndex = 0; }  // first child
    }

    // add a new Node
    let nodeType = '';
    if (result.isWindow) nodeType = 'window';
    const newNode = await destParent.addChild(destIndex,
      { label: result.label, note: result.note, type: nodeType,
        render: true },
      { reason: 'userAction' });
    //log(destParent.nodes);
    await this.setCursor(newNode);
    //debug(`added "${newNode.label}"`);
    this.setStatus(`added ${this.cursor.toLine()}`);
  }

  async action_addNodeAsNextVisibleRow (event) {
    return await this.addNodeAsPrevOrNextVisibleRow('next');
  }

  async action_addNodeAsPrevVisibleRow (event) {
    return await this.addNodeAsPrevOrNextVisibleRow('prev');
  }

  async action_deleteNode(event) {
    debug('deleteNode');
    // abort if nothing to delete
    if (this.root.nodes.length <= 0) return;
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // skip no-op cases
    if (! cursor) return;
    // never delete root
    if (cursor.isRoot()) return;
    if (cursor === this.viewRoot) return;
    // do nothing if cursor is outside of viewRoot
    if (! this.cursor.isChildOf(this.viewRoot, false)) return;

    // figure out where to put the cursor after deletion
    let newCursor = this.cursor;  // default if cursor === mouseNode
    if (cursor === this.cursor) {
      // move to next row when possible
      newCursor = this.cursor.nextVisibleNode();
      // move to prev row if cursor is already on the last row
      if (newCursor === this.cursor) newCursor = this.cursor.prevVisibleNode();
    }
    const restoreCursor = async () => {
      if (newCursor === this.cursor) return;
      await this.setCursor(newCursor);
    };

    // delete depending on the node type and state
    const toDelete = cursor;
    const line = cursor.toLine();
    if (toDelete.isWindow()
      && toDelete.isLoaded()
      && (! toDelete.isCollapsed())
      && (! toDelete.parent.isRoot())
      && toDelete.shouldUnloadNotDelete(false)) {
      const parent = toDelete.parent;
      const index = toDelete.indexOf();
      const labelDetails = {
        label: toDelete.label,
        note: toDelete.note,
        expanded: true,
        render: true
      };
      if (toDelete.hasCheckbox()) {
        labelDetails.checkbox = toDelete.checkbox;
        labelDetails.checkboxPx = toDelete.checkboxPx;
      }
      const labelNode = await parent.addChild(index, labelDetails,
        { reason: 'userAction' });

      const parentWindow = parent.getWindowNode(true);
      const unloadedAncestor = toDelete.findParent(
        (n) => (n.isWindow() && (! n.isLoaded()))
      );
      const wrapNode = this.getWrapNodeForWindowDelete(toDelete);
      const canWrap = wrapNode && (! wrapNode.isRoot());
      if (parentWindow || unloadedAncestor || canWrap) {
        await toDelete.promoteKidsToParentAtIndex(
          labelNode,
          0,
          { reason: 'userAction' }
        );
      }

      if (parentWindow) {
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`unwrapped ${line}`);
        await this.setCursor(labelNode);
        return;
      }

      if (unloadedAncestor) {
        await unloadedAncestor.setTabFields({
          type: 'window',
          windowId: toDelete.windowId,
          loaded: true,
          active: toDelete.active,
          geometry: toDelete.geometry,
          incognito: toDelete.incognito,
          windowState: toDelete.windowState
        }, { reason: 'userAction' });
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`unwrapped ${line}`);
        await this.setCursor(labelNode);
        return;
      }

      if (canWrap) {
        const wrapParent = wrapNode.parent;
        const wrapIndex = wrapNode.indexOf();
        await toDelete.moveTo(wrapParent, wrapIndex, { reason: 'userAction' });
        await wrapNode.moveTo(toDelete, 0, { reason: 'userAction' });
        if (toDelete.label || toDelete.note) {
          await toDelete.setNotes('', '', { reason: 'userAction' });
        }
        if (toDelete.hasCheckbox()) {
          await toDelete.setCheckbox(null, { reason: 'userAction' });
        }
        this.setStatus(`unwrapped ${line}`);
        await this.setCursor(labelNode);
        return;
      }
    }
    if (toDelete.isWindow() && toDelete.isLoaded()) {
      if (toDelete.isCollapsed()) {
        const tabCount = toDelete.getLoadedAndUnloadedTabs().length;
        const tabLabel = (tabCount === 1) ? 'tab' : 'tabs';
        const warning = toDelete.shouldUnloadNotDelete(true)
          ? ' This will also delete notes/labels/checkboxes in this branch.'
          : '';
        const confirmed = await this.confirmDialog(
          'Delete Window',
          `This will close the window and delete ${tabCount} ${tabLabel}.${warning} Continue?`
        );
        if (! confirmed) return;
        await toDelete.unload({ reason: 'userAction' });
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`deleted ${line}`);
        await restoreCursor();
        return;
      }

      if (toDelete.parent.isRoot()) {
        toDelete.keepTabsOnClose = true;
        await toDelete.unload({
          reason: 'userAction',
          wasLoaded: true,
          keepTabsOnClose: true
        });
        this.setStatus(`unloaded ${line}`);
        await restoreCursor();
        return;
      }

      const parentWindow = toDelete.parent
        ? toDelete.parent.getWindowNode(true)
        : null;
      if (parentWindow) {
        const destParent = toDelete.parent;
        const destIndex = toDelete.indexOf();
        await toDelete.promoteKidsToParentAtIndex(
          destParent,
          destIndex,
          { reason: 'userAction' }
        );
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`unwrapped ${line}`);
        await restoreCursor();
        return;
      }

      const unloadedAncestor = toDelete.findParent(
        (n) => (n.isWindow() && (! n.isLoaded()))
      );
      if (unloadedAncestor) {
        await unloadedAncestor.setTabFields({
          type: 'window',
          windowId: toDelete.windowId,
          loaded: true,
          active: toDelete.active,
          geometry: toDelete.geometry,
          incognito: toDelete.incognito,
          windowState: toDelete.windowState
        }, { reason: 'userAction' });
        const destParent = toDelete.parent;
        const destIndex = toDelete.indexOf();
        await toDelete.promoteKidsToParentAtIndex(
          destParent,
          destIndex,
          { reason: 'userAction' }
        );
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`unwrapped ${line}`);
        await restoreCursor();
        return;
      }

      const wrapNode = this.getWrapNodeForWindowDelete(toDelete);
      if (wrapNode && (! wrapNode.isRoot())) {
        const innerParent = toDelete.parent;
        const innerIndex = toDelete.indexOf();
        const wrapParent = wrapNode.parent;
        const wrapIndex = wrapNode.indexOf();
        const kids = [...toDelete.nodes];
        await toDelete.moveTo(wrapParent, wrapIndex, { reason: 'userAction' });
        await wrapNode.moveTo(toDelete, 0, { reason: 'userAction' });
        const reversed = kids.reverse();
        for (const node of reversed) {
          await node.moveTo(innerParent, innerIndex, { reason: 'userAction' });
        }
        this.setStatus(`unwrapped ${line}`);
        await restoreCursor();
        return;
      }
      const tabCount = toDelete.getLoadedAndUnloadedTabs().length;
      const tabLabel = (tabCount === 1) ? 'tab' : 'tabs';
      const confirmed = await this.confirmDialog(
        'Delete Window',
        `This will close the window and unload ${tabCount} ${tabLabel}. Continue?`
      );
      if (! confirmed) return;
      await toDelete.unload({ reason: 'userAction' });
      const destParent = toDelete.parent;
      const destIndex = toDelete.indexOf();
      await toDelete.promoteKidsToParentAtIndex(
        destParent,
        destIndex,
        { reason: 'userAction' }
      );
      await toDelete.deleteSelf({ reason: 'userAction' });
      this.setStatus(`deleted ${line}`);
      await restoreCursor();
      return;
    }
    // if leaf, just delete it... simple
    if (cursor.isLeaf()) {
      //debug('delete leaf node');
      await toDelete.deleteSelf({ reason: 'userAction' });
      this.setStatus(`deleted ${line}`);
    }
    // don't delete an open window; unload it instead
    else if (cursor.isWindow() && cursor.isLoaded()) {
      return await this.action_unloadNode(event);
    }
    // if expanded, promote kids then delete parent
    else if (cursor.isExpanded() && cursor.hasKids()) {
      let dStyle = this.cfg.deleteExpandedBranchStyle;
      const numToDelete = 1 + toDelete.countNodes();
      // Keyboard deletion has historically meant "unwrap this expanded
      // branch".  It also needs to remain deterministic because a command has
      // no click target to anchor a modal choice.
      if (('ask' === dStyle || ! dStyle) && ('command' === event.type)) {
        dStyle = 'one';
      }
      if ('ask' === dStyle) {
        const result = await this.inputDialog({
          doc: this.document,
          title: 'Delete Nodes',
          input: false,
          description: `Delete one node or all ${numToDelete} nodes?`,
          buttons: ['Cancel', 'One', 'All']  // Cancel is default
        });
        // abort if user cancelled
        if ((!result) || (! ['All', 'One'].includes(result.button))) return;
        dStyle = result.button.toLowerCase();
      }
      if ('one' === dStyle) {
        await toDelete.deleteSelfAndPromoteKids({ reason: 'userAction' });
        this.setStatus(`deleted ${line}`);
      }
      //else if ('row1' === dStyle) {
      //  // FIXME: write this?
      //  await toDelete.deleteSelfAndPromoteFirstKid({ reason: 'userAction' });
      //  this.setStatus(`deleted ${line}`);
      //}
      else if ('all' === dStyle) {
        await toDelete.deleteSelf({ reason: 'userAction' });
        this.setStatus(`deleted ${numToDelete} nodes`);
      }
    }
    // if collapsed, delete entire branch
    else {
      //debug('deleting entire branch recursively');
      // TODO: ask the user for confirmation
      const numToDelete = 1 + toDelete.countNodes();
      const result = await this.inputDialog({
        doc: this.document,
        title: 'Delete Nodes',
        input: false,
        description: `Really delete ${numToDelete} nodes?`,
        buttons: ['Cancel', 'OK']  // Cancel is default
      });
      // abort if user cancelled
      if ((!result) || ('OK' !== result.button)) return;
      // otherwise, actually delete it
      await toDelete.deleteSelf({ reason: 'userAction' });
      this.setStatus(`deleted ${numToDelete} nodes`);
    }

    // update the cursor
    await restoreCursor();
  }

  getWrapNodeForWindowDelete (windowNode) {
    let wrapNode = windowNode.parent;
    if (! wrapNode) return null;
    if (this.openWindowOnRootLoadTopmost) {
      while (wrapNode.parent
        && (! wrapNode.parent.isRoot())
        && (! wrapNode.parent.isWindow())) {
        wrapNode = wrapNode.parent;
      }
    }
    return wrapNode;
  }

  async action_unloadNode (event) {
    debug('action_unloadNode');
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // abort if nothing to unload
    if (! cursor) return;

    // non-window branch w/ loaded tabs needs special care
    if (cursor.hasLoadedTabs() && (! cursor.isWindow())) {
      const loadedTabs = cursor.getLoadedTabs();
      loadedTabs.reverse();  // unload from bottom to top
      if (cursor.isLoadedTab()) loadedTabs.push(cursor);
      // TODO: sort loadedTabs so active tab (if any) is last
      const cursorLoaded = cursor.isLoadedTab();
      const numLoaded = loadedTabs.length;

      // check user prefs for what to do
      let actionStyle = cursor.isCollapsed()
        ? this.cfg.unloadCollapsedBranchStyle
        : this.cfg.unloadExpandedBranchStyle;

      // can't use a dialog without a mouse when invoked via command
      // so change "ask" to "one"
      if (('ask' === actionStyle) && ('command' === event.type))
      { actionStyle = 'one'; }

      // ask, if we're gonna
      if ('ask' === actionStyle) {
        let description;
        let buttons;
        if (cursorLoaded) {
          description = `Unload one (cursor) tab or all ${numLoaded} tabs?`;
          buttons = ['Cancel', 'One', 'All'];  // Cancel is default
        } else {
          description = `Unload all ${numLoaded} tabs?`;
          buttons = ['Cancel', 'All'];  // Cancel is default
        }
        const result = await this.inputDialog({
          doc: this.document,
          title: 'Unload Tabs',
          input: false,
          description: description,
          buttons: buttons,
        });
        // abort if user cancelled
        if ((!result) || (! ['All', 'One'].includes(result.button))) return;
        actionStyle = result.button.toLowerCase();
      }
      if ('one' === actionStyle) {
        const success = await cursor.unload({ reason: 'userAction' });
        if (success) this.setStatus(`unloaded ${cursor.toLine()}`);
        else this.setStatus(`failed to unload ${cursor.toLine()}`);
      }
      else if ('all' === actionStyle) {
        let numSucceeded = 0;
        let numFailed = 0;
        for (const tabNode of loadedTabs) {
          const success = await tabNode.unload(
            { reason: 'userAction', wasLoaded: true });
          if (success) numSucceeded ++;
          else numFailed ++;
        }
        const failText = (numFailed ? `, ${numFailed} failed` : '');
        this.setStatus(`unloaded ${numSucceeded} nodes${failText}`);
      }
    }
    else {
      await cursor.unload({ reason: 'userAction' });
      this.setStatus(`unloaded ${cursor.toLine()}`);
    }
  }

  async action_loadNode (event) {
    debug('action_loadNode');
    if ('command' !== event.type) {
      event.preventDefault();
      event.stopPropagation();
    }
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // abort if nothing to do
    if (! cursor) return;

    // some cases need an action other than "load tabs"
    if (cursor.isLeaf()
      || cursor.isUnloadedWindow()
      || (cursor.isLoadedTab() && (! cursor.isActive()))
    ) return this.action_loadOrEditNode(event, false);

    // gather some data about the kids (god that sounds wrong)
    const loadedTabs = cursor.findNodes(
      (n) => n.isLoadedTab(), (n) => (! n.isWindow())
    );  loadedTabs.reverse();
    if (cursor.isLoadedTab()) loadedTabs.push(cursor);

    const wasLoadedTabs = cursor.findNodes(
      (n) => n.isWasLoadedTab(), (n) => (! n.isWindow())
    );  wasLoadedTabs.reverse();
    if (cursor.isWasLoadedTab()) wasLoadedTabs.push(cursor);

    const unloadedTabs = cursor.findNodes(
      (n) => n.isUnloadedTab(), (n) => (! n.isWindow())
    );  unloadedTabs.reverse();
    if (cursor.isUnloadedTab()) unloadedTabs.push(cursor);

    //debug('loadedTabs, wasLoadedTabs, unloadedTabs:', loadedTabs, wasLoadedTabs, unloadedTabs);

    const noUnloadedTabs = ((wasLoadedTabs.length <= 0)
      && (unloadedTabs.length <= 0));
    if (noUnloadedTabs) {
      if (cursor.isBookmark())
        return this.action_loadOrEditNode(event, false);
      // nothing to do, everything is already loaded
      this.setStatus('nothing to load');
      return;
    }

    // check user prefs for what to do
    let actionStyle = cursor.isCollapsed()
      ? this.cfg.loadCollapsedBranchStyle
      : this.cfg.loadExpandedBranchStyle;

    // can't use a dialog without a mouse when invoked via command
    // so change "ask" to "one"
    if (('ask' === actionStyle) && ('command' === event.type))
    { actionStyle = 'one'; }

    // if cursor is the only node affected, we don't need to ask what to do
    if (wasLoadedTabs[0] === cursor) actionStyle = 'one';
    else if ((wasLoadedTabs.length === 0)
      && (unloadedTabs[0] === cursor))
      actionStyle = 'one';

    // decide what we're loading
    // (the queue puts the top-most row last, so focus will go to the tab
    //  which is closest to the original cursor position, because that tab
    //  gets loaded last)
    let numToLoad = wasLoadedTabs.length;
    let styleToLoad = 'wasLoaded';
    let queue = wasLoadedTabs;
    if (! numToLoad) {
      numToLoad = unloadedTabs.length;
      styleToLoad = 'unloaded';
      queue = unloadedTabs;
    }

    // if cursor is unaffected, the "one" actionStyle makes no sense
    const cursorInQueue = (queue[queue.length - 1] === cursor);

    // this would be the appropriate time ask, if we're gonna
    if ('ask' === actionStyle) {
      let description;
      let buttons;
      if (cursorInQueue) {
        description = `Load one (cursor) or all ${numToLoad} ${styleToLoad} tabs?`;
        buttons = ['Cancel', 'One', 'All'];  // Cancel is default
      } else {
        description = `Load all ${numToLoad} ${styleToLoad} tabs?`;
        buttons = ['Cancel', 'All'];  // Cancel is default
      }
      const result = await this.inputDialog({
        doc: this.document,
        title: 'Load Tabs',
        input: false,
        description: description,
        buttons: buttons,
      });
      // abort if user cancelled
      if ((!result) || (! ['All', 'One'].includes(result.button))) return;
      actionStyle = result.button.toLowerCase();
    }

    if ('one' === actionStyle) {
      if (cursor.isBookmark())
        return this.action_loadOrEditNode(event, false);
      const success = await cursor.load({ reason: 'userAction' });
      if (success) this.setStatus(`loaded ${cursor.toLine()}`);
      else this.setStatus(`failed to load ${cursor.toLine()}`);
    }
    else if ('all' === actionStyle) {
      let numSucceeded = 0;
      let numFailed = 0;
      for (const tabNode of queue) {
        const success = await tabNode.load({ reason: 'userAction' });
        if (success) numSucceeded ++;
        else numFailed ++;
      }
      const failText = (numFailed ? `, ${numFailed} failed` : '');
      this.setStatus(`loaded ${numSucceeded} nodes${failText}`);

      // setActive tab events can get confused when loading so much so fast,
      // so do it explicitly afterward
      const lastLoaded = queue[queue.length - 1];
      if (lastLoaded) {
        const winNode = lastLoaded.getWindowNode();
        if (winNode) {
          setTimeout(() => {
            this.runUiAction(
              'Active tab refresh',
              () => winNode.setActiveTab({
                reason: 'action_loadNodeBatch'
              })
            );
          }, 500);
        }
      }
    }
  }

  async action_toggleLoad (event) {
    debug('action_toggleLoad');
    const cursor = this.whichCursor(event);
    if (! cursor) return;

    const hasLoadedContent =
      cursor.isLoaded() || cursor.hasLoadedTabs();
    if (hasLoadedContent) return this.action_unloadNode(event);
    return this.action_loadNode(event);
  }

  async action_loadOrEditNode (event, allowEdit = true) {
    debug('action_loadOrEditNode');
    if ('command' !== event.type) {
      event.preventDefault();
      event.stopPropagation();
    }
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // abort if nothing to do
    if (! cursor) return;

    // if bookmark, clone a new child and load it
    if (cursor.isBookmark()) {
      const newNode = await cursor.addChild(0,
        { url: cursor.url, title: cursor.title, render: true },
        { reason: 'userAction' });
      if (! newNode) return this.setStatus(`failed to load ${cursor.toLine()}`);
      await newNode.load({ reason: 'userAction' });
      this.setStatus(`loaded ${newNode.toLine()}`);
    }
    // if unloaded tab, load it
    else if (cursor.isUnloadedTab()) {
      await cursor.load({ reason: 'userAction' });
      this.setStatus(`loaded ${cursor.toLine()}`);
    }
    // if loaded tab but not focused, focus it
    else if (cursor.isLoaded() && (!cursor.isActive()) && (!cursor.isWindow())) {
      await cursor.setActive(true, { reason: 'userAction' });
    }
    // if loaded tab is already active, still focus its window
    else if (cursor.isLoaded() && cursor.isActive() && (!cursor.isWindow())) {
      if (allowEdit && this.focusActiveTabOnLoadOrEdit) {
        await emit('bkgd_focusWindow',
          {
            nodeId: cursor.id,
            tabId: cursor.tabId,
            windowId: cursor.windowId,
            reason: 'userAction'
          });
        return;
      }
    }
    // if unloaded window, load it
    else if (cursor.isUnloadedWindow()) {
      await cursor.load({ reason: 'userAction' });
      this.setStatus(`loaded ${cursor.toLine()}`);
    }
    // if note or focused tab or window, edit it
    else {
      if (allowEdit) await this.action_editNode(event);
    }
  }

  isMouseEvent (event) {
    return ['click', 'dblclick'].includes(event.type);
  }

  async confirmDialog (title, description) {
    const result = await this.inputDialog({
      doc: this.document,
      title,
      input: false,
      description,
      buttons: ['OK', 'Cancel']
    });
    return result && ('OK' === result.button);
  }

  async batchLoadCollapsed (cursor, event, allowEdit, forceNoDialog = false) {
    if (! forceNoDialog) return this.action_loadNode(event);

    const queue = cursor.findNodes(
      (node) => node.isUnloadedTab(),
      (node) => ! node.isWindow()
    );
    if (cursor.isUnloadedTab()) queue.push(cursor);
    if (cursor.isUnloadedWindow()) {
      await cursor.load({ reason: 'userAction' });
    } else {
      for (const tabNode of queue.reverse()) {
        await tabNode.load({ reason: 'userAction' });
      }
    }
    this.setStatus(`loaded ${Math.max(1, queue.length)} tabs`);
  }

  // Force load or unload without confirmation dialog
  // Acts like load/unload, but never asks for confirmation.
  async action_forceToggleLoad (event) {
    debug('action_forceToggleLoad');
    let cursor = this.whichCursor(event);
    if (! cursor) return;

    const hasLoadedContent =
      cursor.isLoaded() || cursor.hasLoadedTabs();

    if (! hasLoadedContent) {
      // Load: use batch load but skip dialog (pass forceNoDialog=true)
      return this.batchLoadCollapsed(cursor, event, false, true);
    } else {
      // Unload: batch unload without dialog
      return this.batchUnloadCollapsed(cursor, true);
    }
  }

  // Helper: batch unload collapsed node's children
  async batchUnloadCollapsed (cursor, skipDialog = false) {
    if (cursor.isCollapsed() && cursor.hasKids()) {
      const loadedTabs = cursor.getLoadedTabs();
      const count = loadedTabs.length + (cursor.isLoaded() ? 1 : 0);
      if (count === 0) {
        if (cursor.isWindow()) cursor.keepTabsOnClose = true;
        await cursor.unload({
          reason: 'userAction',
          wasLoaded: cursor.isWindow() ? true : undefined,
          keepTabsOnClose: cursor.isWindow()
        });
        this.setStatus(`unloaded ${cursor.toLine()}`);
        return;
      }
      if (!skipDialog && (count > 1)) {
        const confirmed = await this.confirmDialog('Unload Tabs', `Unload ${count} tabs?`);
        if (! confirmed) return;
      }
      const unloadReason = cursor.isWindow() ? 'onWindowRemoved' : 'userAction';
      for (const tab of loadedTabs) {
        await tab.unload({ reason: unloadReason });
      }
      if (cursor.isWindow()) cursor.keepTabsOnClose = true;
      await cursor.unload({
        reason: 'userAction',
        wasLoaded: cursor.isWindow() ? true : undefined,
        keepTabsOnClose: cursor.isWindow()
      });
      this.setStatus(`unloaded ${count} tabs`);
    } else {
      if (cursor.isWindow()) cursor.keepTabsOnClose = true;
      await cursor.unload({
        reason: 'userAction',
        wasLoaded: cursor.isWindow() ? true : undefined,
        keepTabsOnClose: cursor.isWindow()
      });
      this.setStatus(`unloaded ${cursor.toLine()}`);
    }
  }

  action_toggleExpanded (event) {
    debug('action_toggleExpanded()');
    // skip no-op cases
    if (! this.cursor) return;
    // twiddle the state
    const toggled = ! this.cursor.isExpanded();
    this.cursor.setExpanded(toggled, { reason: 'userAction' });
    const verbed = toggled ? 'Expanded' : 'Collapsed';
    this.setStatus(`${verbed} ${this.cursor.toLine()}`);
  }

  async action_editNode (event) {
    debug('action_editNode()');
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // skip no-op cases
    if (! cursor) return;

    // prompt for new label/note text
    const result = await this.nodeEditDialog({
      doc: this.document, title: 'Edit Node', node: cursor
    });
    debug('editNode(result):', result);
    // abort if user cancelled
    if ((!result) || ('OK' !== result.button)) {
      this.setStatus('editNode: cancelled');
      return;
    }

    // what changed?
    const isWindowChanged = (undefined !== result.isWindow)
      && ((!! cursor.isWindow()) !== (!! result.isWindow));
    const incognitoChanged = (undefined !== result.incognito)
      && ((!! cursor.isIncognito()) !== (!! result.incognito));
    const pageDataChanged =
      ((undefined !== result.title) && (cursor.title !== result.title))
      || ((undefined !== result.url) && (cursor.url !== result.url))
      || ((undefined !== result.bookmark) && (cursor.bookmark !== result.bookmark))
      ;
    const hasLoadedTabs = cursor.isLoaded() || cursor.hasLoadedTabs();

    // attempt to change loaded window's incognito status
    // (should never happen)
    if (hasLoadedTabs && incognitoChanged) {
      this.setStatus("editNode: Can't change incognito on loaded window");
      return false;
    }
    // loaded window status changed
    else if (hasLoadedTabs && isWindowChanged) {
      debug('editNode(): convert loaded window');
      const changes = { label: result.label, note: result.note };
      changes.type = result.isWindow ? 'window' : '';
      if (! result.isWindow) changes.wasLoaded = false;
      const changed = await cursor.setTabFields(
        changes, { reason: 'userAction' });
      if (changed) this.setStatus(`Edited ${cursor.toLine()}`);
      return changed;
    }
    // unloaded window status changed
    // or unloaded window incognito status changed
    else if (isWindowChanged || incognitoChanged) {
      const changes = { label: result.label, note: result.note };
      if (isWindowChanged) changes.type = result.isWindow ? 'window' : '';
      if (incognitoChanged) changes.incognito = result.incognito;
      if (! result.isWindow) changes.wasLoaded = false;
      const changed = await cursor.setTabFields(
        changes, { reason: 'userAction' });
      if (changed) this.setStatus(`Edited ${cursor.toLine()}`);
      return changed;
    }

    // below here, we know window and incognito status didn't change

    // unloaded tab can edit title+url+bookmark too
    if (pageDataChanged && (cursor.isUnloadedTab() || cursor.isBookmark())) {
      const changed = await cursor.setTabFields(
        { label: result.label, note: result.note,
          url: result.url, title: result.title, bookmark: result.bookmark },
        { reason: 'userAction' });
      if (changed) this.setStatus(`Edited ${cursor.toLine()}`);
      return changed;
    }

    // note-only changes are simple
    if ((cursor.label !== result.label) || (cursor.note !== result.note)) {
      const changed = await cursor.setNotes(
        result.label, result.note, { reason: 'userAction' });
      if (changed) this.setStatus(`Edited ${cursor.toLine()}`);
      return changed;
    }

    // every allowed case is handled,
    // so it looks like nothing changed
    this.setStatus(`Unchanged: ${cursor.toLine()}`);
    return false;
  }

  async action_taskEdit (event) {
    debug('action_taskEdit()');
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // skip no-op cases
    if (! cursor) return;
    if (cursor.isRoot()) return;

    // prompt for new label/note text
    const result = await this.checkboxDialog({
      doc: this.document,
      title: 'Edit Task',
      description: cursor.toLine(),
      value: cursor.checkbox,
      classes: this.checkboxClasses,
      buttons: ['OK', 'Delete']
    });
    // abort if user cancelled
    if (!result) return;

    // update the node
    let newValue = result.checkbox;
    if ('Delete' === result.button) newValue = undefined;
    else if ('OK' !== result.button) return;
    const px = result.checkboxPx;
    // user manually set a numeric percent value
    if (undefined !== px) await cursor.setCheckbox(newValue,
      { checkboxPx: px, reason: 'userAction' });
    // user didn't set a percent value
    else await cursor.setCheckbox(newValue, { reason: 'userAction' });
    this.setStatus(`Edited ${cursor.toLine()}`);
  }

  async action_toggleMarked (event) {
    debug('action_toggleMarked()');
    // choose mouse or keyboard cursor based on event type
    let cursor = this.whichCursor(event);
    // skip no-op cases
    if (! cursor) return;
    const toggled = ! cursor.marked;
    await cursor.setMarked(toggled, { reason: 'userAction' });
    const verbed = toggled ? 'Marked' : 'Unmarked';
    this.setStatus(`${verbed} ${cursor.toLine()}`);
  }

  async action_unmarkAll (event) {
    debug('action_unmarkAll()');
    await this.unmarkAll({ reason: 'userAction' });
    this.setStatus(`Unmarked all nodes`);
  }

  async action_pasteMarked (event, before=false) {
    // skip no-op cases
    if (! this.cursor) return;
    debug(`action_pasteMarked(before=${before})`);

    // find the right place to put the marked nodes
    let destParent;
    let destIndex;
    const markedParent = this.cursor.markedBy();
    if (this.cursor.isRoot()) {
      destParent = this.cursor;
      destIndex = 0;
    }
    else if (markedParent) {
      // haha, I see you... trying to dive into your own belly button
      // but this is a strict No Infinite Recursion Zone
      destParent = markedParent.parent;
      destIndex = markedParent.indexOf();
    }
    else if (before) {
      // if pasting before, just paste at the cursor's position
      destParent = this.cursor.parent;
      destIndex = this.cursor.indexOf();
    }
    else if (this.cursor.hasKids() && this.cursor.isExpanded()) {
      // if expanded with kids, paste as new first children
      destParent = this.cursor;
      destIndex = 0;
    }
    else {
      // otherwise, paste as next sibling(s)
      destParent = this.cursor.parent;
      destIndex = this.cursor.indexOf() + 1;
    }

    const orderMap = new Map();
    let orderIndex = 0;
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      orderMap.set(node.id, orderIndex);
      orderIndex += 1;
      for (let i = node.nodes.length - 1; i >= 0; i--) {
        stack.push(node.nodes[i]);
      }
    }
    const orderedMarkedNodes = this.markedNodes.slice().sort((a, b) => {
      const orderA = orderMap.has(a) ? orderMap.get(a) : Number.MAX_SAFE_INTEGER;
      const orderB = orderMap.has(b) ? orderMap.get(b) : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return String(a).localeCompare(String(b));
    });
    let numMoved = 0;
    let numFailed = 0;
    let moved = false;
    for (const nodeId of orderedMarkedNodes) {
      const node = this.nodes[nodeId];
      if (! node) {
        numFailed ++;
        continue;
      }
      // special case: moving from/to same parent can get weird
      const pastingToSameParent = (node.parent === destParent);
      const oldIndex = node.indexOf();
      // move the node
      moved = await node.moveTo(destParent, destIndex, { reason: 'userAction' });
      if (moved) numMoved ++;
      else numFailed ++;
      // adjust if special case was triggered
      if (pastingToSameParent) {
        if (oldIndex < destIndex)
          destIndex --;
      }
      // next paste goes at next slot
      destIndex ++;
    }
    if (numFailed > 0)
      this.setStatus(`Moved ${numMoved} nodes, ${numFailed} failed`);
    else this.setStatus(`Moved ${numMoved} nodes`);
  }

  async action_pasteMarkedBefore (event) {
    if (! this.cursor) return;
    debug('action_pasteMarkedBefore()');

    let destParent;
    let destIndex;
    const markedParent = this.cursor.markedBy();
    if (this.cursor.isRoot()) {
      destParent = this.cursor;
      destIndex = 0;
    }
    else if (markedParent) {
      destParent = markedParent.parent;
      destIndex = markedParent.indexOf();
    }
    else {
      destParent = this.cursor.parent;
      destIndex = this.cursor.indexOf();
    }
    if (! destParent) return;

    const orderMap = new Map();
    let orderIndex = 0;
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop();
      orderMap.set(node.id, orderIndex);
      orderIndex += 1;
      for (let i = node.nodes.length - 1; i >= 0; i--) {
        stack.push(node.nodes[i]);
      }
    }
    const orderedMarkedNodes = this.markedNodes.slice().sort((a, b) => {
      const orderA = orderMap.has(a) ? orderMap.get(a) : Number.MAX_SAFE_INTEGER;
      const orderB = orderMap.has(b) ? orderMap.get(b) : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return String(a).localeCompare(String(b));
    });

    let insertIndex = destIndex;
    for (const nodeId of orderedMarkedNodes) {
      const node = this.nodes[nodeId];
      if (! node) continue;
      if (node.parent === destParent && node.indexOf() < destIndex) {
        insertIndex -= 1;
      }
    }

    let numMoved = 0;
    for (const nodeId of orderedMarkedNodes) {
      const node = this.nodes[nodeId];
      if (! node) continue;
      await node.moveTo(destParent, insertIndex, { reason: 'userAction' });
      numMoved += 1;
      insertIndex += 1;
    }
    this.setStatus(`Moved ${numMoved} nodes`);
  }

  async action_backupSession (event) {
    return await this.downloadBackupNow();
  }

  async action_generateTutorial (event) {
    let parentId;
    if (this.windowNode) parentId = this.windowNode.id;
    else if (this.root.nodes.length > 0) parentId = this.root.nodes[0].id;
    else parentId = this.root.id;
    // A lost response must not generate a second tutorial branch.
    return await emit(
      'bkgd_generateTutorial',
      { parentId },
      { retry: false }
    );
  }

  async action_mousePressLeft (event) {
    // abort on no-op
    if (! this.mouseNode) return;
    // save for later potential drag-n-drop
    this.mouseDragStartNode = this.mouseNodeNonRoot;
    // place the cursor (and *don't* await)
    this.runUiAction(
      'Mouse cursor update',
      () => this.setCursor(this.mouseNodeNonRoot, {
        instant: false,
        scrollDelay: this.cfg.doubleClickMs
      })
    );
    // maybe modify a checkbox
    if (this.$mouseElem?.classList.contains('node-checkbox')) {
      await this.action_taskEdit(event);
      return;
    }
    // maybe toggle expanded
    if (this.$mouseRow) {
      let leftWidth = this.$mouseRowHgt;
      // wider target area when a checkbox exists and node-stats doesn't
      if (this.mouseNode.checkbox
        && this.mouseNode.isExpanded()
        && this.mouseNode.hasKids())
      {
        const $cb = this.mouseNode.$.querySelector('.node-checkbox');
        if ($cb) leftWidth += $cb.offsetWidth;
      }
      //debug(`mouseRowX (${this.$mouseRowX}), leftWidth (${leftWidth})`);
      // if user clicked the left ~1em of the row, toggle expand
      // (or if they clicked the node stats widget)
      if ((this.$mouseRowX <= leftWidth)
        || (this.$mouseElem
          && this.$mouseElem.classList.contains('node-stats'))
      ) {
        await this.action_toggleExpanded(event);
      }
    }
  }

  action_mouseHoverMenu (event) {
    //debug(`action_mouseHoverMenu ${this.mouseNode.toLine()}`);
    event.preventDefault();
    event.stopPropagation();
    if (this.mouseNode && this.$mouseRow) return this.showHoverMenu();
    else return this.hideHoverMenu();
  }

  action_mouseDragStart (event) {
    // abort on no-op
    if (! this.mouseNode) return;

    // save for later
    // (was saved already during mousePressLeft)
    // (it's too late to detect now, view may have scrolled)
    if (! this.mouseDragStartNode) this.mouseDragStartNode = this.cursor;
    //if (! this.mouseDragStartNode) this.mouseDragStartNode = this.mouseNode;
    //this.mouseDragStartNode = this.mouseNode;

    // add info for internal use
    // browser blocks event.dataTransfer.getData() during a drag,
    // so we have to embed the data into the mimetype itself :(
    const mimeTypeHack = `${this.nodeIdMimeType}-${this.mouseDragStartNode.id}`;
    event.dataTransfer.setData(mimeTypeHack, this.mouseDragStartNode.id);
    event.dataTransfer.setData(this.nodeIdMimeType, this.mouseDragStartNode.id);

    // attach a text representation in case the user drops into a text field
    const plainText = this.mouseDragStartNode.asTextBranch();
    event.dataTransfer.setData('text', plainText);

    // change how the node looks
    this.mouseDragStartNode.$.classList.add('dragging');
    // default drag image obscures drop target, so make a smaller one
    let dragImage = this.document.getElementById('drag-arrow');
    event.dataTransfer.setDragImage(dragImage, 0, 12);

    // let other funcs know to behave differently during a drag
    this.dragInProgress = true;

    // this gets in the way during a drag
    this.hideHoverMenu();
  }

  action_mouseDrag (event) {
  }

  getMouseDragTarget (event) {
    const result = {};
    // drop target
    let sourceNode;
    let targetNode = this.mouseNodeNonRoot;
    //debug(`targetNode:`, targetNode);
    // abort on no-op
    if (! targetNode) return result;

    // where did the data come from?
    const types = event.dataTransfer.types;
    // internal (from a TreeView in this extension)
    if (types.includes(this.nodeIdMimeType)) {
      result.source = 'internal';
      // drop within a single sidepanel, or from one sidepanel to another
      let nodeId = event.dataTransfer.getData(this.nodeIdMimeType);
      if (! nodeId) {
        // 1st method only works at the end of a drag, not during the middle
        // extract node ID from the mimetype itself
        const prefix = this.nodeIdMimeType + '-';
        nodeId = types.find(t => t.startsWith(prefix))?.slice(prefix.length);
      }
      //debug(`nodeId: ${nodeId}`, nodeId);
      if (nodeId) {
        sourceNode = this.nodes[nodeId];
        if (! sourceNode) {
          // return result;
          // dragged from other tktsto instance with different node IDs?
          result.source = undefined;
        }
      } // else { debug('no nodeId'); }
      // don't move a parent into its own child list
      if (sourceNode === targetNode) return result;
      if (sourceNode && targetNode.isChildOf(sourceNode)) return result;
    }

    // drop from some other source
    if (! result.source) {
      //debug('source: external');
      result.source = 'external';
      sourceNode = undefined;
    }

    // source and target confirmed
    result.sourceNode = sourceNode;
    result.targetNode = targetNode;
    // external drops are complicated
    if ('external' === result.source) {
      result.sourceNode = undefined;
      // URL (Firefox)
      if (types.includes('text/x-moz-url')) {
        result.type = 'url';
        result.title = event.dataTransfer.getData('text/x-moz-url-desc');
        result.url = event.dataTransfer.getData('text/x-moz-url-data');
        if (! result.url)
          result.url = event.dataTransfer.getData('text/x-moz-url');
        if (! result.title) result.title = result.url;
      }
      else if (types.includes('text/uri-list')) {
        result.type = 'url';
        // WTF, uri-list is plain text, one URL per line, with comments
        // https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/Recommended_drag_types
        const text = event.dataTransfer.getData('text/plain');
        const html = event.dataTransfer.getData('text/html');
        //const uriList = event.dataTransfer.getData('text/uri-list');
        //debug(`drop:`, text, html, uriList);
        if (text) result.url = text;
        if (html) {
          // why is this not included as a field by default??
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const a = doc.querySelector("a");
          result.title = a.textContent;
          if (result.title)  // clean up extra whitespace
            result.title = result.title.trim().replace(/\s+/g, ' ');
        }
      }
      // plain text
      else if (types.includes('text/plain')) {
        result.type = 'text';
        // apparently can't get the data until drop happens :(
        result.text = event.dataTransfer.getData('text/plain');
        //debug(result.text);
      }
    }
    // if user dropped in right part of row, drop as 1st child
    if (this.$mouseRow && (this.$mouseRowX >= (this.$mouseRowWid / 5))) {
      result.destParent = targetNode;
      result.destIndex = 0;
      result.targetClass = 'drop-target-right';
    }
    // if user dropped outside row or in the left part of the row,
    // drop as next sibling
    else {
      result.destParent = targetNode.parent;
      result.destIndex = targetNode.indexOf() + 1;
      result.targetClass = 'drop-target-left';
    }
    return result;
  }

  clearDropTargetNodeStyles () {
    if (this.dropTargetNode) {
      for (const elem of [this.dropTargetNode.$, this.dropTargetNode.$row])
        for (const cl of [...elem.classList])
          if (cl.startsWith('drop-')) elem.classList.remove(cl);
    }
  }

  action_mouseDragOver (event) {
    // apparently "drop" won't work unless we eat this event
    event.preventDefault();
    // Scroll when near the top or bottom of the tree view
    this.scrollDuringDrag (event);
    // figure out where to drop it
    const drop = this.getMouseDragTarget(event);
    // remove styles of previous drop target
    this.clearDropTargetNodeStyles();
    // abort on no-op
    if (! drop.targetNode) return;
    // save new drop target
    this.dropTargetNode = drop.targetNode;
    // set styles on new drop target
    let elem = (
        ('drop-target-left' === drop.targetClass)
        && (drop.targetNode !== this.root)
      ) ? drop.targetNode.$ : drop.targetNode.$row;
    elem.classList.add(drop.targetClass);
    if ('external' === drop.source)
      elem.classList.add(`drop-external-${drop.type}`);
  }

  scrollDuringDrag (event) {
    // Scroll when near the top or bottom of the tree view
    const rect = this.$.getBoundingClientRect();
    const y = event.clientY - rect.top; // mouse position inside element
    const height = rect.height;
    const scrollZone = height * this.dragScrollZone;
    this.maxDragScrollSpeed = height * this.dragScrollZone * 0.25;

    //debug(`scroll? ${y}/${height} (0..${scrollZone}, ${height - scrollZone}..${height})`);
    if (y < scrollZone) {
      // near top
      const intensity = 1 - y / scrollZone;
      // negative = scroll up
      this.dragScrollSpeed = -intensity * this.maxDragScrollSpeed;
    } else if (y > (height - scrollZone)) {
      // near bottom
      const intensity = (y - (height - scrollZone)) / scrollZone;
      // positive = scroll down
      this.dragScrollSpeed = intensity * this.maxDragScrollSpeed;
    } else {
      this.dragScrollSpeed = 0;
    }

    // begin scrolling, maybe
    if (this.dragScrollSpeed && (! this.dragAnimationFrame)) {
      this.dragAnimationFrame = requestAnimationFrame(this.updateDragScroll.bind(this));
    }
  }

  updateDragScroll () {
    // scroll the tree view during a drag-n-drop
    //debug(`updateDragScroll(${this.dragScrollSpeed})`);

    // ramp up to target scroll speed by simulating inertia
    if (undefined === this.actualScrollSpeed) this.actualScrollSpeed = 0;
    this.actualScrollSpeed =
      (this.actualScrollSpeed * 0.9)
      + (this.dragScrollSpeed * 0.1);

    // stop when the numbers are too small
    const min = 1.0 / 60;  // stop at 1 pixel per 60 frames
    let fudge = 0;
    if (isFirefox) fudge = 0.2;  // Firefox scrolls up too long
    if ((-(min+fudge) <= this.actualScrollSpeed)
      && (this.actualScrollSpeed < min))
      this.actualScrollSpeed = 0;

    // scroll
    if (this.actualScrollSpeed) {
      this.$.scrollTop += this.actualScrollSpeed;
      this.dragAnimationFrame = requestAnimationFrame(this.updateDragScroll.bind(this));
    } else {
      this.dragAnimationFrame = null;
    }
  }

  async action_mouseDrop (event) {
    event.preventDefault();

    // clean up at the end
    let finished = false;
    const finish = (msg) => {
      debug(`mouseDrop.finish(): ${msg}`);
      this.dragInProgress = false;
      // only finish once
      if (finished) return;
      finished = true;
      if (msg) this.setStatus(msg);
      this.action_mouseDragEnd(event);
    }

    // figure out where to drop it
    const drop = this.getMouseDragTarget(event);
    // abort on no-op
    if (! drop.targetNode) return finish('drop aborted (no target)');
    // internal source: move the node
    if ('internal' === drop.source) {
      if (drop.targetNode === drop.sourceNode) return finish('drop aborted (self target)');
      // don't move a parent into its own child list
      if (drop.targetNode.isChildOf(drop.sourceNode))
        return finish('drop aborted (own child)');
      // prevent cursor from disappearing or jumping
      const wasCursor = this.cursor === drop.sourceNode;
      if (wasCursor && (drop.destParent.isCollapsed()))
        await this.setCursor(drop.destParent);
      // move it
      const moved = await drop.sourceNode.moveTo(
        drop.destParent, drop.destIndex,
        { reason: 'userAction' });
      if (moved) return finish(`moved node: ${drop.sourceNode.toLine()}`);
      else {
        // undo cursor change if move failed
        if (wasCursor && (this.cursor !== drop.sourceNode))
          await this.setCursor(drop.sourceNode);
        return finish(`move failed: ${drop.sourceNode.toLine()}`);
      }
    }
    // external source: try to attach external data
    else {
      debug('action_mouseDrop', event, event.dataTransfer.types);
      // add links as new link nodes
      if ('url' === drop.type) {
        let newNode = await drop.destParent.addChild(drop.destIndex,
          { url: drop.url, title: drop.title, render: true },
          { reason: 'userAction' });
        return finish(`Added node: ${newNode.toLine()}`);
      }
      // plain text note
      else if ('text' === drop.type) {
        // right edge of node: create new child node with note
        if ('drop-target-right' === drop.targetClass) {
          let label, note;
          if (drop.text.includes('\n')) {
            const lines = drop.text.split('\n');
            label = lines[0];
            note = lines.slice(1).join('\n');
          }
          else label = drop.text;
          let newNode = await drop.destParent.addChild(drop.destIndex,
            { label: label, note: note, render: true },
            { reason: 'userAction' });
          return finish(`Added node: ${newNode.toLine()}`);
        }
        // single line: use as label, if label is empty
        if (! drop.text.includes('\n')) {
          if (! drop.targetNode.label) {
            await drop.targetNode.setNotes(
              drop.text, drop.targetNode.note,
              { reason: 'userAction' });
            return finish(`Added label to ${drop.targetNode.toLine()}`);
          }
        }
        // multiple lines or fall-through: add to note
        if (true) {
          let note = drop.targetNode.note;
          if (! note) note = '';
          let sep, newNote;
          const mode = this.dropTextNoteMode || 'prepend';
          if ('append' === mode) {
            sep = ((!note) || note.endsWith('\n')) ? '' : '\n';
            newNote = note + sep + drop.text;
          }
          else {
            sep = ((!note) || drop.text.endsWith('\n')) ? '' : '\n';
            newNote = drop.text + sep + note;
          }
          await drop.targetNode.setNotes(
            drop.targetNode.label, newNote,
            { reason: 'userAction' });
          return finish(`Added note to ${drop.targetNode.toLine()}`);
        }
      }
    }
    // clean up, just in case
    // (because 'dragend' event doesn't trigger sometimes)
    finish('drop cleanup');
  }

  async action_wrapNodeInWindow (event) {
    const node = this.whichCursor(event);
    if (! node || node.isRoot()) return;
    // Replaying this toggle could immediately undo the completed conversion.
    const result = await emit(
      'bkgd_wrapNodeInWindow',
      { nodeId: node.id },
      { retry: false }
    );
    if (result && result.error) {
      warn('wrapNodeInWindow error', result.error);
      return;
    }
    if (result && result.result) {
      this.setStatus(`window: ${result.result}`);
    }
    if (result && result.newLabelId) {
      const labelNode = this.nodes[result.newLabelId];
      if (labelNode) await this.setCursor(labelNode);
    }
  }

  action_mouseDragEnd (event) {
    // fix how the node looks
    if (this.mouseDragStartNode)
      this.mouseDragStartNode.$.classList.remove('dragging');
    // clear data
    this.mouseDragStartNode = undefined;
    this.clearDropTargetNodeStyles();
    // allow hoverMenu to be displayed again
    this.dragInProgress = false;
    // stop any scrolling in progress
    this.dragScrollSpeed = 0;
    this.actualScrollSpeed = 0;
  }

  action_mouseDragLeave (event) {
    //debug('action_mouseDragLeave()', event);
    this.clearDropTargetNodeStyles();
  }

  $renderHoverMenu () {
    if (! this.$hoverMenu) return;

    const doc = this.document;

    function makeBtn (_this, className, label, funcName) {
      const $div = doc.createElement('div');
      $div.classList.add(className);
      _this.setHoverMenuButtonLabel($div, funcName, label);
      $div['data-toggle'] = 'tooltip';
      // make the button do something when clicked
      const func = function (event) {
        _this.runUiAction(
          `Hover menu ${funcName}`,
          () => _this[`action_${funcName}`].bind(_this)(event)
        );
        _this.hideHoverMenu();  // will re-appear if still over a node
      }
      if (func) $div.addEventListener('click', func);
      //const func = _this[`action_${funcName}`];
      //if (func) $div.addEventListener('click', func.bind(_this));
      // add the button to the menu
      _this.$hoverMenu.append($div);
      return $div;
    }
    if (! this.$hoverMenuUnload) {
      this.$hoverMenuUnload = makeBtn(this, 'unload-button', 'U', 'unloadNode');
    }
    if (! this.$hoverMenuLoad) {
      this.$hoverMenuLoad = makeBtn(this, 'load-button', 'L', 'loadNode');
    }
    if (! this.$hoverMenuTask) {
      this.$hoverMenuTask = makeBtn(this, 'task-button', 'T', 'taskEdit');
    }
    if (! this.$hoverMenuEdit) {
      this.$hoverMenuEdit = makeBtn(this, 'edit-button', 'E', 'editNode');
    }
    if (! this.$hoverMenuMark) {
      this.$hoverMenuMark = makeBtn(this, 'mark-button', 'M', 'toggleMarked');
    }
    if (! this.$hoverMenuWindow) {
      this.$hoverMenuWindow = makeBtn(this, 'window-button', 'W', 'wrapNodeInWindow');
    }
    if (! this.$hoverMenuDelete) {
      this.$hoverMenuDelete = makeBtn(this, 'delete-button', 'D', 'deleteNode');
    }
    this.updateHoverMenuLabels();
  }

  hideHoverMenu () {
    //debug('hideHoverMenu');
    this.$hoverMenu.classList.add('hidden');
    this.hoverMenuLast = undefined;
  }

  showHoverMenu () {
    //debug(`showHoverMenu: ${this.mouseNode.toLine()}`);
    // skip if we're in the middle of a drag-n-drop
    if (this.dragInProgress || this.smoothScrollHideHoverMenu) return;
    // hover menu totally breaks $searchEntry, so don't allow it
    // (hover menu steals focus somehow, if mouse is over the TreeView)
    if (this.searchCaptureInput) return;
    // skip extra drawing if the menu hasn't changed
    if (this.hoverMenuLast === this.mouseNode) return;
    this.hoverMenuLast = this.mouseNode;
    const mouseNode = this.mouseNode;

    // adjust menu position
    const rect = this.$mouseRow.getBoundingClientRect();
    const zoomLevel = this.cfg.treeViewZoomLevel;
    let hTop = (rect.top + this.window.scrollY - (3 * zoomLevel))
      / zoomLevel;
    this.$hoverMenu.style.top = String(hTop) + 'px';

    // show or hide the 'unload' button
    if (mouseNode.isUnloadable() || mouseNode.hasLoadedTabs()) {
      this.$hoverMenuUnload.style.display = 'inline-block';
      this.$hoverMenuUnload.classList.remove('unloaded');
    }
    else if (mouseNode.isUnloadedTab()) {
      this.$hoverMenuUnload.style.display = 'inline-block';
      this.$hoverMenuUnload.classList.add('unloaded');
    }
    else this.$hoverMenuUnload.style.display = 'none';

    // show or hide the 'load' button
    const loadable = mouseNode.isBatchLoadable();
    if (loadable) {
      this.$hoverMenuLoad.style.display = 'inline-block';
      this.$hoverMenuLoad.classList.remove('loaded');
    }
    else this.$hoverMenuLoad.style.display = 'none';

    // show or hide the 'task' button
    if ((! mouseNode.hasCheckbox()) && (! mouseNode.isRoot()))
      this.$hoverMenuTask.style.display = 'inline-block';
    else this.$hoverMenuTask.style.display = 'none';

    // show or hide the 'mark' button
    if (mouseNode.isMarkable())
      this.$hoverMenuMark.style.display = 'inline-block';
    else this.$hoverMenuMark.style.display = 'none';
    // show or hide the 'window' button
    if (! this.mouseNode.isRoot())
      this.$hoverMenuWindow.style.display = 'inline-block';
    else this.$hoverMenuWindow.style.display = 'none';
    // show or hide the 'delete' button
    if (mouseNode.isDeletable())
      this.$hoverMenuDelete.style.display = 'inline-block';
    else this.$hoverMenuDelete.style.display = 'none';

    // show the menu
    this.$hoverMenu.classList.remove('hidden');
  }

  async setCursor (node, args) {
    // { instant: false, scrollDelay: 0, expand: false}) {
    //debug(`TreeView.setCursor(): ${node.toLine()}`);
    // ensure cursor is on a visible node in our view scope
    const viewRoot = this.viewRoot;
    if (! node) node = viewRoot;
    if (node
      && ((! node.isInViewScope()) || (! node.isVisible(viewRoot)))) {
      // If the requested node is hidden, use its nearest visible fallback.
      let visibleNode = node;
      if ((visibleNode !== viewRoot) && (! visibleNode.isVisible(viewRoot)))
        visibleNode = visibleNode.prevVisibleNode(viewRoot);
      node = visibleNode;
      //debug(`TreeView.setCursor(-->): ${node.toLine()}`);
    }

    // update the cursor position
    if (this.cursor && (node !== this.cursor)) this.cursor.removeCursor();
    if (node        && (node !== this.cursor)) node.addCursor();
    this.cursor = node;

    // details box
    if (node) {
      // show and update node detail box
      this.updateDetailsBox();

      // maybe wait a moment to let user finish a double click
      let scrollDuration = 200;  // TODO: load from this.scrollDurationDefault
      if (args?.scrollDelay) {
        scrollDuration = args.scrollDelay;
        await new Promise(r => setTimeout(r, args.scrollDelay));
      }

      // ensure node is visible
      if (args?.instant) scrollDuration = 0;
      this.scrollNodeIntoView(node, scrollDuration);
    }
    else {
      this.hideDetailsBox();
    }
  }

  async ensureCursorVisible () {
    if (this.isInert) return;
    const viewRoot = this.viewRoot;
    this.dragInProgress = false;
    //debug(`TreeView.ensureCursorVisible(cursor):`, this.cursor);
    //debug(`TreeView.ensureCursorVisible(viewRoot):`, viewRoot);

    // when cursor node is pasted into collapsed branch,
    // and branch is in the view scope,
    // move cursor to nearest visible parent
    const cursor = this.cursor;
    if (cursor?.isInViewScope() && (! cursor.isVisible(viewRoot))) {
      const newCursor = cursor.prevVisibleNode(viewRoot);
      if (newCursor) return await this.setCursor(newCursor, { instant: true });
    }

    // move the cursor to this window's active tab
    // (or its nearest visible parent within the view scope)
    // find our window
    let winNode = viewRoot;
    if ('session' === this.viewScope) {
      // find the current window in the tree
      const win = await api.windows.getCurrent();
      let found = viewRoot.findNodes((node) => {
        return (node.isWindow() && (win.id === node.windowId));
      });
      if (found.length > 0) winNode = found[0];
    }
    //winNode.scrollToTop();
    const activeTabNode = winNode.getActiveTab();
    //debug(`TreeView.ensureCursorVisible(activeTabNode):`, activeTabNode);

    // ensure cursor exists and is inside our view scope
    if ((! this.cursor)
      || (! this.cursor.isInViewScope())
      || (! this.cursor.isVisible(viewRoot))
    ) {
      //debug('TreeView.ensureCursorVisible(): no cursor or out of scope');
      // if active tab visible, put cursor on it
      // if active tab exists but is hidden, put cursor on visible parent
      // otherwise put cursor on window node
      let visibleNode = activeTabNode ? activeTabNode : viewRoot;
      if ((visibleNode !== viewRoot) && (! visibleNode.isVisible(viewRoot))) {
        if (this.cfg.activeTabExpandsItsParents) {
          await visibleNode.setActive(true, { localOverride: true });
        } else {
          visibleNode = visibleNode.prevVisibleNode(viewRoot);
        }
      }
      debug(`TreeView.ensureCursorVisible(visibleNode)`, visibleNode);
      return await this.setCursor(visibleNode, { instant: true });
    }
    return await this.setCursor(this.cursor, { instant: true });
  }

  scrollNodeIntoView (node, duration = 200) {
    if (! node?.$row) return;

    // ensure row is visible,
    // and has a sufficient margin
    // between the row and the edge of the tree view
    const $container = this.$;  // div#tree-view
    const rowRect = node.$row.getBoundingClientRect();
    const containerRect = $container.getBoundingClientRect();

    // zoom makes the values weird
    // (scroll goes to the wrong position without zoom compensation)
    const zoomLevel = this.cfg.treeViewZoomLevel;
    const rowTop = rowRect.top / zoomLevel;
    const rowBottom = rowRect.bottom / zoomLevel;
    const cTop = containerRect.top / zoomLevel;
    const cBottom = containerRect.bottom / zoomLevel;

    // TODO: make scroll margin configurable
    // percent of the view height
    const margin = Math.floor(0.25 * (cBottom - cTop));

    let newScrollTop = $container.scrollTop;

    // if row is above the visible area, scroll down
    if (rowTop < cTop + margin) {
      newScrollTop -= (cTop + margin - rowTop);
    }

    // if row is below the visible area, scroll up
    else if (rowBottom > cBottom - margin) {
      newScrollTop += (rowBottom - (cBottom - margin));
    }

    // bounds check
    const maxScrollTop = $container.scrollHeight - $container.clientHeight;
    newScrollTop = Math.max(0, Math.min(newScrollTop, maxScrollTop));

    // always stay scrolled all the way to the left
    $container.scrollLeft = 0;

    // instant
    if (duration < 1) $container.scrollTop = newScrollTop;
    // smooth
    // (helps reduce jitter from details box appearing and disappearing)
    else this.smoothScrollTo(newScrollTop, duration);
  }

  smoothScrollTo (scrollTop, duration = 200) {
    //debug(`TreeView.smoothScrollTo(${this.$.scrollTop} => ${scrollTop}, ${duration})`);
    // abort if nothing changed
    if (Math.round(scrollTop) === Math.round(this.$.scrollTop)) return;
    if (this.smoothScrollInProgress &&
      (Math.round(scrollTop) === Math.round(this.smoothScrollTop))) return;

    // adjust vertical scroll position gradually,
    // animating for "duration" ms
    this.smoothScrollStartTime = performance.now();
    this.smoothScrollDuration = duration;
    this.smoothScrollTop = scrollTop;

    // if we're not already scrolling, start a scroll animation
    // (otherwise, no need to start a *new* animation sequence)
    if (! this.smoothScrollInProgress) {
      this.smoothScrollInProgress = true;
      // no hover menu while scrolling, plz
      this.hideHoverMenu();
      requestAnimationFrame(this.smoothScrollStep.bind(this));
    }
  }

  smoothScrollStep (now) {
    function easeOutQuad (t) {
      return t * (2 - t);
    }

    // abort if tree is already scrolling for other reasons
    if (this.dragInProgress) return;

    // given "now" can be *before* smoothScrollStartTime on loaded systems
    // so take a fresh timestamp instead and make sure elapsed can never
    // be less than zero (which causes scrolling in the wrong direction)
    now = performance.now();
    const elapsed = Math.max(0, now - this.smoothScrollStartTime);
    const progress = Math.min(elapsed / this.smoothScrollDuration, 1);
    const eased = easeOutQuad(progress);

    const $container = this.$;
    const start = $container.scrollTop;
    const distance = this.smoothScrollTop - start;
    // last frame should land exactly on target
    if (progress >= 1) $container.scrollTop = this.smoothScrollTop;
    else $container.scrollTop = start + (distance * eased);

    if (progress < 1) {
      this.smoothScrollInProgress = true;
      this.smoothScrollHideHoverMenu = true;
      if (this.scrollCompleteTimer) clearTimeout(this.scrollCompleteTimer);
      requestAnimationFrame(this.smoothScrollStep.bind(this));
    }
    else {
      //debug(`smoothScrollStep(): ${$container.scrollTop} => ${this.smoothScrollTop}`);
      this.smoothScrollInProgress = false;
      // allow the hover menu to appear again, after scrolling is done
      const scrollComplete = () => {
        this.smoothScrollHideHoverMenu = false;
      }
      if (this.scrollCompleteTimer) clearTimeout(this.scrollCompleteTimer);
      this.scrollCompleteTimer = setTimeout(
        scrollComplete, this.smoothScrollDuration);
    }
  }

  updateDetailsBox () {
    if (! this.cursor) return;
    // bugfix: preserve scroll position
    // (if scrollbar is touching the bottom, Chrome anchors it there
    //  and it can make the entire view position jump,
    //  but we want the top anchored instead)
    const scrollBefore = this.$.scrollTop;
    // only show details if its button is in a 'pressed' state
    this.cursor.$renderDetails(this.$detailsBox);
    // restore scroll position
    if (! this.smoothScrollInProgress) this.$.scrollTop = scrollBefore;
  }

  hideDetailsBox () {
    this.$detailsBox.classList.add('hidden');
  }

  initBkgdPort () {
    this.port = api.runtime.connect();
    //debug('port', this.port);
    this.port.onDisconnect.addListener(() => {
      this.runUiAction('Background reconnect', async () => {
        if (this.destroyed) return;
        debug("TreeView.port disconnected, reconnecting...");
        await new Promise(r => setTimeout(r, 100));
        if (this.destroyed) return;
        this.initBkgdPort();
        this.registerWithBkgd();
      });
    });
    // tell bkgd about us, after we've had a chance to load
    //setTimeout(() => { this.registerWithBkgd(); }, 1000);
  }

  initBkgdPing () {
    if (this.bkgdPing) clearInterval(this.bkgdPing);
    this.bkgdPing = setInterval(() => {
      this.runUiAction('Background ping', () => this.pingBkgd());
    }, 15 * 1000);
  }

  async pingBkgd () {
    // keep service worker alive
    // so it won't have to keep reloading the tree from persistent storage
    // also, update the bkgd on our ID and status
    const msg = this.registerWithBkgd(false);
    const before = Date.now();
    //const response = await api.runtime.sendMessage({ 'msg': 'bkgd_ping' });
    const response = await emit('bkgd_ping', msg);
    const after = Date.now();
    if (! response) { return warn('bkgd ping failed'); }
    const elapsed = after - before;
    const oneway = response - before;
    if (elapsed > 30)  // don't log fast pings, only slow pings
      debug(`view => bkgd ping: 0 -> ${oneway} ms -> ${elapsed} ms`);
  }

  registerWithBkgd (send = true) {
    const msg = {
      treeId: this.id,
      windowId: this.windowId,
      viewScope: this.viewScope,
      viewType: this.viewType,
    };
    // needs to send via Port.postMessage() instead of runtime.sendMessage()
    // because it needs Port.onDisconnect to detect when a TreeView closes
    // and this associates the TreeView.id with a port
    if (send) {
      this.runUiAction(
        'Background registration',
        () => emit('bkgdPort_registerTreeView', msg, { port: this.port })
      );
    }
    return msg;
  }

  async detectTabOrSidepanel () {
    const tab = await api.tabs.getCurrent();
    // no tab = sidepanel, in every browser I'm aware of
    if (! tab) this.viewType = 'sidepanel';
    else {
      // Firefox, and most Chrome browsers: tab = running in a tab
      // Vivaldi: sidepanel is also a tab (but not listed in its own window)
      const realTabs = await api.tabs.query({ windowId: tab.windowId });
      const isRealTab = realTabs.some((t) => (t.id === tab.id));
      this.viewType = isRealTab ? 'tab' : 'sidepanel';
    }
    log(`running in ${this.viewType} mode`);
  }

  initButtonHandlers () {
    const handleClick = (element, context, action) => {
      element.addEventListener('click', (event) => {
        this.runUiAction(context, () => action(event));
      });
    };
    // when view-scope-btn clicked, toggle session vs window view mode
    handleClick(
      this.$viewScopeBtn,
      'View scope change',
      () => this.onViewScopeBtnClick()
    );
    // open a tree view in a new tab
    handleClick(
      this.$treeViewInTabBtn,
      'Open tree view',
      () => this.onTreeViewInTabBtnClick()
    );
    // zoom in and out
    handleClick(this.$zoomOutBtn, 'Zoom update', () => this.onZoomBtn(-1));
    handleClick(this.$zoomInBtn, 'Zoom update', () => this.onZoomBtn(1));
    // when details-btn clicked, toggle the details box
    handleClick(
      this.$detailsBtn,
      'Details update',
      () => this.onDetailsBtnClick()
    );
    // save a session backup when clicked
    handleClick(
      this.$backupBtn,
      'Backup',
      () => this.onBackupBtnClick()
    );
    // open the options page
    handleClick(
      this.$optionsBtn,
      'Open options',
      () => this.onOptionsBtnClick()
    );
    // help me survive
    handleClick(
      this.$donateBtn,
      'Open donation page',
      () => this.onDonateBtnClick()
    );
    // open the user manual
    handleClick(
      this.$helpBtn,
      'Open help',
      () => this.onHelpBtnClick()
    );
    // "marked count" widget
    this.$markedCount.addEventListener('mouseover', () => {
      this.onMarkedCountHover();
    });
    handleClick(
      this.$markedCount,
      'Marked-node action',
      (event) => this.onMarkedCountClick(event)
    );
  }

  async onViewScopeBtnClick () {
    if ('session' === this.viewScope) this.viewScope = 'window';
    else this.viewScope = 'session';
    // save button state to config storage, per window
    await this.setWindowConfig('viewScope', this.viewScope);
    // update the display
    this.$renderViewScopeBtn();
    this.$renderWholeTree();
    await this.ensureCursorVisible();
    this.setStatus(`View scope: ${this.viewScope}`);
    // tell bkgd we changed viewScope
    this.registerWithBkgd();
  }

  $renderViewScopeBtn () {
    if (! this.$viewScopeBtn) return;
    // Capitalize word and place it inside the button
    const label = this.viewScope.charAt(0).toUpperCase()
      + this.viewScope.slice(1);
    this.$viewScopeBtn.innerText = label;
  }

  action_detailsButton (event) {
    // hotkey version of the "details" button
    return this.onDetailsBtnClick();
  }

  async onDetailsBtnClick () {
    // it's a 3-state button: off, short, full (none, notes, details)
    this.detailsState = (this.detailsState + 1) % 3;
    this.$renderDetailsBtn();
    // save button state to config storage
    await this.setWindowConfig('detailsState', this.detailsState);
  }

  $renderDetailsBtn () {
    if (! this.$detailsBtn) return;

    switch (this.detailsState) {
      // 0 = off / none
      case 0:
        this.$detailsBtn.classList.remove('pressed');
        //this.$detailsBtn.classList.remove('half-pressed');
        this.$detailsBtn.innerText = 'Details';
        this.hideDetailsBox();
        break;
      // 1 = short / notes only
      case 1:
        //this.$detailsBtn.classList.remove('pressed');
        //this.$detailsBtn.classList.add('half-pressed');
        this.$detailsBtn.classList.add('pressed');
        this.$detailsBtn.innerText = 'Notes';
        this.updateDetailsBox();
        if (this.cursor) this.scrollNodeIntoView(this.cursor);
        break;
      // 2 = full / all details
      case 2:
      default:
        this.$detailsBtn.classList.add('pressed');
        //this.$detailsBtn.classList.remove('half-pressed');
        this.$detailsBtn.innerText = 'Details';
        this.updateDetailsBox();
        if (this.cursor) this.scrollNodeIntoView(this.cursor);
        break;
    }
  }

  async openLinkInNewTab (url, internal=true) {
    const createProperties = {};
    if (internal)
      createProperties.url = api.runtime.getURL(url);
    else
      createProperties.url = url;
    // if we're in Tabs Outliner mode, open in cursor's window
    // otherwise open in our own window
    let windowId;
    if ('session' === this.viewScope) {
      const winNode = this.cursor?.getWindowNode();
      if (winNode) windowId = winNode.windowId;
    }
    if (! windowId) {
      const win = await api.windows.getCurrent({ populate: false });
      windowId = win.id;
    }
    const [tab] = await api.tabs.query({ active: true, windowId });
    debug(`openLinkInNewTab() parent tab:`, tab);
    const targetWindowId = tab?.windowId || windowId;
    if (targetWindowId) createProperties.windowId = targetWindowId;
    // Chrome can't open internal pages in incognito windows
    if (tab) {
      if (internal && isChrome && tab.incognito) { }
      else createProperties.openerTabId = tab.id;
    }
    return await api.tabs.create(createProperties);
  }

  openInternalPage (url) {
    return this.openLinkInNewTab(url, true).catch((err) => {
      error(`Could not open internal page "${url}"`, err);
      this.setStatus(`Could not open ${url}`);
      return null;
    });
  }

  openExternalPage (url) {
    return this.openLinkInNewTab(url, false).catch((err) => {
      error(`Could not open external page "${url}"`, err);
      this.setStatus(`Could not open ${url}`);
      return null;
    });
  }

  onTreeViewInTabBtnClick () {
    return this.openInternalPage('/view/sidepanel.html');
  }

  async onZoomBtn (direction) {
    const zoomStepSize = Math.pow(2, 1.0 / this.zoomSteps);

    // adjust the zoom
    let newzoom = this.cfg.treeViewZoomLevel;
    if (direction > 0) newzoom *= zoomStepSize;
    else if (direction < 0) newzoom /= zoomStepSize;
    else newzoom = 1;

    // round to nearest clean ratio if it's close
    function snapToRatio(value, tolerance = 0.01) {
      const ratios = [1/4, 1/2, 1, 2, 4];
      for (const r of ratios) {
        const diff = Math.abs(value - r) / r;  // relative difference
        if (diff <= tolerance) {
          return r;  // snap to the clean ratio
        }
      }
      return value; // leave unchanged
    }

    // clean up the value
    newzoom = snapToRatio(newzoom);

    // ... and set it
    await this.cfg.set('treeViewZoomLevel', newzoom);
    //this.setZoomLevel(newzoom);
  }

  async setZoomLevel (zoomLevel, oldZoomLevel) {
    zoomLevel = Math.min(Math.max(zoomLevel, this.zoomMin), this.zoomMax);

    // update the view
    this.document.documentElement.style.setProperty('--zoom-level', zoomLevel);
    this.zoomLevel = zoomLevel;

    if (! this.isInert) {
      if (zoomLevel !== oldZoomLevel) {
        this.setStatus(`Zoom: ${(100 * this.zoomLevel).toFixed(2)}%`);
      }
    }

    // grey out or activate zoom buttons if maxed out
    if (this.$zoomInBtn) {
      const grey = 'greyed-out';
      if (zoomLevel >= this.zoomMax) this.$zoomInBtn.classList.add(grey);
      else this.$zoomInBtn.classList.remove(grey);
      if (zoomLevel <= this.zoomMin) this.$zoomOutBtn.classList.add(grey);
      else this.$zoomOutBtn.classList.remove(grey);
    }
  }

  onBackupBtnClick () {
    return this.action_backupSession();
  }

  onOptionsBtnClick () {
    return this.openInternalPage('/options/options.html');
  }

  onDonateBtnClick () {
    // redirects to the correct page,
    // handy if I need to change platforms
    return this.openExternalPage('https://toykeeper.net/tktsto/donate');
  }

  onHelpBtnClick () {
    return this.openInternalPage('/docs/index.html');
  }

  tree_nodeAdded (msg, sender, sendResponse) {
    msg.node.render = true;
    return super.tree_nodeAdded(msg, sender, sendResponse);
  }

  tree_refreshAll (msg, sender, sendResponse) {
    // Re-render the entire tree (used after batch updates like favicon backfill)
    try {
      debug('TreeView.tree_refreshAll()');
      if (! this.viewRoot || ! this.$treeRoot) {
        debug('TreeView.tree_refreshAll() skipped before initial render');
        return;
      }
      this.$renderWholeTree();
    } catch (err) {
      error('TreeView.tree_refreshAll() failed', err, msg);
      throw err;
    }
  }

  async onMessage (msg, sender, sendResponse) {
    // if message not for us, let parent class handle it
    try {
      if (!(msg && msg.msg && msg.msg.startsWith('treeview_')))
        return await super.onMessage(msg, sender, sendResponse);

      debug(`TreeView.onMessage(${msg.msg})`, this.windowId);

      // ignore messages for other windows unless broadcast
      if (msg.windowId && (msg.windowId !== this.windowId)) return;

      debug(`TreeView.onMessage(${msg.msg})`, msg);
      if ('treeview_onCommand' === msg.msg) {
        // don't do any of this when a dialog box exists
        if (this.dialogActive) return;
        // turn this off in case it's still visible
        this.hideHoverMenu();
        // find the matching 'action_doStuff' function
        const actionName = `action_${msg.action}`;
        const handler = this[actionName];
        if ('function' !== typeof handler) {
          return this.setStatus(`handler not found: ${msg.action}`);
        }
        // actually handle the event, but only one at a time
        const unlock = await this.keyEventMutex.lock();
        try {
          this.setStatus(`key: ${msg.action}`);
          // event type tells handlers to use keyboard cursor, not mouse
          await handler.bind(this)({ type: 'command', ...msg });
        }
        finally { unlock(); }
        return;
      }
      if ('treeview_status' === msg.msg) {
        const status = msg.status || '';
        if (status) this.setStatus(status);
        return;
      }
    } catch (err) {
      error(`TreeView.onMessage(${msg && msg.msg ? msg.msg : 'unknown'}) failed`, err, msg);
      throw err;
    }
  }

}
