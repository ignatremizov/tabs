# ChangeLog

What changed, and when?  You know the drill.

## Unreleased

- Add persistent Recently deleted, accessed through the Deleted toolbar button.
  Capture branch and marked-batch deletions atomically with their recovery
  records; restore as saved into original or recovery locations, retaining
  notes, nesting, container scope, and native-group metadata without reopening
  pages. Preserve surviving promoted children rather than overwriting edits.
- Add configurable 30-day/200-action/32-MiB default retention, confirmed
  permanent removal, saved-only browser bindings, additive database-v3
  migration, and bounded duplicate-action receipts. Private selections require
  explicit permanent-deletion confirmation and retain no browsing-data copy.
- Serialize recovery with other outline/browser mutations and pause delayed
  writes during publication. Reject stale deletion confirmations and use a
  recovery generation to prevent old requests deleting restored IDs again.
- Add actual IndexedDB migration/rollback tests, history interface tests, and
  an isolated two-process Firefox history/restore integration test.

## 0.0.3.12

- Align container badges with neighboring favicons rather than the SVG's
  baseline. Paint inactive cursor rows using muted palette gradients instead
  of filtering the entire row, keeping container and favicon colors intact
  without an extra filtered row surface.

## 0.0.3.11

- Reserve durable session identities before resolving reused browser IDs or
  URL matches during startup. Rebind restored windows before their tabs and
  keep live originals distinct from saved descendants across browser restarts.
- Add full Firefox process-restart and real two-view convergence/durability
  tests using disposable profiles. Verify native/saved identities after
  relaunch, delayed and missed updates, visible failed writes, and the actual
  retry button; keep all test hooks out of production packages.

- Reserve toolbar space for persistent storage/recovery warnings instead of
  placing them in the floating notification overlay, keeping text and retry
  controls readable without overlapping the tree.

- Treat native group movement and metadata editing separately: reordering an
  existing group no longer overwrites newer native names/colors/collapse state,
  and one-field outline edits preserve the other current native values.
- Keep automatic build-number increments for normal build/sign commands, with
  one shared increment for paired browser builds and one for a build-and-sign
  operation. Retain explicit current-version targets for verification/resume.
  Record generated version metadata separately from committed source, without
  automatically staging or committing it. Package reproducible tracked inputs,
  refuse output replacement, and sign one
  immutable prebuilt archive with pinned tooling and environment-only secrets.
  Record uncertain submissions instead of retrying uploads; independently
  verify payloads and normal signature-enforcing Firefox installations.

- Patch title/favicon DOM elements without rebuilding rows, identity badges,
  or archived descendant statistics. General state changes still refresh
  affected ancestry, with each row rendered once rather than twice.
- Validate stored graphs before reconstruction or automatic cleanup and rebuild
  iteratively with depth/size bounds. Corrupt or inconsistent records stop in
  an explicit recovery state without rewriting originals; readiness requests
  reject promptly and the sidebar can export lossless raw recovery data.

- Validate imported fields, types, identifiers, and bounded graph structure
  before constructing nodes. Commit detached imports atomically before
  publishing them; rejected imports and failed writes leave the existing tree
  unchanged. Recover disconnected records and report skipped cyclic/repeated
  edges while preserving container scope and stripping browser bindings.
- Retain failed persistence batches and deletion tombstones for explicit retry
  or the next edit, including unchanged edits. Never acknowledge dirty data as
  saved; keep a persistent sidebar warning and Retry saving button until the
  database commit succeeds. Pending changes are in memory, not crash-durable.

- Resynchronize open sidebars from authoritative background data after repair
  or reconnect instead of repainting stale models. Preserve cursor ancestry,
  scrolling, and local expansion overrides; discard snapshots raced by a
  newer delta or local action and coalesce repeated refresh requests.
- Recover missed cross-window native-group events as whole groups before
  generic tab repair, preserving saved descendants and annotations. Abort
  recovery on unavailable or inconsistent native snapshots rather than
  flattening the saved member tree.
- Serialize native-group renames and collapse edits with outline movement and
  browser snapshots. Failed native updates can be retried with the same value;
  stale snapshots no longer cancel newer edits.

## 0.0.3.10 (2026-09-21)

- Draw compact container-badge frames and icons in the same SVG coordinate
  system, avoiding independent CSS-border snapping that made icons appear
  off-center at small sizes and fractional sidebar zoom. Preserve hover
  names, missing-container warnings, and native group styling.
- Reuse an already existing Firefox window when its initial tab event arrives
  before its window-created event. Moving a native group into that provisional
  window no longer opens an extra window and unnecessarily recreates the group.
- Wait for complete native-ungroup reconciliation in the Firefox integration
  test, and retain the original movement failure when cleanup also fails.

## 0.0.3.9 (2026-09-21)

- Added Firefox container tracking, compact colored icon badges, persistent
  cookie-store references, and exact-container restoration for tabs and the
  initial tab of a saved window. Deleted, inaccessible, foreign-profile, and
  private-window-incompatible container restores fail closed without opening
  another account. No cookie contents or authentication tokens are backed up.
- Kept container names in hover tooltips, accessible labels, and the details
  panel instead of repeating them on every tab row. Missing-container
  warnings remain visible, and renames update the tooltip immediately.
- Added native tab-group notes with bidirectional name/collapse updates,
  native color and membership tracking, member nesting, and promotion of
  nonmember descendants. Saved groups retain history and reconnect through
  stable outline member identities rather than stale browser group IDs.
- Added group-aware block reordering and cross-window moves, including
  protection against a browser snapshot undoing an in-flight outline move.
- Bound saved-tab creation to the authoritative returned tab ID, handling
  Firefox's initial blank-page events and overlapping same-URL restores.
  Browser event callbacks no longer return uncloneable outline objects.
- Added deterministic container/group regressions, DOM presentation and
  metadata-safety checks, and an isolated real-Firefox lifecycle/reload suite.
  Release validation passed 209 Node tests, 297 browser/DOM checks, and 16
  real-Firefox integration checks.

