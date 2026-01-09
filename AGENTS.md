# AGENTS.md – Developer Guide

Technical documentation for developers or LLMs working on **Ignat's Copy of TK's Tree Style Tab Outliner (ICTKTSTO)** – a browser extension that combines tree-style tabs, bookmarks, notes, and session management.

## Project Overview

TKTSTO is a **Manifest V3 browser extension** that provides:
- Tree-style tab management in a sidebar panel
- Persistent session storage across browser restarts
- Cross-browser compatibility (Chrome, Firefox, Edge, Brave, Vivaldi)
- Local backups and future sync capabilities

When working on tasks, fix obvious logic errors you notice along the way, and
add tests for them when practical.

**License:** AGPL-3.0-or-later  
**Language:** Vanilla JavaScript (ES modules, no build tools or npm dependencies)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Extension                         │
├─────────────────────────────────────────────────────────────────┤
│  Service Worker (bkgd/)         │  Side Panel UI (view/)        │
│  ─────────────────────────────  │  ─────────────────────────────│
│  • bkgd.js (main entry)         │  • sidepanel.html             │
│  • treestore.js (TreeStore)     │  • view.js (entry point)      │
│  • nodestore.js (NodeStore)     │  • treeview.js (TreeView)     │
│  • idb.js (IndexedDB)           │  • nodeview.js (NodeView)     │
│  • sidepanel.js                 │                               │
│  • new-user.js (tutorial)       │                               │
├─────────────────────────────────┴───────────────────────────────┤
│                      Shared Code (common/)                       │
│  • tree.js (Tree base class)    • node.js (Node base class)     │
│  • common.js (utilities)        • events.js (event helpers)     │
│  • dialog.js (modal dialogs)    • mutex.js (async locks)        │
│  • id-generator.js              • base32.js (encoding)          │
├─────────────────────────────────────────────────────────────────┤
│  api.js – Browser compatibility shim (chrome vs browser API)    │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Patterns

1. **Class Inheritance Chain:**
   - `Node` (common/node.js) → `NodeStore` (bkgd/) → persists to IndexedDB
   - `Node` (common/node.js) → `NodeView` (view/) → renders DOM
   - `Tree` (common/tree.js) → `TreeStore` (bkgd/) → manages background tree
   - `Tree` (common/tree.js) → `TreeView` (view/) → manages UI tree

2. **Communication:** Service worker and side panel communicate via `chrome.runtime.sendMessage()` and ports. The `emit()` function in `common/common.js` handles message passing.

3. **Storage:** Tree data persists in **IndexedDB** (managed by `bkgd/idb.js`). Configuration uses `chrome.storage.local`.

---

## Directory Structure

```
/
├── api.js              # Browser API shim (chrome vs browser)
├── manifest.json       # Chrome/Chromium manifest
├── manifest-ff.json    # Firefox-specific manifest
├── Makefile            # Build commands
├── make-zip.sh         # Packaging script
│
├── bkgd/               # Background service worker
│   ├── bkgd.js         # Main entry point, event listeners
│   ├── treestore.js    # TreeStore class (Tree + IndexedDB persistence)
│   ├── nodestore.js    # NodeStore class (Node + DB save/load)
│   ├── idb.js          # IndexedDB wrapper (TKTSTO database)
│   ├── sidepanel.js    # Side panel lifecycle management
│   └── new-user.js     # Tutorial node generation
│
├── common/             # Shared code (used by both bkgd and view)
│   ├── common.js       # Logging, emit(), date formatting, utilities
│   ├── tree.js         # Base Tree class
│   ├── node.js         # Base Node class (1400+ lines)
│   ├── events.js       # Event name builder for keyboard/mouse
│   ├── dialog.js       # Modal dialog helpers
│   ├── mutex.js        # Async mutex for concurrency control
│   ├── id-generator.js # Unique ID generation
│   └── base32.js       # Base32 encoding for IDs
│
├── view/               # Side panel UI
│   ├── sidepanel.html  # Side panel HTML
│   ├── sidepanel.css   # Side panel styles
│   ├── view.js         # Entry point, initializes TreeView
│   ├── treeview.js     # TreeView class (UI tree, keyboard/mouse handling)
│   └── nodeview.js     # NodeView class (DOM rendering for nodes)
│
├── options/            # Extension options page
│   ├── options.html
│   └── options.js
│
├── themes/             # CSS themes
│   ├── tk.css          # Base theme
│   ├── tk-day.css      # Light theme variant
│   └── tk-night.css    # Dark theme variant
│
├── docs/               # Help pages
│   └── *.html
│
├── img/                # Icons (16, 32, 48, 64, 128 px)
│
├── bin/                # Development scripts
│   ├── firefox-sign.sh # Sign for Firefox (requires AMO credentials)
│   ├── update-version.sh
│   └── *.py            # Utility scripts
│
├── tests/              # Unit tests (browser-based)
│   ├── dom-safety.test.html  # DOM safety/XSS prevention tests
│   └── tree-node.test.html   # Tree/Node behavior tests
│
└── build/              # Generated during build (git-ignored)
    └── ...
```

