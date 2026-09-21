// view/nodeview.js: NodeView class
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';

import { debug, error, fmtDate } from '/common/common.js';
import { Node } from '/common/node.js';
import { isContainerTab } from '/common/containers.js';

const contextColors = new Set([
  'blue', 'turquoise', 'cyan', 'green', 'yellow', 'orange', 'red',
  'pink', 'purple', 'violet', 'gray', 'toolbar'
]);
// Local, fixed SVG paths. Browser/backup icon strings can select a known
// symbol, but can never become markup, a stylesheet, or an external URL.
const contextIcons = {
  briefcase: 'M2 5h12v8H2z M6 5V3h4v2 M5 5v8 M11 5v8',
  fingerprint: 'M3 9V7a5 5 0 0 1 10 0v2 M5 12V7a3 3 0 0 1 6 0v3 M7 14V7a1 1 0 0 1 2 0v5 M3 11v1 M11 12v1',
  dollar: 'M11 4H7a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H5 M8 2v12',
  cart: 'M2 3h2l2 7h6l2-5H5 M7 13h.1 M12 13h.1',
  circle: 'M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  gift: 'M2 6h12v3H2z M3 9v5h10V9 M8 5v9 M8 6C1-1 2 7 8 6 M8 6c7-7 6 1 0 0',
  vacation: 'M8 14V4 M2 6q6-7 12 0 M4 8q4-6 8 0 M5 14h6',
  food: 'M3 2v5h3V2 M4.5 7v7 M12 2v12 M12 2q-5 5 0 6',
  fruit: 'M8 5C0 1 1 14 6 13l2-1 2 1c5 1 6-12-2-8 M8 5q-1-4 3-3',
  pet: 'M4 11q4-7 8 0c2 5-2 1-4 2-2-1-6 3-4-2 M3 5h.1 M6 3h.1 M10 3h.1 M13 5h.1',
  tree: 'M8 2l-5 7h3l-3 3h10l-3-3h3z M8 12v3',
  chill: 'M2 5h12 M4 5v8h8V5 M5 9h6 M6 2v1 M10 2v1',
  fence: 'M2 7h12 M2 11h12 M4 14V3l1-1 1 1v11 M10 14V3l1-1 1 1v11',
  group: 'M2 5h12v9H2z M4 2h8 M3 3.5h10'
};