## 0.0.3.8 (2026-09-20)

- Fixed a saved-window restore deadlock: tab-update handlers no longer wait
  for pending tab creations while holding the browser-event lock needed to
  finish those creations.  This prevents pending saved-node matches expiring
  and late events adding duplicate rows in a different order.  Removed the
  obsolete loading mutex while retaining serialized browser mutations.
- Added regression coverage for early updates during restore, pinned-first
  tab order, nested branches, repeated URLs, and Firefox's temporary
  `about:blank` creation state.  Existing duplicate rows are not removed.


# 0.0.3 (2026-08-16)

The latest signed Firefox package for this release line is build `0.0.3.12`.

This is the cumulative fork-versus-upstream inventory for 0.0.3.  It compares
the fork with upstream `r0.1.181.0` (`e0031c2`) and includes work first shipped
in earlier 0.0.x fork builds.  The upstream release history is retained below;
features described there, such as search and the original "Pinned" branch
workflow, are part of the baseline rather than fork additions.  This covers
every functional, configuration, storage, build, test, documentation, and
project-policy difference which remains in the fork; features implemented in
the fork first but later absorbed by upstream are omitted unless the fork
still extends them.  Attribution and whitespace-only edits are not listed
individually.

## Identity, browser support, and distribution

- Changed the extension identity, author, homepage, and user-facing name to
  **Ignat's copy of TK's Tree Style Tab Outliner**.
- Assigned a fork-specific stable Firefox extension ID so AMO-signed builds
  install normally and update the same profile instead of requiring Temporary
  Extensions.
- Added Firefox's `sessions` permission for durable tab and window identity
  across crash restore, and raised the Firefox minimum version to 142.
- Replaced separate global Load and Unload commands with one
  `toggleLoad` command.  The default global binding is `Alt+L`.
- Compared dotted browser versions numerically, avoiding incorrect Firefox /
  Zen detection at version boundaries.
- Delegated Chromium toolbar-button opening to the browser's side-panel API
  across old and current API variants, and removed the ineffective attempt to
  call a nonexistent side-panel layout setter.

## Tree organization and movement

- Added **node-only moves**.  Starting a drag with `Ctrl` promotes the node's
  children into its old position and moves only the selected node.  The entire
  operation is atomic and restores the old layout if the destination is
  invalid or a later move step fails.
- Added a standalone **Promote children** action, default
  `Ctrl+Shift+ArrowLeft`, so a parent can be detached before a normal drag or
  keyboard move.
- Made browser-native tab-strip moves node-only too.  Moving a parent tab in
  Firefox or Chromium no longer drags its saved descendants to the new
  location.  Background persistence now rebroadcasts the same atomic move to
  every open sidebar, preventing stale subtree layouts and duplicate-looking
  live/unloaded entries after a follow-up native move.
- Added `Ctrl+ArrowUp` / `Ctrl+ArrowDown` navigation to jump to the previous
  sibling or parent and to the next sibling after the current subtree,
  including siblings found by climbing through ancestors.
- Made `Shift+ArrowUp` / `Shift+ArrowDown` nesting into expanded siblings
  configurable, added inverse-nesting shortcuts with `Shift+Alt+ArrowUp` /
  `Shift+Alt+ArrowDown`, and retained expanded-sibling nesting as the default.
- Added a dedicated `W` / **Wrap in window** shortcut and hover action.  It can
  wrap a tab or branch in a new window or directly invoke heading/window
  conversion while preserving loaded tabs, complementing upstream's edit and
  automatic drag conversions.
- Added options to open a new browser window when moving a subtree to the root
  and to wrap the top-most ungrouped ancestor when loading a root-level tab.
  Both are disabled by default.
- Preserved loaded window containers and proxies during root moves, nesting,
  promotion, conversion, and cross-window moves.
- Added an option to stop automatically reordering newly created browser tabs
  when the browser already places them correctly.  It remains enabled by
  default, and treats pinned and unpinned tab strips separately.
- Pasted marked nodes in tree order instead of mark order.  Plain-text drops
  into notes can now prepend or append, according to an option; prepend is the
  default.

## Deletion and window lifecycle

- Split branch-deletion policy by presentation state.  By default, deleting an
  **expanded** parent deletes only that parent and promotes its children, while
  deleting a **collapsed** parent asks before deleting the subtree.  Both
  policies remain configurable.
- Made delete-with-child-promotion one background transaction.  Removing a
  restore wrapper can no longer race with individual child deletes and
  recursively erase the subtree it was meant to preserve.
- Synchronized browser-native parent-tab closes with every open sidebar after
  the promote-delete transaction commits.  Closed parents no longer remain as
  selected ghost rows, their children replace them in place, and persisted
  child records retain a valid parent instead of becoming Lost+Found orphans.
- Added window-aware deletion.  An expanded loaded window can be closed while
  retaining its tabs as `wasLoaded`; an unloaded window is unwrapped; nested
  loaded windows merge into or are preserved under a suitable window
  container.  Collapsed loaded windows retain a confirmation step before
  their tabs are deleted.
- Preserved saved tab nodes when unloading or closing windows and repaired
  empty-window cleanup so stale asynchronous callbacks cannot resurrect
  deleted nodes.

## Loading, shortcuts, and keyboard control

- Replaced the in-panel Load and Unload actions with one configurable
  **Load / unload** toggle and one hover-menu control.  The default in-panel
  key is `U`.  Unloading an expanded parent affects only that node, while
  unloading a collapsed parent affects every loaded tab in its branch without
  prompting; loading retains its configurable branch policies.
- Added a smart Shift variant, default `Shift+U`.  It first loads only missing
  `wasLoaded` tabs below the selected node without disturbing tabs already
  open.  If none are missing, it falls back to the normal load/unload toggle.
- Added an Options editor for all in-panel keyboard actions, including reset
  to defaults, conflict replacement, and clearing a binding.
- Canonicalized shortcut display and storage: letters and function keys use
  uppercase, while named keys use forms such as `Shift`, `Ctrl`, `ArrowUp`,
  `PageDown`, and `Escape`.  Older lowercase custom bindings continue to
  normalize to the same action.