---

## Core Classes

### Node (`common/node.js`)
The fundamental unit of the tree. Each node represents a tab, window, folder, or note.

**Key Properties:**
- `id` – Unique identifier (base32 encoded)
- `type` – `''` (generic), `'window'`, or `'tab'`
- `parent` / `nodes[]` – Tree structure
- `label` / `note` / `title` / `url` – Content
- `windowId` / `tabId` – Browser attachment (when loaded)
- `expanded` / `loaded` / `active` / `marked` – State flags
- `checkbox` / `checkboxPx` – Task status
- `ctime` / `mtime` / `atime` / `ltime` – Timestamps

**Key Methods:**
- `toDict()` / `fromDict()` – Serialization
- `addChild()` – Create child node
- `deleteSelf()` – Remove node and close associated tab
- `moveTo()` – Relocate in tree
- `load()` / `unload()` – Open/close browser tab
- `setMarked()` – Mark for batch operations

### Tree (`common/tree.js`)
Container for all nodes with tree-wide operations.

**Key Properties:**
- `root` – Root node
- `nodes{}` – Cache of all nodes by ID
- `markedNodes[]` – Currently marked node IDs
- `dictable[]` – Fields to serialize

**Key Methods:**
- `loadTreeFromBkgd()` – Fetch tree state from service worker
- `unmarkAll()` – Clear all marks
- `nodeMarkChanged()` – Track mark state

### TreeStore (`bkgd/treestore.js`)
Background tree with IndexedDB persistence. Extends `Tree`.

### TreeView (`view/treeview.js`)
UI tree with DOM rendering and input handling. Extends `Tree`.

**Key Features:**
- Keyboard bindings (`keyBindings` map)
- Mouse bindings (`mouseBindings` map)
- Drag-and-drop support
- Cursor navigation

### NodeStore / NodeView
Specialized Node subclasses for background persistence and UI rendering respectively.

---

## Data Flow

### Startup Sequence
1. Browser loads service worker (`bkgd/bkgd.js`)
2. `Bkgd.init()` runs:
   - Registers all event listeners immediately (before async work)
   - Loads config from `storage.local`
   - Creates `TreeStore` and loads from IndexedDB
   - Merges open browser windows/tabs into tree
   - Generates tutorial nodes if first run
3. When side panel opens:
   - `view/view.js` creates `TreeView`
   - `TreeView` requests full tree from service worker
   - Renders tree to DOM

### Message Protocol
Communication uses `emit()` which wraps `chrome.runtime.sendMessage()`:

```javascript
// From view to background
const response = await emit('bkgd_getTree');

// Message names follow pattern:
// - bkgd_* : requests to background
// - tree_* : tree state notifications
```

### IndexedDB Schema
Database name: `TKTSTO`

| Object Store | Key | Purpose |
|-------------|-----|---------|
| `Nodes` | node ID | Individual node data (JSON) |
| `Snapshots` | session name | Full tree snapshots |
| `Transactions` | key | Transaction log (future) |

---

## Browser Compatibility

The `api.js` shim provides cross-browser support:

```javascript
export const isFirefox = (typeof browser !== 'undefined');
export const isChrome = (!isFirefox);
export const api = isFirefox ? browser : chrome;
```

**Tested Browsers:**
- Firefox ESR 115, 128
- Chromium 134+
- Edge 136+
- Vivaldi 7.3+
- Brave 1.78+

**Key Differences:**
- Firefox uses `browser.*` API, Chromium uses `chrome.*`
- Firefox requires separate manifest (`manifest-ff.json`)
- Some APIs missing in older Firefox (e.g., `windows.onBoundsChanged`)

---

## Build & Development

### Prerequisites
- `make` and `zip` (for Firefox builds)
- Git (for source management)

