# ChangeLog

What changed, and when?  You know the drill.


# 0.0.2 (2026-01-06)

Highlights:

- Added configurable keybindings, appearance settings (font/row/indent), and
  new behavior toggles (tab reorder, root-move window handling).
- Improved window/tab handling with window wrapping, mergeOpenWindows de-dup,
  refined window delete behavior, refocus option, and orphan reattach via fsck.
- Added favicon support with backfill and batch load/unload shortcuts.
- Hardened DOM rendering against XSS, added client ID sanitization hints, and
  expanded browser and Node-based test coverage (including V8 coverage output).
- Added tooling and packaging support (Firefox signing, versioning script,
  backup archive helper, json2md export tool).
- Updated manifests and README notes for supported versions and permissions.

# 0.0.1.0 (2025-05-19)

First public release.

This is alpha software.  To be safe, enable automatic backups!

The client (browser extension) mostly works, but the server hasn't even started
development yet.

# Supported/tested browsers include:

- Firefox 142
- Chromium 134
- Edge 136
- Vivaldi 7.3
- Brave 1.78
- Ungoogled Chromium 135
- Maxthon 7.5.2.3100

# Known issues:

- A bunch of functions and features are not implemented yet.

- Pinned tabs are not supported.

- Tab groups are not supported.

- Incognito windows are not yet tested.  It may work, but when you bring back
  a saved incognito window, it might not be incognito any more.

- Chromium-based browsers (except Vivaldi) do some weird stuff when tearing off
  a tab or branch to create a new window.  This may *sometimes* separate
  a parent tab from its children and move the children to the left edge of
  their tab bar.  As a workaround, open a new window manually with `Ctrl+N` and
  then use the tree view to move tabs to it.

- Vivaldi's stacked tabs are incompatible with this extension.  This might not
  be solve-able.  Vivaldi Workspaces are not tested at all, and may cause
  problems.

- When a sidepanel and a full page view are open at the same time in the same
  window, or more than one full page view, "extension shortcut" keys can
  control both simultaneously, causing unwanted side effects.  Until this is
  fixed, avoid using extension shortcuts when more than one view exists in
  a single window.

- Firefox doesn't allow extensions to access `file:` URLs or most of the
  `about:` URLs or any extension URLS outside of their own.  I can't fix this,
  but TKTSTO does at least try to avoid opening those.  However, if you manage
  to make it try to load an unloaded forbidden URL, the *next* tab opened may
  take the place of the node you tried to load.

- Firefox 115-142 generates some warnings about the manifest because the manifest
  is written for newer versions.

- Edge has no way to move the sidepanel to the left side.  It did in the past,
  but Microsoft removed it.

# History (by month)

## 2026-01
- 2026-01-06: 
  - Sanitize client IDs in Options/background and note it in the Options UI.
  - Add client ID flow integration coverage and options form tests.
  - Prevent ID generator collisions across restarts and document ID flow.
  - Add cache-busting imports for browser tests and extend ID generator tests.
  - Skip self-emitted tree messages to avoid double-applied deletes (and tests).
- 2026-01-04:
  - Refined window delete behavior to unload root windows while preserving tabs as wasLoaded.
  - Added mergeOpenWindowsIntoTree de-dup guard, tests, and window delete tutorial updates.
  - Added make coverage target to run node-based tests with V8 coverage output.
- 2026-01-03:
  - Added tab-reorder toggle and ensured tab creation follows browser order when disabled.
  - Added Tree/Node tests for window lifecycle, Firefox event ordering, and tab reorder toggle behavior.
- 2026-01-02: 
  - Added customizable keybind configuration in options.
  - Added UTF-8 charset meta tag to the Options page.
  - Updated README status for font/spacing and configurable hotkeys.
  - Refreshed ChangeLog entries and supported Firefox version notes.
  - Replaced `innerHTML` with safe DOM methods and added DOM safety/XSS tests.
  - Updated manifest minimum versions and data collection permissions.
  - Fixed make-zip packaging self-reference.
  - Added root-move window behavior toggle and window-container move guard.
  - Added window wrapping/conversion behavior and a hover-menu "W" button.
- 2026-01-01: 
  - Added Firefox signing support and a manifest versioning script.
  - Added appearance settings (font size/family, row height, indent).
  - Added favicon support/backfill and batch load/unload with Shift+U.
  - Updated extension name/ID and added AGENTS.md guidance.
- Other (2026-01-01): Makefile help target, .gitignore expansion, theme hover color,
  and README clarification on incognito permissions.

## 2025-08
- 2025-08-20: Fixed json2md export ordering issue.
- 2025-08-18: Added json2md tool to convert TKTSTO exports to markdown.

## 2025-07
- 2025-07-15: 
  - Fixed tab ordering when deleting a parent tab.
  - Ensured active tabs remain marked as loaded after activation.

## 2025-06
- 2025-06-13: Made marked-count widget paste marked nodes.
- 2025-06-09: Reattached orphaned nodes under lost+found during fsck.

## 2025-05
- 2025-05-25: Added mutex ordering to fix onTabUpdated/onTabReplaced warnings.
- 2025-05-20: Added backup archive helper script.
- 2025-05-19: Prepared 0.0.1.0 release (version bump, ChangeLog, README, manifest).
- 2025-05-16: Added extension icon and updated Chrome hotkey (Alt+T).
- 2025-05-15: Added automatic local backups and dialog/tutorial robustness fixes.
- 2025-05-13: Added first-run tutorial and improved initial window merge handling.
- 2025-05-11: Enabled session persistence across browser restarts.
- 2025-05-09: Implemented checkbox/task support and Tabs Outliner HTML converter.
- 2025-05-04: Added Vivaldi support and improved startup event ordering.
- 2025-05-02: Added external drag-and-drop (text/URL) support.
- 2025-05-01: Added drag-and-drop move and markdown export; renamed label/note fields.
- Other (2025-05-05 to 2025-05-18): Theme polish, manifest tweaks, illegal URL
  handling, and tab event fixes.

## 2025-04
- 2025-04-30: Added status bar summaries and backup completion messages.
- 2025-04-26: Implemented window-only view scope and window load/unload behavior.
- 2025-04-25: Added theme switching, theme files, and moved to AGPL-3.0-or-later.
- 2025-04-15: Added backup export/import and downloads permission.
- 2025-04-13: Improved tab attach/move handling and saved-tab loading workflows.
- 2025-04-10: Added tab event listeners and load/unload actions.
- 2025-04-09: Added Tabs Outliner session import support.
- 2025-04-07: Added long note support with dialog UI and indicator icon.
- 2025-04-06: Added timestamps/details box and emit() timing diagnostics.
- 2025-04-05: 
  - Added packaging scripts and initial Firefox support.
  - Added window/tab integration in the background tree.
- 2025-04-02: Added TreeStore/NodeStore serialization, sync, and mark/paste.
- 2025-04-01: Added emit() messaging and view-to-view tree synchronization.
- Other (2025-04-03 to 2025-04-30): UI polish, cursor fixes, hover-menu tweaks,
  and theme refinements.

## 2025-03
- 2025-03-31: Implemented node movement actions and expand/collapse rendering.
- 2025-03-30: Split TreeView from Node and added cursor/navigation actions.
- 2025-03-24: Added client ID configuration and refactored tree/node structure.
- 2025-03-20: Added background service worker, message passing, and debug logging.
- 2025-03-13: Initial project structure and license setup.
- Other (2025-03-19 to 2025-03-31): Early checkpoints, styling tweaks, and fixes.