- Added an option controlling whether Enter or double-click on an already
  active tab refocuses its browser window or edits the node.  Editing remains
  the default.
- Made the PageUp / PageDown jump size configurable, with a default of 20
  visible rows.

## Sidebar state, interaction, and appearance

- Added a configurable default view scope: Session, Window, or Auto.  Auto uses
  Session scope for the first browser window and Window scope for later ones.
- Remembered Details, Notes-only, or Plain mode independently for each browser
  window.
- Saved presentation state in browser session storage, keyed by browser window,
  view type, and scope.  Cursor node, active-node identity, raw scroll
  position, first visible row, and row offset survive closing and reopening
  the sidebar without modifying the tree database.
- Restored the cursor to the current active tab when the saved cursor is stale,
  while otherwise preserving the exact viewport during tree changes,
  deletions, and sidebar reconstruction.
- Preserved upstream's focused-window tracking through temporary
  `WINDOW_ID_NONE` events during `Alt+Tab`, so the most recently focused
  Session window no longer disappears or collapses.
- Applied active-tab changes directly to existing rows so `Ctrl+Tab` /
  `Ctrl+Shift+Tab` cursor tracking is immediate and row labels do not flicker.
- Cancelled superseded delayed edge-scroll requests, preventing the sidebar
  from jumping back after unloading the active tab or making another cursor
  move.
- Added preset selectors plus direct custom input for font family, font size,
  row height, and indentation; added compact mode, favicon visibility, a row
  hover color, stronger active-window styling, and configurable cursor scroll
  margin.
- Rendered stored favicons in the tree and added an optional one-transaction
  backfill for missing icons.  The Options page reports progress and refreshes
  open views when backfill completes.
- Extended upstream's pin marker to reflect separately persisted
  browser-native pins, with accessible labeling and a dedicated theme color;
  stabilized hover-menu sizing across custom row heights and removed the
  redundant right-side scrollbar gutter.
- Restored task editing for nodes which already have a checkbox and made
  overlapping dialogs and asynchronous UI actions consistently lock input,
  close, and report failures.
- Made theme setup idempotent and added safe fallback behavior when a selected
  theme is unavailable.

## Firefox restore, pinned tabs, and browser reconciliation

- Stored node IDs in Firefox tab and window session values.  Firefox crash /
  Restore Tabs now reconnects restored browser objects to their previous tree
  nodes instead of relying only on transient browser IDs.
- Rebuilt startup matching to prefer session identity, then direct browser
  identity, normalized URL, pinned state, ancestry, and order.  Each candidate
  is consumed only once, so duplicate URLs, repeated pinned pages, reversed
  restore order, and concurrent pending windows do not create duplicate rows.
- Handled Firefox event sequences where tab creation or attachment arrives
  before its window event, and retained pending window ancestry until matching
  completes.
- Reattached tutorial, Options, Help, and other internal extension pages by
  their normalized extension-relative URL.  Restored `moz-extension://UUID`
  pages no longer appear first as UUID nodes and then as renamed duplicates.
- Persisted browser-native `pinned` state separately from tree structure and
  synchronized it with the optional upstream "Pinned" branch convention.
  Pinning, unpinning, creation, restore, reorder, and branch renaming all keep
  native state and tree placement aligned.
- Enforced one live node per browser tab or window, cleared conflicting stale
  bindings, and selected the most complete saved node as the primary when old
  data contains duplicates.
- Added startup and configurable periodic reconciliation.  Live browser tabs
  and windows are authoritative for attachment, active state, geometry,
  native pins, and tab order; saved tree nodes remain authoritative for
  unloaded content and organization.  Periodic repair defaults to every five
  minutes and can be disabled without disabling startup reconciliation.
- Persisted window position, size, display state, focus state, and repaired tab
  attachments as browser events arrive, so a later restore starts from the
  latest known browser state.
- Reconciliation repairs missing browser objects, stale or duplicate IDs,
  misplaced pinned tabs, window geometry/state, unattached live tabs, and
  obsolete empty browser wrappers without discarding saved branches.

## Persistence and MV3 event reliability

- Removed the fork's experimental durable `Ops` queue.  Routine mutations now
  write directly to the original schema-1 `Nodes` store; startup and periodic
  reconciliation repair interrupted browser-side work.
- Removed unused snapshot and transaction-store helpers from new database
  creation.  Current code persists the live tree only through `Nodes`; old
  schema-1 databases may retain those extra upstream stores, but they are not
  read or written.
- Added one tree-wide persistence boundary.  A structural mutation saves and
  deletes every affected node in one IndexedDB transaction and resolves only
  after that transaction commits.
- Batched moves, promotion, active-tab switches, subtree deletion, window
  closure, pin transitions, tutorial creation, and imports instead of issuing
  one transaction per node.
- Serialized browser structural events in memory so rapid create, attach,
  detach, move, close, and restore events cannot interleave incompatible tree
  mutations.
- Added message source IDs to prevent a view from replaying its own tree event.
  Added stable request IDs and a bounded background response cache so a lost
  acknowledgement can be retried without applying a mutation twice.
- Made background mutation replies wait for durable completion, retried
  transient missing responses, and surfaced final failures to the initiating
  UI action.
- Wrapped asynchronous browser event listeners so rejected handlers are logged
  instead of becoming unhandled promises.  Background and TreeView startup
  failures now produce explicit diagnostics, and sidebar initialization
  failures are also shown in the status area.
- Rejected malformed stored node JSON instead of silently constructing partial
  nodes.  Hardened node-ID generation against collisions and sequence overflow,
  and allowed uppercase Base32 IDs during restore.
- Made asynchronous configuration watchers report rejected promises instead
  of losing failures.

## Backups, imports, and data maintenance

- Added an independent, default-on option for upstream's overdue startup
  backup, so it can be disabled without changing the regular backup interval.
- Kept each backup call pending until the browser reports terminal download
  completion, with a timeout and finally-based listener cleanup.  A
  timestamp-storage failure after a completed download no longer reports the
  backup itself as failed.