### Commands

```bash
# Build for both browsers
make all

# Build Firefox .zip only
make firefox-zip

# Build Chrome/Chromium .zip only
make chrome-zip

# Sign Firefox extension (requires AMO credentials in .env)
make firefox-sign

# Find TODOs in source
make todo
```

### Firefox Signing
Create `.env` with AMO credentials:
```
JWT_ISSUER=your_api_key
JWT_SECRET=your_api_secret
```
Get credentials from https://addons.mozilla.org/developers/

### Loading for Development

**Chrome/Chromium:**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select repository root folder

**Firefox:**
1. Run `make firefox-zip`
2. Go to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `dist/tktsto-*.zip`

---

## Key Configuration

Stored in `chrome.storage.local`:

| Key | Type | Description |
|-----|------|-------------|
| `clientId` | string | Alphanumeric identifier for this client; non-alphanumerics stripped |
| `theme` | string | Selected theme name |
| `localBackupInterval` | number | Auto-backup interval in minutes |
| `humanFriendlyBackups` | boolean | Pretty-print backup JSON |
| `backupOnStartup` | boolean | Run overdue backups on startup |
| `expandedRowPrefix` | boolean | Show expand/collapse indicators |
| `openWindowOnRootMove` | boolean | Open new window when moving subtree to root |
| `openWindowOnRootLoadTopmost` | boolean | Wrap top-most ungrouped parent when loading from root |
| `reorderTabsOnCreate` | boolean | Reorder new tabs to match tree layout |
| `reconcileIntervalMinutes` | number | Periodic reconcile interval in minutes (0 disables) |
| `opsBacklogWarnThreshold` | number | Pending ops threshold for backlog warning (0 disables) |
| `moveDownIntoExpandedSibling` | boolean | Shift+Down nests into expanded sibling when enabled |
| `moveUpIntoExpandedSibling` | boolean | Shift+Up nests into expanded sibling when enabled |

---

## Extension Permissions

From `manifest.json`:

| Permission | Purpose |
|-----------|---------|
| `sidePanel` | Show tree in browser sidebar |
| `storage` | Persist settings |
| `downloads` | Save backup files |
| `tabs` | Monitor and control browser tabs |
| `alarms` | Schedule periodic backups |
| `favicon` | Display tab favicons |

Optional:
- `clipboardRead/Write` – Copy/paste operations
- `<all_urls>` – Access tab content (for notes feature)

---

## Common Development Tasks

### Adding a New Keyboard Shortcut

1. Add binding in `view/treeview.js` → `keyBindings` object:
   ```javascript
   'Ctrl+X': 'myNewAction',
   ```

2. Implement handler method in `TreeView` class:
   ```javascript
   async myNewAction() {
     // implementation
   }
   ```

### Adding a New Node Property

1. Add property to `Node` constructor (`common/node.js`)
2. Add to `dictable[]` array in `Tree` (`common/tree.js`)
3. Update `NodeView.$render()` if it affects display
4. Update `NodeStore` if it needs persistence

### Adding a New Configuration Option

1. Add UI in `options/options.html`
2. Add load/save logic in `options/options.js`
3. Read setting where needed via `api.storage.local.get()`

---

## Debugging Tips

1. **Service Worker Logs:** Open browser DevTools → Application → Service Workers → Inspect

2. **Side Panel Logs:** Right-click side panel → Inspect

3. **IndexedDB Inspection:** DevTools → Application → IndexedDB → TKTSTO

4. **Enable Verbose Logging:** The `debug()` function in `common/common.js` logs to console

5. **Message Tracing:** All `emit()` calls log their message name except for `bkgd_ping`

---

## Code Style & Conventions

This project uses **vanilla JavaScript ES modules** with no transpilation or bundlers. Follow these conventions to maintain consistency.

### General Style