function contextIcon(document, name, framed = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', framed ? '-4 -1 24 18' : '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('context-icon');
  if (framed) {
    // Paint the frame and glyph in one coordinate system. A CSS border can
    // snap independently of the fractional SVG position at small sidebar
    // sizes, making an otherwise centered icon appear to shift left/right.
    // Frame and viewBox share center (8, 8); allow for the 1.4-unit stroke.
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frame.classList.add('container-icon-frame');
    for (const [key, value] of Object.entries({
      x: -3.3, y: -0.3, width: 22.6, height: 16.6, rx: 3.3
    })) frame.setAttribute(key, value);
    svg.append(frame);
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', Object.hasOwn(contextIcons, name) ? contextIcons[name] : contextIcons.circle);
  svg.append(path);
  return svg;
}


export class NodeView extends Node {

  // TODO: maybe rename 'window' to avoid conflict with global?
  constructor (tree, parent, window) {
    super(tree, parent);

    this.window = (undefined !== window) ? window : tree.window;
    // DOM objects
    this.$ = null;  // outermost element is a <li>
    this.$row = null;  // <div> for label, title+url, favicon, etc
    this.$nodes = null;  // <ul>
  }

  $render () {
    //debug('NodeView.$render');
    if (!this.tree.document) return;
    const doc = this.tree.document;

    //debug('Node.$render $');
    // create outermost node element
    if (! this.$) this.$ = doc.createElement('li');
    this.$.id = `node${this.id}`;
    this.$.classList.add('node');
    if (this.hasKids()) {
      if (this.isExpanded()) {
        this.$.classList.add('expanded');
        this.$.classList.remove('collapsed', 'leaf');
      } else {
        this.$.classList.add('collapsed');
        this.$.classList.remove('expanded', 'leaf');
      }
    }
    else {
      this.$.classList.add('leaf');
      this.$.classList.remove('expanded', 'collapsed');
    }

    //debug('Node.$render $row');
    // container for node title and details
    if (!this.$row) this.$row = doc.createElement('div');
    this.$renderTitle();
    if (! this.$.contains(this.$row)) this.$.append(this.$row);

    // container for node children
    //debug('Node.$render $nodes');
    if (! this.$nodes) this.$nodes = doc.createElement('ul');
    if (! this.$.contains(this.$nodes)) this.$.append(this.$nodes);
    this.$nodes.classList.add('nodes');
    if (this.isCollapsed()) {
      this.$nodes.classList.add('hidden');
    } else {
      this.$nodes.classList.remove('hidden');
    }

    // are we marked?
    if (this.marked) {
      this.$.classList.add('marked');
      this.$row.classList.add('marked');
    }
    else {
      this.$.classList.remove('marked');
      this.$row.classList.remove('marked');
    }

    // are we a window?
    if (this.isWindow()) {
      this.$.classList.add('window');
      this.$row.classList.add('window');
    }
    else {
      this.$.classList.remove('window');
      this.$row.classList.remove('window');
    }

    // if the details box is showing this node, update it
    if (this.isCursor()) {
      this.$renderDetails(this.tree.$detailsBox);
    }

    if (this.nodeClasses) {  // doc page style overrides
      this.$.classList.add(...this.nodeClasses);
    }

    // maybe add a mouse cursor (for documentation pages)
    if (undefined !== this.pointer) {
      this.tree.$pointer = doc.createElement('img');
      const $pointer = this.tree.$pointer;
      $pointer.classList.add('pointer');
      if (this.pointerImg)
        $pointer.src = api.runtime.getURL(`/img/${this.pointerImg}`);
      else $pointer.src = api.runtime.getURL('/img/pointer.svg');
      $pointer.style.left = `${this.pointer*100}%`;
      $pointer.style.top = '33%';
      $pointer.style.display = 'block';
      if (this.pointerOpacity) $pointer.style.opacity = this.pointerOpacity;
      if (! this.pointerSize) this.pointerSize = 1.0;
      $pointer.style.width = $pointer.style.height = `${this.pointerSize * 3}rem`;
      this.$row.style.position = 'relative';
      this.$row.style.overflow = 'visible';
      this.$row.appendChild($pointer);
    }

    // add to parent (nope, nevermind, let the parent do that on its own)
    // needs a way to specify where to insert the new node
    //if (!this.parent) return;
    //if (!this.parent.$nodes) return;
    //debug('Node.$render parent');
    //this.parent.$nodes.append(this.$);
  }

  $destroy () {
    //debug('NodeView.$destroy');
    if (this.$) {
      //debug('remove');
      this.$.remove();
    }
  }

  $syncActiveStateClasses () {
    if (! this.$row) return;
    if (this.loaded) this.$row.classList.add('loaded');
    else this.$row.classList.remove('loaded');
    if (this.active) this.$row.classList.add('active');
    else this.$row.classList.remove('active');
  }

  $renderTitle () {
    // Build DOM safely without innerHTML
    const doc = this.tree.document;
    this.$row.textContent = '';  // start empty

    const cfg = this.tree.cfg;

    // reset classes
    //this.$row.className = 'row';
    this.$row.classList.add('row');
    // copy classes from outer element
    //this.$row.classList.add(...this.$.classList);
    for (const label of ['leaf', 'expanded', 'collapsed']) {
      if (this.$.classList.contains(label))
        this.$row.classList.add(label);
      else
        this.$row.classList.remove(label);
    }
    // is the link loaded, or the window's current active tab?
    this.$syncActiveStateClasses();
    if (this.wasLoaded) this.$row.classList.add('was-loaded');
    else this.$row.classList.remove('was-loaded');
    // are any kids loaded?
    if (this.hasLoadedTabs()) this.$row.classList.add('loaded-children');
    else this.$row.classList.remove('loaded-children');
    // is the tab partially unloaded?
    if (this.discarded) this.$row.classList.add('discarded');
    else this.$row.classList.remove('discarded');
    if (this.frozen) this.$row.classList.add('frozen');
    else this.$row.classList.remove('frozen');
    if (this.hidden) this.$row.classList.add('tab-hidden');
    else this.$row.classList.remove('tab-hidden');
    // incognito
    if (this.isIncognito()) this.$row.classList.add('incognito');
    else this.$row.classList.remove('incognito');

    // title row text
    // full row: [3/14] [X] @ Label Text ~ <a href="link">Link Title</a>
    // ... where "[3/14]" is num children open/total, "[X]" is a checkbox,
    // and "@" is a favicon
    let urlTitle = this.title ? this.title : this.url;  // handle blank title
    const namedContainer = Boolean(this.cookieStoreId && isContainerTab(this));
    this.$row.classList.toggle('container-tab', namedContainer);
    this.$row.classList.toggle('container-missing', namedContainer && Boolean(this.containerMissing));
    this.$row.classList.toggle('native-group', this.nativeGroup === true);
    this.$row.classList.toggle('restore-error', Boolean(this.restoreError));
    for (const color of contextColors) this.$row.classList.remove(`context-color-${color}`);
    const requestedColor = this.nativeGroup ? this.groupColor : this.containerColor;
    if (namedContainer || this.nativeGroup) {
      const color = contextColors.has(requestedColor) ? requestedColor : 'gray';
      this.$row.classList.add(`context-color-${color}`);
    }
    // Clear obsolete tooltips as well as old badges on subsequent renders.
    this.$row.removeAttribute('title');
    if (this.restoreError) this.$row.title = this.restoreError;

    // node stats
    // unsure if always include stats or only when collapsed
    //if (this.hasKids()) {  // always
    if (this.hasKids()
      && (this.isCollapsed() || cfg.alwaysShowNodeStats)
    ) {  // only when collapsed or user config forces it
      const nodeStats = [];  // Array<[Number, String]>
      const totalChildren = this.countNodes();
      //  count all open descendants
      const openChildren = this.countNodes(
        function (node) { return node.isLoaded(); }
      );
      nodeStats.push([openChildren, 'open']);
      const $nodeStats = doc.createElement('span');
      // count pink tabs, maybe
      if (cfg.wasLoadedNodeStats) {
        const wasLoadedChildren = this.countNodes(
          (n) => n.isWasLoadedTab(),
          (n) => (! n.isWindow()),
        );
        nodeStats.push([wasLoadedChildren, 'was-loaded']);
      }
      nodeStats.push([totalChildren, 'total']);

      $nodeStats.className = 'node-stats';
      $nodeStats.append('[');
      let segments = 0;
      for (const [num, type] of nodeStats) {
        if (num > 0) {
          segments ++;
          const $span = doc.createElement('span');
          $span.className = `node-stat-${type}`;
          $span.textContent = num;
          if ((2 == segments) && ('was-loaded' === type)) $nodeStats.append('+');
          else if (segments > 1) $nodeStats.append('/');
          $nodeStats.append($span);
        }
      }
      $nodeStats.append('] ');
      this.$row.append($nodeStats);
    }

    // pinned tabs and stuff
    let pinnedState;
    if (this.isPinnedBranch() && this.hasLoadedTabs()) {
      // "Pinned" parent label (with loaded tabs, so it's locked in place)
      pinnedState = { row: ['pinned', 'pinned-branch'],
        icon: 'pinned-branch-anchored' };
    } else if (this.isPinnedBranch() && (! this.hasLoadedTabs())) {
      // "Pinned" parent label (without loaded tabs, so it's not locked)
      pinnedState = { row: ['pinned', 'pinned-branch'], icon: 'pinned-branch' };
    } else if (this.isPinned()) {
      // other pinned node
      pinnedState = { row: ['pinned'], icon: 'pinned' };
    }
    if (pinnedState) {
      this.$row.classList.add(...pinnedState.row);
      const $pinnedIcon = doc.createElement('span');
      $pinnedIcon.className = `icon ${pinnedState.icon}`;
      if (! this.isPinnedBranch()) {
        $pinnedIcon.classList.add('node-pin-icon');
        $pinnedIcon.title = 'Pinned tab';
        $pinnedIcon.setAttribute('aria-label', 'Pinned tab');
      }
      this.$row.append($pinnedIcon);
    } else {
      this.$row.classList.remove('pinned', 'pinned-branch');
    }

    // checkbox
    if (this.hasCheckbox()) {
      let cbType = this.getCheckboxType();
      let cbText = this.checkboxText();
      if (' ' === this.checkbox) cbText = '\u00A0';  // &nbsp;
      if (['percent', 'ratio'].includes(cbType)) {
        if (this.checkboxPx > 0.999) cbType = cbType + ' done';
        else if (this.checkboxPx > 0.499) cbType = cbType + ' half-done';
      }
      const $ckbox = doc.createElement('div');
      $ckbox.className = 'node-checkbox ' + cbType;
      $ckbox.textContent = cbText;
      this.$row.append($ckbox);
    }

    // bookmarks (locked saved tabs)
    if (this.isBookmark()) {
      this.$row.classList.add('bookmark');
      const $bookmarkIcon = doc.createElement('span');
      $bookmarkIcon.className = 'icon bookmark';
      this.$row.append($bookmarkIcon);
    } else {
      this.$row.classList.remove('bookmark');
    }

    // favicon
    if (this.faviconUrl) {
      const $favicon = doc.createElement('img');
      $favicon.className = 'favicon';
      $favicon.src = this.faviconUrl;
      $favicon.alt = '';
      $favicon.onerror = function() { this.style.display = 'none'; };
      this.$row.append($favicon);
    }

    // Keep repeated container names out of the row; the icon's tooltip and
    // accessible name retain the complete identity for live and saved tabs.
    if (namedContainer) {
      const badge = doc.createElement('span');
      badge.className = 'container-badge';
      const name = this.containerName || this.cookieStoreId;
      const missing = this.containerMissing ? ' — unavailable; restore will not switch accounts' : '';
      badge.title = `Container: ${name} (${this.cookieStoreId})${missing}`;
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', badge.title);
      badge.append(contextIcon(doc, this.containerIcon, true));
      if (this.containerMissing) {
        const warning = doc.createElement('span');
        warning.className = 'context-warning';
        warning.textContent = '!';
        badge.append(warning);
      }
      this.$row.append(badge);
    }
    if (this.nativeGroup) {
      const badge = doc.createElement('span');
      badge.className = 'native-group-badge';
      const live = Number.isInteger(this.groupId) && this.groupId >= 0;
      badge.title = `Native tab group: ${this.label || 'Tab group'} — ${live ? 'open' : 'saved'}, ${this.groupCollapsed ? 'collapsed' : 'expanded'}`;
      badge.setAttribute('aria-label', badge.title);
      badge.append(contextIcon(doc, 'group'));
      this.$row.append(badge);
    }
    if (this.restoreError) {
      const warning = doc.createElement('span');
      warning.className = 'restore-error-icon';
      warning.textContent = '⚠';
      warning.title = this.restoreError;
      warning.setAttribute('aria-label', this.restoreError);
      this.$row.append(warning);
    }

    // Indicate when there's a long note attached.
    if (this.note) {
      const $noteIcon = doc.createElement('span');
      $noteIcon.className = 'node-note-icon';
      $noteIcon.textContent = '📎 ';
      this.$row.append($noteIcon);
    }

    // title (build DOM elements for label/url/etc)
    const $title = doc.createElement('span');
    $title.className = 'row-title';

    if (this.label) {
      if (this.url) {  // label ~ href
        const $a = doc.createElement('a');
        $a.className = 'node-link';
        $a.draggable = false;
        $a.href = this.url;
        const $labelSpan = doc.createElement('span');
        $labelSpan.className = 'node-label';
        $labelSpan.textContent = this.label;
        const $sep = doc.createElement('span');
        $sep.className = 'node-label-url-sep';
        const $urlSpan = doc.createElement('span');
        $urlSpan.className = 'url-title';
        $urlSpan.textContent = urlTitle;
        $a.append($labelSpan, $sep, $urlSpan);
        $title.append($a);
      }
      else {  // label only
        // dividers
        if (! this.nativeGroup && ['-', '='].includes(this.label)) {
          const $hr = doc.createElement('hr');
          $hr.className = 'node-divider1';
          if ('=' === this.label) $hr.className = 'node-divider2';
          $title.append($hr);
        } else {  // normal label
          const $labelSpan = doc.createElement('span');
          $labelSpan.className = 'node-label';
          $labelSpan.textContent = this.label;
          $title.append($labelSpan);
        }
      }
    }
    else if (this.url) {  // href only
      const $a = doc.createElement('a');
      $a.className = 'node-link';
      $a.draggable = false;
      $a.href = this.url;
      const $urlSpan = doc.createElement('span');
      $urlSpan.className = 'url-title';
      $urlSpan.textContent = urlTitle;
      $a.append($urlSpan);
      $title.append($a);
    }
    else {  // totally blank
      const $noTitle = doc.createElement('span');
      $noTitle.className = 'node-notitle';
      if (this.isWindow()) {
        const windowIdMaybe = this.windowId ? ' ' + this.windowId : '';
        $noTitle.textContent = 'Window' + windowIdMaybe;
      }
      else if (this.isRoot())
        $noTitle.textContent = 'Session';
      else
        $noTitle.textContent = 'node ' + this.id;
      $title.append($noTitle);
    }
    if (this.isWindow() && (! this.isLoaded())) {  // note closed windows
      $title.append(' (closed)');
    }
    if (this.isWindow() && this.isIncognito()) {
      $title.append(' (private)');
    }
    if (this.nativeGroup && !(Number.isInteger(this.groupId) && this.groupId >= 0)) {
      const saved = doc.createElement('span');
      saved.className = 'group-saved-state';
      saved.textContent = ' (saved group)';
      $title.append(saved);
    }
    this.$row.append($title);

    // let user drag-n-drop rows to reorganize the tree
    this.$row.setAttribute('draggable', true);

    if (this.rowClasses) {  // doc page style overrides
      this.$row.classList.add(...this.rowClasses);
    }

  }

  $renderDetails ($detailsBox) {
    if (! $detailsBox) return;
    if (! this.tree.document) return;
    const doc = this.tree.document;
    const mode = this.tree.detailsState;

    let hasContent = false;  // true if *anything* goes into the box

    // set the box mode in the view
    $detailsBox.classList.remove('hidden');
    if (0 === mode) {
      $detailsBox.classList.add('hidden');
      $detailsBox.classList.remove('notes-only');
      $detailsBox.classList.remove('all-details');
    } else if (1 === mode) {
      $detailsBox.classList.remove('all-details');
      $detailsBox.classList.add('notes-only');
    } else {
      $detailsBox.classList.remove('notes-only');
      $detailsBox.classList.add('all-details');
    }

    // load or create each element
    function getOrCreate(id, elem, $parent) {
      let $elem = doc.getElementById(id);
      if (! $elem) {
        $elem = doc.createElement(elem);
        $elem.id = id;
        if ($parent) $parent.append($elem);
        else $detailsBox.append($elem);
      }
      return $elem;
    }

    function hide ($elem) {
      $elem.textContent = '';
      $elem.classList.add('hidden');
    }

    function setOrHide ($elem, value, text) {
      if (value) {
        $elem.classList.remove('hidden');
        $elem.textContent = text || value;
        hasContent = true;
      } else {
        hide($elem);
      }
    }

    // Helper to create a labeled detail row: "<b>Label:</b>&nbsp;<span>value</span>"
    function setLabeledDetail ($elem, label, value) {
      if (value !== null && value !== undefined && value !== '') {
        $elem.classList.remove('hidden');
        $elem.textContent = '';  // clear
        const $b = doc.createElement('b');
        $b.textContent = label + ':';
        const $span = doc.createElement('span');
        $span.textContent = value;
        $elem.append($b, '\u00A0', $span);
        hasContent = true;
      } else {
        hide($elem);
      }
    }

    // label / short note
    let $label = getOrCreate('detail-label', 'div');
    setOrHide($label, this.label);

    // wasLoaded
    const wasLoaded = (!!this.wasLoaded) && (! this.loaded);
    let $wasLoaded = getOrCreate('detail-was-loaded', 'div');
    if (mode <= 1) hide($wasLoaded);
    else {
      if (wasLoaded) {
        $wasLoaded.classList.remove('hidden');
        $wasLoaded.textContent = '';
        const $b = doc.createElement('b');
        $b.textContent = 'Was Loaded';
        $wasLoaded.append($b);
        hasContent = true;
      } else {
        hide($wasLoaded);
      }
    }

    // long note
    let $note = getOrCreate('detail-note', 'div');
    setOrHide($note, this.note);

    const $restoreError = getOrCreate('detail-restore-error', 'div');
    $restoreError.setAttribute('role', 'status');
    setLabeledDetail($restoreError, 'Restore blocked', this.restoreError);
    const $container = getOrCreate('detail-container', 'div');
    const $group = getOrCreate('detail-native-group', 'div');
    if (mode <= 1) {
      hide($container);
      hide($group);
    } else {
      const named = this.cookieStoreId && isContainerTab(this);
      setLabeledDetail($container, 'Container', named
        ? `${this.containerName || this.cookieStoreId} (${this.cookieStoreId})${this.containerMissing ? ' — unavailable' : ''}` : undefined);
      setLabeledDetail($group, 'Native group', this.nativeGroup
        ? `${this.label || 'Tab group'} · ${this.groupColor || 'gray'} · ${this.groupCollapsed ? 'collapsed' : 'expanded'}` : undefined);
    }

    // link title
    let $title = getOrCreate('detail-title', 'div');
    if (mode <= 1) hide($title);
    else setLabeledDetail($title, 'Title', this.title);

    // link URL
    let $url = getOrCreate('detail-url', 'div');
    if (mode <= 1) hide($url);
    else setLabeledDetail($url, 'URL', this.url);

    // node ID
    let $nodeId = getOrCreate('detail-node-id', 'div');
    if (mode <= 1) hide($nodeId);
    else setLabeledDetail($nodeId, 'ID', this.id);

    // parent ID
    //let $parentId = getOrCreate('detail-parent-id', 'div');
    //if (mode <= 1) hide($parentId);
    //else setOrHide($parentId, this.parent.id, null,
    //  'Parent', `${this.parent.id}`);

    // tab ID
    let $tabId = getOrCreate('detail-node-tabid', 'div');
    if (mode <= 1) hide($tabId);
    else setLabeledDetail($tabId, 'Tab', this.tabId);

    // window ID
    let $windowId = getOrCreate('detail-node-windowid', 'div');
    if (mode <= 1) hide($windowId);
    else setOrHide($windowId, this.windowId, null, 'Window',
      `${this.windowId}`);

    // ctime, mtime, atime, ...
    for (const tName of ['ctime', 'mtime', 'atime']) {
      const $tstampDiv = getOrCreate(`detail-${tName}`, 'div');
      if (mode <= 1) { hide($tstampDiv); continue; }
      const dateText = fmtDate(this[tName]);
      // always show ctime, show others only if they're different
      const toShow = (tName === 'ctime') || (this[tName] !== this.ctime);
      if (toShow) {
        setLabeledDetail($tstampDiv, tName, dateText);
      } else {
        hide($tstampDiv);
      }
    }

    // hide if empty
    if (! hasContent) $detailsBox.classList.add('hidden');
  }

  $refreshAncestry () {
    // update displayed info for this node and all its parents
    this.$render();
    if (! this.isRoot()) this.parent.$refreshAncestry();
  }

  $renderChildren () {
    this.$render();
    if (! this.$nodes) return;

    const $children = this.tree.document.createDocumentFragment();
    // this.isExpanded() handles viewScope modes for us
    if (this.isExpanded()) {
      for (const node of this.nodes) {
        node.$renderChildren();
        if (node.$) $children.appendChild(node.$);
      }
    }
    this.$nodes.replaceChildren($children);
  }

  $destroyChildren () {
    if (this.$nodes) this.$nodes.classList.add('hidden');
    for (const node of this.nodes) {
      node.$destroy();
      // TODO: unsure if I need to recurse
    }
  }

  async renderIfChanged (promise, updateParents = false) {
    await this.tree.treeViewLoaded;
    // do it
    const changed = await promise;
    // show it
    if (changed) {
      this.$render();
      // update affected parents
      if (updateParents) this.$refreshAncestry();
    }
    return changed;
  }

  async deleteSelf (...extra) {
    await this.tree.treeViewLoaded;
    if (this.isRoot()) return;  // never delete root
    let newCursor;
    if (this.isCursor()) {
      const viewRoot = this.tree.viewRoot;
      // move to next row when possible
      newCursor = this.nextVisibleNodeNotMyChild(viewRoot);
      // move to prev row if cursor is already on the last row
      if (newCursor === this) newCursor = this.prevVisibleNode(viewRoot);
    }
    const oldParent = this.parent;
    const changed = await super.deleteSelf(...extra);
    if (! changed) return;

    this.$destroy();  // un-render
    // update parent node stats and decorations
    if (oldParent) oldParent.$refreshAncestry();
    // move the cursor to a new valid node if necessary
    if (newCursor) await this.tree.setCursor(newCursor);
    return changed;
  }

  async addChild (index, details, ...extra) {
    await this.tree.treeViewLoaded;
    //debug('NodeView.addChild():', details);
    // index is required; assume 1st child if not given
    if (undefined === index) index = 0;
    // save for later
    const prevNodeAtIndex = this.nodes[index];

    // must allocate ID before creating node and emitting notifications
    if (! details.id) { details.id = await this.tree.newNodeId(); }
    // create new Node object
    const newNode = await super.addChild(index, details, ...extra);
    //newNode.window = this.window;  // redundant?

    // display it
    if (details.render
      && this.isExpanded()
      && newNode.isChildOf(this.tree.viewRoot, true)
    ) {
      // ensure our elements exist before modifying them
      if (! this.$nodes) this.$render();

      //this.expandAndShow();
      this.$nodes.classList.remove('hidden');

      // show it
      newNode.$render();

      // attach new node in the correct location
      if (prevNodeAtIndex) {
        this.$nodes.insertBefore(newNode.$, prevNodeAtIndex.$);
      } else {
        this.$nodes.appendChild(newNode.$);
      }
    }
    if (details.render) {
      // refresh displayed info
      this.$refreshAncestry();
    }

    return newNode;
  }

  $insertChild (node, index) {
    // TODO: update displayed stats?
    // if moving to invisible spot, delete render
    if ((! this.isVisible()) || (this.isCollapsed())) {
      node.$destroy();
      this.$refreshAncestry();
      return;
    }
    // otherwise, render and insert child elements
    node.$render();
    // rare corner case: this.$nodes is null
    // when this gets called in a window while the window is closing
    if (! this.$nodes) this.$render();
    // show our node list
    this.$nodes.classList.remove('hidden');
    // attach new node in the correct location
    const prevElementAtIndex = this.$nodes.children[index];
    if (prevElementAtIndex) {
      this.$nodes.insertBefore(node.$, prevElementAtIndex);
    } else {
      this.$nodes.appendChild(node.$);
    }
    // refresh displayed info
    this.$refreshAncestry();
  }

  async setNotes (...args) {
    // if user edits "Pinned" branch, it needs to update kids too
    const wasPinned = this.isPinned();

    const changed = await this.renderIfChanged(super.setNotes(...args));

    // if pinned status changed, refresh this node and all children
    if (wasPinned !== this.isPinned()) this.$renderChildren();

    return changed;
  }

  async setCheckbox (...args) {
    return await this.renderIfChanged(super.setCheckbox(...args));
  }

  async applyCheckboxUpdates (changedNodes, args) {
    await this.tree.treeViewLoaded;
    for (const node of changedNodes) node.$render();
    return changedNodes.length > 0;
  }

  async setTabFields (...args) {
    return await this.renderIfChanged(super.setTabFields(...args), true);
  }

  async load (...args) {
    return await this.renderIfChanged(super.load(...args), true);
  }

  async unload (...args) {
    return await this.renderIfChanged(super.unload(...args), true);
  }

  scrollToTop () {
    if (this.$) this.$.scrollIntoView({
      behavior: "instant",  // smooth or instant
      block: "start",  // vertical scroll policy
      inline: "start"  // horizontal, left
    });
  }

  isCursor () {
    // TODO: or if classList contains 'cursor' ?
    return (this === this.tree.cursor);
  }

  addCursor () {
    if (! this.$row) return;
    this.$.classList.add('cursor');
    this.$row.classList.add('cursor');
  }

  removeCursor () {
    if (! this.$row) return;
    this.$.classList.remove('cursor');
    this.$row.classList.remove('cursor');
  }

  async moveTo (destParent, destIndex, ...extra) {
    await this.tree.treeViewLoaded;
    const viewRoot = this.tree.viewRoot;
    const viewScope = this.tree.viewScope;
    // save some info before moving...
    const oldParent = this.parent;
    let wasInViewScope = true;
    if ('window' === viewScope) wasInViewScope = this.isInViewScope();
    const wasPinned = this.isPinned();
    const destWasExpanded = destParent.isExpanded();
    const wasOverride = this.isExpandedOverride();
    const wasExpanded = this.isExpanded();
    const wasVisible = this.isVisible();

    // move it
    const changed = await super.moveTo(destParent, destIndex, ...extra);
    if (! changed) return false;

    destParent.$insertChild(this, destIndex);
    // refresh old parent if needed
    if (oldParent != destParent) oldParent.$refreshAncestry();

    let needsKidsRendered = false;
    // if pinned status changed, refresh this node and all children
    // (or if there are override shenanigans happening)
    if ((wasPinned !== this.isPinned()) || wasOverride)
      needsKidsRendered = true;

    if (((! wasVisible) || (! wasExpanded))
      && (this.isExpanded())
    ) needsKidsRendered = true;

    // if destination got expanded by this, re-render it
    if ((! destWasExpanded) && destParent.isExpanded())
      destParent.$renderChildren();

    // "this window only" mode needs extra care
    if ('window' === viewScope) {
      // if our window node was moved and we're a window-only view,
      // redraw the tree
      if (this === viewRoot) this.tree.$renderWholeTree();

      // if old parent outside current view and new parent in current view,
      // force render
      else if (this.isInViewScope() && (! wasInViewScope)) {
        debug(`NodeView.moveTo(): moved into viewScope`);
        needsKidsRendered = true;
      }
    }

    if (needsKidsRendered) this.$renderChildren();

    // update the #marked-count widget
    // (can change when nodes move into / out of marked nodes)
    this.tree.updateMarkedCount();

    // if has cursor and new position hidden,
    // move cursor to nearest visible parent
    // (this can happen when a collapsed parent is becoming its own child)
    // (when the user moved tabs via the tab bar)
    await this.tree.ensureCursorVisible();

    // ensure cursor is in the viewport
    if (this === this.tree.cursor) this.tree.scrollNodeIntoView(this);

    // report success
    return true;
  }

  isInViewScope () {
    // in Session mode, everything is in scope
    if ('window' !== this.tree.viewScope) return true;

    const viewRoot = this.tree.viewRoot;

    // our root is always visible, by definition
    if (this === viewRoot) return true;

    // all children of viewRoot are in view scope
    if (viewRoot.isParentOf(this)) return true;

    // otherwise not in scope
    return false;
  }

  isExpandedOverride () {
    // check if we're overridden
    for (const [ nodeId, node ]
      of Object.entries(this.tree.expandOverrides || {})
    ) {
      //if (this === node) return node;
      if (this.isParentOf(node)) return node;
    }
    return false;
  }

  isExpanded (allowOverrides = true) {
    if (allowOverrides && this.isExpandedOverride()) return true;

    // Session mode is simple, no viewRoot shenanigans needed
    if ('window' !== this.tree.viewScope) return this.expanded;
    // in "Window" view mode,
    // our viewRoot has its own local override, not saved to the DB
    if (this === this.tree.viewRoot) {
      // initial value is "expanded"
      if (undefined === this.viewRootExpanded) this.viewRootExpanded = true;
      return this.viewRootExpanded;
    }
    // all parents of the viewRoot are treated as "expanded"
    if (this.isParentOf(this.tree.viewRoot)) return true;
    // otherwise just tell the truth
    return this.expanded;
  }

  isCollapsed () {
    return (! this.isExpanded());
  }

  async setExpanded (expanded, args) {
    await this.tree.treeViewLoaded;
    let wasExpanded;
    let changed;
    const overrideNode = this.isExpandedOverride();

    // special case for view root in window mode
    // (because its expanded state is fake)
    if ( (this === this.tree.viewRoot)
      && ('window' === this.tree.viewScope)
    ) {
      if ('userAction' === args.reason) {
        // fake expanded state, this view only
        wasExpanded = this.isExpanded();
        this.viewRootExpanded = expanded;
        changed = (expanded !== wasExpanded);
      } else {
        // apply changes to keep tree in sync,
        // but otherwise pretend it didn't happen
        // (don't update the view)
        await super.setExpanded(expanded, args);
        changed = false;
      }
    }
    // local view-specific override, doesn't change the node
    else if (args.localOverride
      && (['userAction','override'].includes(args.reason))
    ) {
      // fake expanded state, this view only
      wasExpanded = this.expanded;
      //changed = (expanded !== wasExpanded);
      changed = true;  // always redraw
      //debug(`localOverride: ${wasExpanded} => ${expanded}`);
      // un-override it if we set it to the original state
      //if (expanded === wasExpanded)
      //  this.tree.expandOverride(this, null);
    }
    else if (overrideNode && ('userAction' === args.reason)) {
      // we are a parent of an override node, so...
      // un-override it, and override our own parent instead?
      debug(`parent of override: expand=${expanded}`, this, overrideNode);
      wasExpanded = this.isExpanded();
      if (overrideNode !== this) {
        await this.tree.expandOverride(this.parent, true);
      }
      await this.tree.expandOverride(overrideNode, null);
      changed = await super.setExpanded(expanded, args)
        || (expanded !== wasExpanded);
    }
    else {
      wasExpanded = this.isExpanded();
      // remove node from overrides
      if (overrideNode) await this.tree.expandOverride(overrideNode, null);

      changed = await super.setExpanded(expanded, args)
        || (expanded !== wasExpanded);
      //debug(`noOverride: ${wasExpanded} => ${expanded} => ${this.expanded}`);
    }

    // if no change, do nothing
    if (! changed) return;

    // only render stuff which is in scope
    if (this.isInViewScope()) {
      // if expanding, create subtree and hide stats
      if (expanded) {
        //debug(`expand`);
        this.$renderChildren();
        this.$render();
      }
      // if collapsing, delete subtree and show stats
      else {
        //debug(`collapse`);
        this.$destroyChildren();
        this.$render();
        // promote the cursor if we just hid it in a fold
        await this.tree.ensureCursorVisible();
      }
    }

    return changed;
  }

  async setMarked (...args) {
    const changed = await this.renderIfChanged(super.setMarked(...args));
    // update the #marked-count widget
    if (changed) this.tree.updateMarkedCount();
    return changed;
  }

  async setActive (active, args) {
    await this.tree.treeViewLoaded;
    const wasLoaded = this.loaded;
    let changed;
    debug(`NodeView.setActive(${active}): ${this.toLine()}`, this);
    if (args.localOverride) changed = true;
    else changed = await super.setActive(active, args);
    // abort on no-op
    if (! changed) return;

    // Normal tab switches only change row state.  Preserve the existing
    // title, stats, and favicon DOM instead of rebuilding the entire row.
    if (wasLoaded === this.loaded) {
      this.$syncActiveStateClasses();
    } else {
      // Activation can repair stale loaded state.  Refresh ancestor counts
      // and loaded-branch decorations in that uncommon case.
      this.$refreshAncestry();
    }

    // move the cursor maybe
    // if we're in window mode and the new active tab is in OUR window
    // or if we're in session mode and the new active tab isn't a TreeView
    // note: setActive() can be called on a window node too, not just a tab
    //       so we handle window focus changes here too
    if (this.tree.cfg.cursorFollowsActiveTab) {
      const myUrl = api.runtime.getURL('/view/sidepanel.html');
      const sessionMode = ('session' === this.tree.viewScope);
      let winNode;
      if ((! sessionMode) || (! this.isWindow())) {
        winNode = this.getWindowNode();
      } else {
        winNode = this;
        // active?  focus the current tab
        // deactivated?  un-override the active tab so parents can collapse
        // (unless new active tab is a TreeView)
        if (! active) {
          // check the active tab of the active window, if we can
          // ... and if it's a TreeView, don't remove our override
          const activeWinNode = this.tree.nodes[args.focusedNodeId];
          const activeTab = activeWinNode?.getActiveTab();
          if (activeTab?.url !== myUrl) {
            await this.tree.expandOverride(winNode.prevActiveTab, null);
            winNode = null;
          }
        }
      }

      const isOurWindow = (winNode?.windowId === this.tree.windowId);
      if (winNode && (sessionMode || isOurWindow)) {
        const activeTab = winNode.getActiveTab();
        // don't move cursor if we're focusing our own TreeView in Tab mode
        // (like, in standalone window mode)
        if (sessionMode && (myUrl === activeTab?.url)) {}
        else if (activeTab) {
          if (this.tree.cfg.activeTabExpandsItsParents) {
            // force expand new active tab
            await this.tree.expandOverride(activeTab, true);
            // un-override previous active tab
            if (activeTab !== winNode.prevActiveTab)
              await this.tree.expandOverride(winNode.prevActiveTab, null);
          }
          // wait for expansion changes to take effect before moving cursor
          // (otherwise scrolling is glitchy sometimes)
          setTimeout(() => {
            this.tree.setCursor(activeTab).catch((err) => {
              error('NodeView.setActive(): cursor update failed', err);
            });
          }, 1);
          winNode.prevActiveTab = activeTab;
        }
      }
    }
    if (this.isCursor()) {
      this.$renderDetails(this.tree.$detailsBox);
    }
    return changed;
  }

}  // end class NodeView