- Validated TKTSTO imports before mutating the live tree, including schema,
  root shape, repeated nodes, and cycles.  Imports do not modify the parsed
  source object and are persisted as one atomic batch.
- Treated imports as deliberately non-idempotent: a lost response reports an
  error instead of automatically importing the same backup twice.
- Made file selection for the existing Tabs Outliner importer explicit: JSON
  `.tree` exports are imported, while selected HTML files are recognized and
  rejected with guidance because HTML conversion is not implemented.
- Sanitized client IDs to non-empty alphanumeric values in both Options and the
  background, persisted corrected values, and added inline validation hints.
- Added conservative backup duplicate tools.  Analysis hashes subtrees and
  reports exact and same-content sibling candidates.  Cleanup requires the
  matching checksum audit, removes only identical same-parent subtrees or
  metadata-free same-URL leaves with matching pinned state, writes a separate
  output, and fails closed if the input changed.

## Performance

- Rebuilt the sidebar into detached document fragments and created DOM only for
  visible rows.  On an 11,122-node session, rendering 325 visible rows dropped
  from a 411 ms median to 48 ms.
- Replaced structured cloning of the full object graph with one JSON tree
  payload.  On the same roughly 10.98 MB tree, background-to-view transfer,
  stringify, and parse dropped from 742–818 ms to about 257–298 ms.
- Shared the already-loaded configuration, batched per-window session-storage
  reads, overlapped independent startup requests, reused fetched window data,
  and generated transient view IDs locally to reduce sidebar startup
  round-trips.
- Indexed restore candidates by session ID, browser ID, normalized URL, and pin
  state instead of repeatedly scanning the full saved tree.
- Avoided full-row reconstruction for active-tab changes and redundant browser
  tab moves when the tab was already in the correct position.  Browser-strip
  reorder requests are debounced per window and serialized.

## Safety, tests, documentation, and developer tooling

- Replaced unsafe dynamic `innerHTML` rendering in dialogs and node rows with
  explicit DOM construction and text nodes.
- Added Node-based coverage for tree, persistence, restore, reconciliation,
  message retry, import, backup, keybinding, and movement behavior.  The suite
  contains 209 checks as of build 0.0.3.9.
- Added browser suites for DOM safety, client-ID flow, Firefox / Chromium
  restore rules, Tree / Node behavior, and 78 TreeView actions in each browser
  mode.  Added V8/browser coverage collection and a generated README badge;
  the headless runner now fails when a completed page reports failed checks.
- Added developer documentation for event flow, IndexedDB durability, node
  IDs, marking and paste behavior, plus updated user help for movement,
  shortcuts, windows, pinned tabs, checkboxes, and `wasLoaded` restore.
- Expanded the generated tutorial with drop-text, view-mode, window wrapping,
  window deletion, root-move, and keyboard-movement exercises.  Its shortcut
  list now comes from the shared configurable-keybinding definition, and the
  complete tutorial is created in one persistence batch.
- Added reusable WebDriver startup/cleanup helpers for extension testing and
  expanded `make test`, `make test-node`, `make coverage`, and `make todo`
  workflows.
- Added cross-browser stack-location parsing and quiet logging controls for
  deterministic test output.
- Added project-specific contributor guidance, AI contribution policy, and DCO
  addendum while retaining AGPL-3.0-or-later licensing.
- Expanded repository ignore rules for credentials, release and coverage
  output, browser-test profiles, editors, temporary backups, and local
  agent-workflow files.

## Build and release workflow

- Replaced placeholder manifest generation with SemVer base tags plus a shared
  numeric build counter (`MAJOR.MINOR.PATCH.BUILD`) in both manifests.
- Made `make all` increment once and build both browsers.  Added separate
  current-version zip targets, a Chromium unpacked directory target, version
  validation/tagging helpers, and clearer `make help` output.
- Kept the fork's `make firefox-sign` target distinct from upstream's
  equivalent `firefox-xpi` name, and added timeout control, a credential-free
  `.env.sample`, and optional build-time name / Firefox-ID overrides.
- Packaged recursive assets, locales, and user help for both browsers while
  excluding test suites and developer-only documentation from release
  archives.

## Storage compatibility

- Current builds intentionally retain IndexedDB schema version 1 and use only
  the compatible `Nodes` store.  There is no database migration for temporary
  development builds which created the fork-only schema-2 `Ops` store.
- To move from one of those experimental builds, export JSON, clear or
  reinstall the extension data, then restore the export.  Git history retains
  the old queue implementation if it is ever needed for forensic recovery.


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

## 0.1.181.0 (2026-04-06)

Google Chrome (and no other Chrome-based browsers, as far as I can tell)
recently started pretending to be Firefox, by defining "browser" as
a top-level object in its API.  This makes extensions break when they use the
most common method of detecting the browser type, a method which was simple
and reliable for the past decade but suddenly no longer works.  This update
fixes that.

Changes:

- Dragging a window into another window in the TreeView can optionally
  convert that window to a heading, and move all tabs into the destination
  window.  This only affects loaded windows.

Bug fixes:

- Fixed browser detection in Google Chrome.  Many things broke when Google
  Chrome added "browser" as a synonym for "chrome" in its API, but now we use
  a different method to detect Firefox vs Chrome, which should fix all the
  things caused by the failed detection.

- Fixed tabs getting unpinned when closing a window in Chrome-based browsers.
  The browser sends an "unpin" event right before closing the window, and
  TKTSTO was respecting that event... even when it shouldn't.  So now it
  waits a moment and ignores the "unpin" if the window or tab got closed.


## 0.1.177.0 (2026-03-31)

Mostly bugfixes and small usability improvements this time.

Changes:

- Made tree drag-n-drop handle **root-level drops** in a **more intuitive**
  way, so you can drop at root level and things land where it looks like they
  should.

- Added user stylesheet example for how to **style the drop indicators**.

- Made it possible to **drag** a "heading with loaded tabs" outside of
  a window.  This now causes the **heading to become a window**.