```javascript
// Use strict mode in every file
"use strict";

// ES module imports at top of file, absolute paths from root
import { api, isChrome, isFirefox } from '/api.js';
import { log, debug, warn, error } from '/common/common.js';

// Class-based OOP pattern
export class MyClass {
  constructor() {
    // Initialize properties
    this.myProperty = null;
  }

  async myMethod(args) {
    // Implementation
  }
}
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `TreeView`, `NodeStore` |
| Functions/Methods | camelCase | `loadTreeFromBkgd()`, `deleteSelf()` |
| Variables | camelCase | `markedNodes`, `windowId` |
| Constants | camelCase or UPPER_SNAKE | `jsonSchema`, `dbSchemaNum` |
| DOM elements | `$` prefix | `this.$row`, `this.$nodes` |
| Private-ish | no prefix (JS has no private) | document intent via comments |
| Event handlers | `on` prefix | `onTabCreated()`, `onMessage()` |

### File Organization

Each file should:
1. Start with copyright header and SPDX license identifier
2. Have `"use strict";` directive
3. Import dependencies (absolute paths from extension root)
4. Export classes/functions at definition
5. Keep related functionality together

```javascript
// example/myfile.js: brief description
// Copyright (C) 2025 Contributor Name
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api } from '/api.js';
import { log } from '/common/common.js';

export class MyClass { ... }
export function myHelper() { ... }
```

### Async/Await Patterns

- Prefer `async/await` over `.then()` chains
- Use `Promise` for IndexedDB and browser API callbacks
- Handle errors with try/catch or let them propagate

```javascript
async loadData() {
  try {
    const result = await api.storage.local.get('key');
    return result.key;
  } catch (err) {
    error('Failed to load:', err);
    return null;
  }
}
```

### Comments & Documentation

- Use `//` for single-line comments
- Use JSDoc-style for complex functions (optional but encouraged)
- Mark incomplete work with `TODO:` or `FIXME:`
- Run `make todo` to find all TODOs in the codebase

```javascript
// TODO: implement undo functionality
// FIXME: race condition when rapidly clicking

/**
 * Move node to a new parent at specified index.
 * @param {Node} destParent - Target parent node
 * @param {number} destIndex - Position in parent's children
 * @param {Object} args - Reason and metadata
 */
async moveTo(destParent, destIndex, args) { ... }
```

---

## Formatting Guidelines

No automated formatter is configured. Follow these manual guidelines:

### Indentation & Spacing

- **2 spaces** for indentation (no tabs)
- Space after keywords: `if (`, `for (`, `while (`
- Space around operators: `a + b`, `x === y`
- No space before function parens: `myFunc()`
- Opening brace on same line

```javascript
// Good
if (condition) {
  doSomething();
} else {
  doOther();
}

// Bad
if(condition){
    doSomething();
}
```

### Line Length

- Soft limit: ~80-100 characters
- Break long lines at logical points

```javascript
// Break long function calls
const result = await someVeryLongFunctionName(
  firstArgument,
  secondArgument,
  { option: value }
);

// Break long conditions
if (condition1 &&
    condition2 &&
    condition3) {
  // ...
}
```

### Strings

- Prefer single quotes for strings: `'hello'`
- Use template literals for interpolation: `` `Value: ${x}` ``
- Use backticks for multi-line strings

---

## Linting (Recommendations)

No linter is currently configured. If adding one, consider:

### ESLint Setup (Optional)

```bash
# Install (if npm is added later)
npm init -y
npm install --save-dev eslint

# Suggested .eslintrc.js
module.exports = {
  env: {
    browser: true,
    es2022: true,
    webextensions: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': 'warn',
    'no-undef': 'error',
    'semi': ['error', 'always'],
    'quotes': ['warn', 'single'],
  },
  globals: {
    chrome: 'readonly',
    browser: 'readonly',
  },
};
```

### Manual Linting Checklist

Before committing, verify:
- [ ] No `console.log()` left in production code (use `debug()`, `log()`, etc.)
- [ ] All variables declared with `const` or `let` (never `var`)
- [ ] Async functions have proper error handling
- [ ] Browser APIs accessed via `api.*` shim (not `chrome.*` or `browser.*` directly)
- [ ] New files have copyright header and `"use strict";`

---

## Testing

### Unit Tests

#### Browser-based tests