- Made **internal extension pages re-open after browser restart** or
  extension restart.  No more need to manually re-open the TreeView after
  browser restart when using "Tabs Outliner mode".

- Made **Options / Help pages open in other window** when using "Tabs
  Outliner mode", instead of opening as a tab in the narrow TreeView window.

- Made TreeView update a bit faster when changing tabs, and handle "user
  holding the change-tab key down" better.

- Improved some formatting in Options / Help pages.

- Added **Floorp** as a supported browser.  Works the same as Firefox.

Bug fixes:

- **Fixed dragging tabs** around the native tab bar in Chrome:  Could only
  move one space, and got errors about "Tabs cannot be edited right now".

- Fixed issue when moving a collapsed parent downward via keyboard while
  expanded via an override.  It got mixed signals about its expanded state
  and tried to become its own child.

- Fixed Firefox occasionally creating a new node, on slow computers, when
  trying to load a saved tab.

- Fixed some errors about "No window with id: foo".

- Fixed bogus warning about loadSavedNode failing when it didn't.

- Fixed TreeView trying to run boot-up code in the wrong order in Vivaldi.

- Fixed case where a new tab could potentially unpin pinned tabs.


## 0.1.156.0 (2026-03-23)

Changes:

- Added **search** functions.  Like Vim, press `/` or `*` to start a search,
  `Enter` to lock it in, and `n` or `Shift+N` to go through matches.  Then
  `Escape` to cancel it, or again to collapse all temporarily-expanded
  branches.

- Added an option for "hide top buttons during search".  Also added a doc
  page for search.

- Improved **Tabs Outliner mode** (session mode in a standalone window).
  The session-mode cursor now follows the active tab in *other* windows.
  Window nodes change their "active" status and styling when focused.
  Browser global hotkeys now work in this mode too -- if there is only one
  TreeView and it's in Session mode, hotkeys get sent there regardless of
  which window actually has focus.

Bug fixes:

- Fixed case where boring tabs would be kept when closed, if they had
  previously been unloaded and reloaded.

- Fixed drag-n-drop breaking cursor scrolling... again.

- Reduced time window where a tab could be attached to the wrong node after
  failing to load a saved tab.  Was 3 seconds, now 1 second.

- Fixed failure to render child nodes after moving an invisible branch to
  a visible location.


## 0.1.145.0 (2026-03-15)

Changes:

- Added **options for vertical spacing** of the tree view, for people who
  want it to be less dense.

- Added a count of **wasLoaded** tabs in the **node stats** widget.

- Made **batch load** work on loaded **window nodes**, so you can load the
  rest of the unloaded tabs all at once if you want.

- `Ctrl+Enter` now saves in the Edit Node dialog.

- Made it easier to tell what items in the Options page do.

Bug fixes:

- Fixed global "load node" hotkey not working on bookmarks with kids.

- Fixed issue where keyboard scrolling could break after a drag-n-drop.

- Fixed manual expand/collapse taking a few tries when auto-expanded.

- Fixed stale "active" tab state at boot, in a specific corner case.


## 0.1.135.0 (2026-03-12)

Changes:

- Added **appearance options**: font, indentation, window tree lines, details
  box size, user styles (full CSS editing).

- Added feature to **expand branches when the cursor follows active tab**.
  That means you can keep your headings collapsed, and they'll open/close on
  their own as you change tabs.

- Firefox: Turned off "hide collapsed tabs" by default, since it'll likely
  confuse new users and it interacts badly with the new auto-expand
  auto-collapse branch feature.

- Reorganized the Options page a bit.

- Reduced indentation of top-level items within a window.

Bug fixes:

- **Fixed** a bunch of cases where **drag-n-drop** didn't work.

- **Fsck now deletes boring empty window nodes**, so if those have been
  accumulating in your session, they should clean themselves up now.

- Fixed issue where **saved windows wouldn't load** because they were
  **partially offscreen**.

- Fixed some cases where tab data didn't update while attaching windows at
  boot time.

- Fixed wrong color of note icon in window nodes in TK Day theme.

## 0.1.124.0 (2026-03-09)

Update your preferences in **Options** after updating to this release.
New stuff was added, and some defaults were changed.  Recommended settings:

- [ ] Draw a + before expanded branches?
- [ ] Show node stats before expanded branches?
- [X] Hide tree lines (dim, outside cursor branch)?
- [ ] Hide cursor branch tree lines?
- [X] Tree view cursor follows active (focused) tab?
- When (un)loading/deleting: Ask
- [ ] When a pinned tab is active and a new tab is opened, pin the new tab too?
- Automatic backups every 1 to 24 hours

Changes:

- New feature: **hide collapsed tabs** (Firefox only, since Chrome can't
  hide tabs).  Collapsing a branch hides the tabs in that branch.

- Added ability to **load or unload entire branches**, similar to saving and
  restoring a window, but for the tabs inside of a branch.

- Added options for **what to do when unloading a branch with loaded tabs**.
  Unload one, unload all, or ask.  Default is "ask".

- Added an option for **what to do when deleting an expanded parent node**.
  Delete one (old behavior), delete all, or ask.  Default is "ask".

- Added an option for **whether pinned tabs should open new tabs pinned too**,
  or if new tabs should be moved outside the "Pinned" area.

- Added options to **hide tree lines** on regular and cursor branches, for
  those who prefer going without indent lines.

- Added an option to **show node stats on expanded branches**.  Unsure if it
  should be default, or if the old "show + before expanded branches" should
  remain as default.  I don't like having either one enabled, but it's good
  for teaching new users they can click there to collapse the branch.

- Added **divider rows** by adding a node with a label of `-` or `=`.
  Blank rows can serve a similar purpose, setting a label to ` ` (Space).

- Made **unsaved config options glow** until they're auto-saved, to let user
  know when it happened.

- **Documentation** updates:  Reorganized the index page.  Added a page
  documenting **node types**.  Made drag-n-drop docs clearer visually.
  Re-worded some things.  Improved some aesthetics a little.

Internal:

- New config manager system, so I can finally add **user config options**
  without a lot of development overhead and complications.

Bug fixes:

- **CapsLock no longer breaks key bindings.**  Oops.  I don't even have
  a CapsLock key, so I never tried that before.

- Made "cursor follows active tab" work for new tabs too.

- Fixed regression: Two tabs could be marked as active in one window, if the
  user moved a branch with an active tab from another window.

- The tutorial no longer puts itself before the pinned tabs.  Before,
  generating a tutorial would unpin all the pinned tabs.

- The "add node" function no longer allows inserting between a window node
  and its "Pinned" branch, if it has any loaded tabs.  Because that would
  unpin everything.

- Being pinned is no longer enough to make a "new tab" page count as "not
  boring".  So closing a pinned "new tab" page with no metadata now deletes
  it, instead of keeping it.

- Fixed color of bookmark and other icons on cursor row in TK Day theme.


## 0.1.97.1 (2026-03-02)

- Made markdown renderer even safer, to address a warning from Firefox's lint
  checker.  It wasn't unsafe regardless, since it only allows files shipped
  with the extension, and they don't contain anything sketchy... but I added
  an extra layer of safety regardless, replacing all '<' and '>' and '&'
  input characters with safer versions like '&lt;', '&gt;', and '&amp;'.
  Hopefully this will satisfy any security reviews.


## 0.1.96.0 (2026-03-02)

Changes:

- New node type: **Bookmarks**.  Press `Alt+B` to bookmark the current page,
  (or `Alt+K` in Firefox, since it doesn't allow Alt+B)
  or use `editNode` to convert a saved tab into a bookmark.  Bookmarks are
  saved tabs which **spawn a clone of themselves when opened**, so the
  original will not be changed when you navigate to another page.  Note,
  these are *not* the browser's native bookmarks.  Those are not supported
  yet.  See the "Help -> Bookmarks" page for more details.

- Added more **documentation pages**, including a new **markdown renderer**
  for pages like **readme.md**, **ChangeLog.md**, and **Browsers.md**.
  Also added other project links, and updated several help pages.

- More detailed browser console logs for debugging and error reporting.

Bug fixes:

- **Pinned tabs won't get deleted when closed** now, even if they are
  otherwise "boring".  Before, a pinned tab with no metadata would be
  considered "boring" and get deleted when closed with `Ctrl+W`.

- Fixed **automatic backups getting stuck after one failure**, like if the
  user has "ask me where to save" enabled and they hit Escape to cancel it,
  the automatic backups would just stop.

- Fixed **loaded tabs turning grey instead of pink after a crash** with
  automatic recovery disabled, for easier manual recovery.

- Fixed several issues relating to **stale tabIds and windowIDs**,
  particularly after a browser crash, and made stale data **self-healing**.

- Fixed Firefox attaching new windows to old saved window nodes sometimes,
  after a crash.

- Improved handling of **unrecognized tabs**, which can happen if a tab
  creation event got missed, or if a buggy browser (Zen) doesn't bother to
  send an event.

- **Greyed out forbidden page buttons** in Chrome.  It doesn't allow the
  "Options", "Help", or "Tab" pages in incognito mode.  They still work, sort
  of, but they open in the wrong window.

- Reduced side effects of a failed attempt to load a saved tab.

- Fixed a warning when checking cursor visibility after deleting the branch
  it's in.


## 0.1.80.0 (2026-02-25)

Changes:

- Added support for **pinned tabs**.  It uses a special magic branch called
  "Pinned" at the top of each window, and moving nodes into or out of that
  branch will pin or unpin them.

- Made **Shift+Up/Shift+Down node moves** a bit more intuitive when moving to
  or from the end of an expanded branch.  It no longer skips past the next
  node, and instead will **indent / dedent to match the next node** first.

- Completely overhauled the **documentation pages**, including both the
  appearance and the content.  Now uses the user's configured theme, and has
  more information -- particularly TreeView widgets as a visual guide for how
  to do things.

- Made the user's **theme** apply to the **Options page** too.

- Made the **"Help" button** show a **list of help pages**, and info about
  how to invoke a tutorial.

- Added a help page for **pinned tabs**.

- Added a help page for people **migrating from Tabs Outliner**.

- Moved theme-handling code to a central location, to make it easier and more
  consistent to make themed pages.

- Finally added some demo screenshots to the main readme.

Bug fixes:

- Fixed cursor going to the wrong place after clicking the viewScope button.

- Removed unused permissions in Chrome, so the extension can be published in
  the Chrome store.  Will have to re-add those later if I ever add the
  features the permissions were meant to enable.


## 0.1.69.0 (2026-02-19)

Changes:

- Added a **new task type**: **"ratio" or "/"**, shows "$done / $total"
  like `3/7`

- Made **nested windows more intuitive** when using "window" view scope mode
  (can be expanded and collapsed within the parent now)

- Multiple improvements to **scrolling**

- Multiple improvements to **drag-n-drop**

- Made it easy to scroll during a drag-n-drop

Bug fixes:

- Double click near top/bottom of view **no longer scrolls before 2nd click**

- Fixed keyboard **scrolling** sometimes scrolling the wrong direction when
  **computer was really busy**

- Fixed scrolling to slightly wrong place when zoomed

- Fixed **drag-n-drop between tktsto sidepanels**

- Fixed some cases where the wrong node could get dragged

- Fixed cursor jumping to focused tab when node dropped into a collapsed
  branch

- Fixed cursor jumping to focused tab when pasted into a collapsed branch

- Hover menu no longer gets in the way during a drag-n-drop

- Hover menu no longer gets in the way during keyboard scroll

- Fixed button label text getting highlighted when it shouldn't

- Improved detection of Zen Browser (but requires new Zen)

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Brave 1.78
- Vivaldi 7.3, 7.7
- Maxthon 7.3.1
- Zen Browser 1.18.3b


## 0.1.55.0 (2026-02-02)

Changes:

- Added **partial support for Zen Browser**.  Requires special configuration
  and workflow adjustments, because some of Zen's features are incompatible
  in ways which are difficult or impossible to fix.  Read the Zen-specific
  parts of the tutorial nodes for details (press `?` in a tree view to
  generate a tutorial).

- Added optional command hotkeys for prev/next tab, for browsers which lack
  that hotkey or which refuse to keep their native tab bar in the same order
  as the tree.

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Brave 1.78
- Vivaldi 7.3, 7.7
- Maxthon 7.3.1
- Zen Browser 1.18.3b


## 0.1.52.0 (2026-01-30)

Bug fixes:

- Fixed an issue which broke Firefox: Tree wouldn't load, because an async
  message handler returned a non-null status.  Fixed by changing one word.


## 0.1.51.0 (2026-01-30)

Changes:

- Added **zoom** for the tree view with **"+" and "-" buttons**

- Added `i` key to **toggle notes/details/plain** info view mode

- Added ability to **convert between text nodes and window nodes**, so you
  can promote a branch to a window or turn a window into a branch.  This
  makes it easier to keep windows smaller and more topic-focused, since any
  branch which gets too large can be turned into its own window.

- Added ability to **change incognito status** of unloaded windows

- Added ability to **edit page title and URL** for unloaded tabs

- Added ability to **edit** notes and window status **while adding** a node

- Added short error messages in the status bar when a user action is
  rejected, like trying to move an incognito tab to a non-incognito window.

Bug fixes:

- Fixed errors when trying to **move a tab** between a **regular window** and
  an **incognito window**.  The browser doesn't allow that, so now TKTSTO
  prevents it instead of failing.

- Fixed problems when moving loaded tabs entirely out of a window and into
  the void.  **Loaded tabs must be inside a window**, so now it doesn't
  allow moving them into the void.

- Fixed issue where **pressing "d" too fast** to delete nodes could cause
  incomplete deletion, and partially-deleted nodes would then be recovered in
  `lost+found` on the next fsck

- Moved `lost+found` to the **top of the tree** instead of the bottom, to
  make it more noticeable when data has been recovered.

- Added more safety checks in general, for data storage access, to make sure
  events get handled in the correct order and only one at a time

- Fixed issue where maximized/minimized window state could be ignored
  sometimes when loading a saved window.

Misc:

- Added a **privacy policy**.  It's required by some web extension stores.

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Brave 1.78
- Vivaldi 7.3, 7.7
- Maxthon 7.3.1


## 0.1.39.0 (2026-01-21)

Changes:

- Added feature: Tree view **cursor follows active tab**.  So it
  automatically follows what you're doing in the browser, and shows the part
  of the tree near the current page.

- Added support for **incognito windows**.

- Added support for **fullscreen, maximized, and minimized windows**... and
  improved support for remembering **window geometry**.

- Improved backups: Now **saves a backup at boot time if it's overdue**.

- Made it possible to **mark windows**.

- **Added Shift+PgDn** in tree view, and **fixed Shift+PgUp**.  Moves current
  node up/down without increasing depth.

- Changed **Firefox default hotkey** to `F1`, and added default suggested
  hotkeys for many other actions.

Bug fixes:

- Fixed "**click extension icon does nothing**" in Firefox.

- **Fixed** major issue in **Vivaldi 7.7** where sidepanel "tabs" got mixed
  into the tree and caused tree corruption.  Other browsers and older
  versions of Vivaldi are unaffected.

- Fixed `delete` doing nothing on **open window** nodes... now it **unloads**
  instead.

- Fixed `load` doing nothing on saved windows with **no "wasLoaded"** tabs.
  Now **loads the first tab** (and thus the window), leaving the user to load
  other saved tabs if they want more.

- Fixed bug: Deleting bottom-most node in "Window" mode made cursor disappear.

- Fixed some cases where cursor could fall out of scope in Window mode.

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Brave 1.78
- Vivaldi 7.3, 7.7
- Maxthon 7.3.1


## 0.1.24.0 (2026-01-17)

Changes:

- Made this window's title row stand out more.

- Implemented `Shift+P` for `pasteMarkedBefore`.  Press `p` to paste below
  cursor, or `Shift+P` to paste above cursor.

- Added a **scroll margin** around the tree view cursor.

- Added **smooth scrolling** to the tree view.

- Added window ID in node details area.

- **"Window" mode** in the tree view no longer shows contents of
  **sub-windows**.  They appear as a single row instead, as if **collapsed**.
  That way, you can have a bunch of expanded sub-windows without using a ton
  of space in the parent's tree view.

Bug fixes:

- Fixed multiple cases of **tabs opening at far right edge** when they should
  be placed elsewhere.

- Fixed **missing cursor** after opening a new tree view, when active tab
  node was hidden in a collapsed branch.

- Fixed incorrect tab "wasLoaded" state which sometimes happened when closing
  and saving a window.

- Fixed failure to mark active tab node as active in Firefox, when loading
  a saved window.

- Fixed **orphaned ("lost+found") nodes** in Brave when closing boring
  windows.

- Fixed attempt to delete window nodes twice in Chromium while closing
  a boring window.

- Fixed **Firefox not deleting boring windows** when closed.

- Reduced some unimportant "errors" to warnings, logs, or just silence.

- Fixed **missing cursor** when pressing `Right Arrow` on a collapsed node
  which hasn't previously been expanded in this tree view.

- Fixed a bunch of cases where the **tree view cursor could get lost**, like
  when mark+pasting nodes between windows, or into collapsed branches, or
  when changing view modes.

- Fixed a bunch of issues with **"Window" mode** in tree view...
  - Collapsing the session root node would break all tree views in "Window"
    mode.  More generally, collapsing the window's parents doesn't break the
    tree view any more.
  - In "Window" mode, `cursorRight` action no longer descends into
    sub-windows.
  - Fixed rare case of render failure when expanding a collapsed node.
  - Fixed issue where a sub-window's active tab could sometimes be returned
    when looking for parent window's active tab.

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Vivaldi 7.3
- Brave 1.78
- Maxthon 7.3.1


## 0.1.10.0 (2026-01-14)

Changes:

- Made new windows use **"Window" view mode by default** instead of "Session"
  view mode, since this is the typical and recommended way to use this
  extension.  Only the **first window gets "Session" mode** by default.

- Made `marked count` widget work as a button to **paste marked** nodes.

- Improved fsck to handle **detached nodes** better.  If a node gets detached
  but not fully deleted, it'll show up under `lost+found/` next time the
  service worker restarts.  Most "lost+found" items can be safely deleted,
  but it **saves them just in case, so you can decide**.

- Switched to a new version numbering scheme: `$Major.$Minor.$Commit.$Build`.
  Production versions should generally end with `.0`.

- Added signed Firefox `.xpi` packages.

- Fixed some issues with closed tabs staying in the tree sometimes instead of
  getting fully deleted.

- Fixed bug: Deleting a parent tab could put its open child tabs in
  **reverse order**.

- Fixed failure to detect parent tabs in **Maxthon** browser.

- Fixed tabs being in the wrong order in **Maxthon** browser.

- Fixed `onTabReplaced` event handling, in browsers which use that.  Usually
  it happens when a tab has been partially unloaded by the browser or an
  extension to reduce resource use.

- Fixed warnings when unloading tabs.

- Fixed some rare bugs I only ever saw once while testing broken code which
  was never committed.  Should help in case those issues ever somehow
  happened in a real version, but it's unlikely they would ever happen.

Extras:

- Added `bin/archive-backup-downloads.py` to move backups out of your
  "Downloads/" dir and compress them.

- Added `bin/json2md.py` to convert json backup files to markdown.

Extras require cloning the git branch.  Use this to get a copy:

`git clone https://github.com/ToyKeeper/tktsto.git`

Browsers known to work, or mostly work:

- Firefox ESR 115 .. 140
- Chromium (and Ungoogled Chromium) 134 .. 143
- Edge 136 .. 143
- Vivaldi 7.3
- Brave 1.78
- Maxthon 7.3.1


## 0.0.1.0 (2025-05-19)

**First public release.**

This is **alpha** software.  To be safe, **enable automatic backups!**

The client (browser extension) mostly works, but the server hasn't even
started development yet.

# Supported/tested browsers include:

- Firefox 142
- Chromium 134
- Edge 136
- Vivaldi 7.3
- Brave 1.78
- Ungoogled Chromium 135
- Maxthon 7.5.2.3100

# Known issues:

- A bunch of functions and features are **not implemented yet**.

- Pinned tabs are not supported.

- Tab groups are not supported.

- Incognito windows are not yet tested.  It may work, but when you bring back
  a saved incognito window, it might not be incognito any more.

- Chromium-based browsers (except Vivaldi) do some weird stuff when tearing
  off a tab or branch to create a new window.  This may *sometimes* separate
  a parent tab from its children and move the children to the left edge of
  their tab bar.  As a workaround, open a new window manually with `Ctrl+N`
  and then use the tree view to move tabs to it.

- Vivaldi's stacked tabs are incompatible with this extension.  This might
  not be solve-able.  Vivaldi Workspaces are not tested at all, and may cause
  problems.

- When a sidepanel and a full page view are open at the same time in the same
  window, or more than one full page view, "extension shortcut" keys can
  control both simultaneously, causing unwanted side effects.  Until this is
  fixed, avoid using extension shortcuts when more than one view exists in
  a single window.

- Firefox doesn't allow extensions to access `file:` URLs or most of the
  `about:` URLs or any extension URLS outside of their own.  I can't fix
  this, but TKTSTO does at least try to avoid opening those.  However, if you
  manage to make it try to load an unloaded forbidden URL, the *next* tab
  opened may take the place of the node you tried to load.

- Firefox 115-142 generates some warnings about the manifest because the manifest
  is written for newer versions.

- Edge has no way to move the sidepanel to the left side.  It did in the past,
  but Microsoft removed it.

# History (by month)

## 2026-01
- 2026-01-11:
  - Add a default view scope option for new windows (Session / Window / Auto).
  - Add a PageUp/PageDown jump size option for cursor navigation.
  - Add a drop-text behavior option to prepend or append to existing notes.
- 2026-01-10:
  - Remember details/notes/plain mode per browser window.
  - Fix tab close handling when a fresh service worker spawns (avoid stale wasLoaded pink tabs after manual closes).
  - Improve fsck orphan recovery (self-parent/parent-child mismatch detection, clearer logging, clear loaded/wasLoaded on reattach).
  - Default the first window to Session view scope and subsequent windows to Window scope.
  - Prefer direct tabId matches over oldTabId when resolving tab nodes.
  - Add make test-node target for running node-based tests without browser tests.
  - Update backup archive regex and backup serialization cleanup (skip oldTabId, ignore root-as-child).
  - Add documentation links to the Options page.
  - Highlight the focused browser window in the tree by tracking window focus state.
- 2026-01-07:
  - Persist window geometry/state/incognito and update bounds changes.
  - Document IndexedDB persistence details for maintainers.
  - Add direct mutation persistence plus a reconcile pass to improve background resilience.
  - Add a configurable reconcile interval.
  - Fix and enhance Shift+Up/Shift+Down move behavior (prevent sibling skipping, stay at sibling level, handle ancestors, add nesting toggles and inverted shortcuts, move loaded tabs to previous loaded window).
  - Implement Shift+PageDown to move nodes at the same level without nesting.
  - Fix Shift+Up promotion to avoid jumping to the window root when a sibling branch exists.
  - Paste marked nodes in tree order instead of mark order.
- 2026-01-06: 
  - Sanitize client IDs in Options/background and note it in the Options UI.
  - Add client ID flow integration coverage and options form tests.
  - Prevent ID generator collisions across restarts and document ID flow.
  - Add cache-busting imports for browser tests and extend ID generator tests.
  - Skip self-emitted tree messages to avoid double-applied deletes.
  - Trigger overdue backups on startup and store last backup time.
  - Add backup startup behavior toggle in Options.
  - Avoid redundant tab moves when the tab is already in place.
  - Persist tab attachment when matching windows.
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