Browser-based tests live in `tests/`. Run them with `make test` (starts a local HTTP server and opens the pages), or open the test pages via `http://` (module-based tests won't run from `file://` due to browser CORS rules).

| Test File | Purpose |
|-----------|----------|
| `dom-safety.test.html` | Tests for XSS prevention - verifies that DOM rendering uses safe methods (`textContent`, `createElement`) instead of `innerHTML` |
| `tree-node.test.html` | Tests for Tree/Node behavior, plus shared utilities and options form sanitization |
| `client-id-flow.test.html` | Tests for the background client ID handler, storage updates, and IdGenerator state |
| `merge-open-windows.test.html` | Tests for mergeOpenWindowsIntoTree matching across browsers |
| `treeview-actions.test.html` | Tests for TreeView actions (delete/unwrap/move behavior) |

`tree-node.test.html`, `merge-open-windows.test.html`, and `treeview-actions.test.html` support `?env=firefox` and `?env=chrome` to force browser-specific rules; otherwise they auto-detect via user agent.

#### Node-based tests and coverage

`tests/node/` provides a Node-based runner for core modules with API stubs.

- Run `node tests/node/run-tests.mjs` for quick checks.
- Run `make coverage` to collect V8 coverage and update the badge in `readme.md`.

#### Writing New Tests

Tests use a simple framework defined in each test file:

```javascript
test('description of what is being tested', () => {
  // Arrange
  const $elem = document.createElement('div');
  
  // Act
  $elem.textContent = '<b>should be escaped</b>';
  
  // Assert
  assert($elem.querySelector('b') === null, 'HTML should not be parsed');
  assertEqual($elem.textContent, '<b>should be escaped</b>');
});
```

For browser tests that touch `api.*`, mock `window.browser`/`window.chrome` before importing modules (see `tests/client-id-flow.test.html`).
For Node-based tests, follow `tests/node/run-tests.mjs` and update coverage if you add new core cases.

**Guidelines for test payloads:**
- Avoid using actual `alert()` calls in test strings
- When testing `<script>` tag escaping, split the string: `'<scr' + 'ipt>'` to prevent the browser from interpreting it as closing the main script block
- Use harmless HTML tags (`<b>`, `<em>`, `<div>`) to test escaping behavior
- Use global flags (`window.testFlag`) to verify code didn't execute

### Manual Testing Checklist

Before releasing:

1. **Basic Functionality**
   - [ ] Extension loads without errors
   - [ ] Side panel opens and displays tree
   - [ ] Client ID sanitizes on blur and rejects empty input in Options
   - [ ] Can create, edit, delete nodes
   - [ ] Can load/unload tabs
   - [ ] Drag-and-drop works
   - [ ] Keyboard shortcuts work

2. **Persistence**
   - [ ] Tree survives browser restart
   - [ ] Backups can be created and downloaded
   - [ ] Data loads correctly from IndexedDB

3. **Cross-Browser**
   - [ ] Test in Chrome/Chromium
   - [ ] Test in Firefox (both ESR versions)
   - [ ] Test in at least one other browser (Edge, Brave, Vivaldi)

4. **Edge Cases**
   - [ ] Many tabs (100+) performs acceptably
   - [ ] Deep nesting works correctly
   - [ ] Special URLs handled gracefully

### Browser DevTools Testing

```javascript
// In side panel console - inspect tree state
const tree = document.querySelector('#tree-view').__tree;
console.log(tree.nodes);
console.log(tree.markedNodes);

// In service worker console - inspect background state
console.log(bkgd.tree.nodes);
```

### Future Testing Recommendations

Areas that could benefit from additional test coverage:

1. **Unit Tests** - Expand core class coverage in Node-based tests
2. **Integration Tests** - Grow message-passing coverage beyond client ID flows
3. **E2E Tests** - Use Puppeteer/Playwright for browser automation

New test files should follow the pattern established in `tests/dom-safety.test.html`:
- Self-contained HTML file with embedded `<script type="module">`
- Uses the simple `test()`, `assert()`, `assertEqual()` framework
- Renders results to the page and logs to console
- Can be run by simply opening in a browser (use `http://` if importing modules)

---

## Developer Experience

### IDE Setup

**VS Code Recommended Extensions:**
- ESLint (if configured)
- EditorConfig (if `.editorconfig` added)
- Debugger for Chrome/Firefox

**Recommended `settings.json`:**
```json
{
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "files.eol": "\n",
  "javascript.preferences.quoteStyle": "single"
}
```

### Quick Development Workflow

1. **Make changes** to source files
2. **Reload extension:**
   - Chrome: Click refresh icon on `chrome://extensions`
   - Firefox: Click "Reload" on `about:debugging` page
3. **Reload side panel:** Close and reopen, or right-click → Inspect → Ctrl+R
4. **Check for errors** in both DevTools consoles (service worker + side panel)

### Hot Reload Tips

- Service worker changes require extension reload
- Side panel CSS/JS changes often only need panel reload
- IndexedDB schema changes may require clearing extension data

### Common Development Gotchas

1. **Service Worker Lifecycle**
   - Service workers can be killed by browser when idle
   - Use `emit()` with retry logic (already implemented)
   - Register event listeners synchronously in `init()`

2. **Message Serialization**
   - Objects with methods can't be sent via `sendMessage()`
   - Always use `toDict()` before sending Node/Tree objects
   - Restore with `fromDict()` on receiving end

3. **Cross-Browser Differences**
   - Always use `api.*` instead of `chrome.*` or `browser.*`
   - Check for API existence before using: `if (api.windows.onBoundsChanged)`
   - Firefox manifest differs from Chrome manifest

4. **IndexedDB Transactions**
   - Transactions auto-close when no pending operations
   - Can't reuse transactions across await boundaries
   - Each operation creates a new transaction (by design)

### Useful Debug Commands

```javascript
// Check extension state
api.storage.local.get(null).then(console.log);

// Force backup
emit('bkgd_backupSession');

// Get all node IDs
Object.keys(tree.nodes);

// Find node by partial label
Object.values(tree.nodes).filter(n => n.label?.includes('search'));
```

### Performance Profiling

1. Open DevTools → Performance tab
2. Record while performing action
3. Look for long tasks, layout thrashing
4. Key areas to watch:
   - Tree rendering (`$render()`)
   - IndexedDB operations
   - DOM updates during drag-and-drop

---

## Git Workflow

### Branch Strategy

- `trunk` - Main development branch
- Feature branches as needed

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

#### Types

| Type | Description |
|------|-------------|
| `feat` | New feature or functionality |
| `fix` | Bug fix |
| `docs` | Documentation changes only (README, ChangeLog, docs/, and tutorial copy in `bkgd/new-user.js` when user-facing) |
| `style` | Code style (formatting, whitespace, semicolons) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependencies |
| `ci` | CI configuration files and scripts |
| `chore` | Other changes that don't modify src or test files |
| `revert` | Reverts a previous commit |

#### Scopes (Optional)

Use to specify what area of the codebase is affected:

- `bkgd` - Background service worker
- `view` - Side panel UI
- `tree` - Tree/Node core logic
- `idb` - IndexedDB storage
- `options` - Options page
- `themes` - CSS themes
- `manifest` - Extension manifest
- `build` - Build scripts

#### Examples

```bash
# Feature
feat(view): add keyboard shortcut for marking all siblings

# Bug fix
fix(bkgd): prevent duplicate tabs when restoring crashed session

# Bug fix with issue reference
fix(tree): handle orphaned nodes on startup

Closes #42

# Breaking change (use ! or BREAKING CHANGE footer)
feat(idb)!: change IndexedDB schema to v2

BREAKING CHANGE: Existing data requires migration.
Run the migration script before updating.

# Documentation
docs: update AGENTS.md with testing guidelines

# Refactor with scope
refactor(node): extract checkbox logic into separate method

# Style change
style: fix inconsistent indentation in treeview.js

# Chore
chore: update manifest version to 0.0.2.0
```

#### Guidelines

1. **Use imperative mood** in description: "add feature" not "added feature"
2. **Don't capitalize** first letter of description
3. **No period** at the end of the subject line
4. **Keep subject line under 72 characters**
5. **Separate subject from body** with a blank line
6. **Use body to explain what and why** (not how)
7. **Reference issues** in footer when applicable
8. **Do not hard-wrap body lines**; keep paragraphs as single lines unless a list item or code block

#### Multi-line Commits

For complex changes, include a body:

```
fix(tree): prevent data loss when moving nodes between windows

The previous implementation could lose child nodes when moving a parent node to a different window during high tab activity.

This fix:
- Adds mutex lock during move operations
- Saves all affected nodes before emitting events
- Validates parent-child relationships after move

Closes #123
```

### Pre-Commit Checklist

- [ ] Code follows style conventions
- [ ] No debug statements left in
- [ ] Tested in at least one browser
- [ ] `make todo` checked for any new TODOs added
- [ ] Build still works: `make all`

---

## Known Limitations

- Pinned tabs not supported (for now)
- Tab groups not supported (for now)
- Vivaldi stacked tabs incompatible
- Extension shortcuts affect all open views in same window
- Firefox cannot access `file:`, `about:`, or other extension URLs

---

## Resources

- **README:** Project overview, installation, usage
- **ChangeLog.md:** Version history and known issues
- **docs/:** User-facing help documentation
- **Original inspiration:** Tabs Outliner (proprietary, now replaced)
