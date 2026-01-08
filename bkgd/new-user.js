// bkgd/new-user.js: new user tutorial factory
// Copyright (C) 2025 Selene ToyKeeper & Ignat Remizov
// SPDX-License-Identifier: AGPL-3.0-or-later

"use strict";
import { api, isChrome, isFirefox } from '/api.js';

import { TreeView } from '/view/treeview.js';


export async function createNewUserTutorialNodes (tree, parentNode) {
  const root = tree.root;
  // build a list of keyBindngs
  const tv = new TreeView();
  await tv.updateKeyBindings();
  const keymapInfo = [
  ];
  for (const key of Object.keys(tv.keyBindngs)) {
    const value = tv.keyBindngs[key];
    if ('none' !== value)
      keymapInfo.push({ label: `${key} : ${value}` });
  }
  // define the help nodes
  const helpInfo = { label: 'Welcome, new user!', nodes: [
    { label: 'Click in this panel to focus it' },
    { label: 'Then use arrow keys to move the cursor' },
    { label: '... and Space to expand branches', expanded: false, nodes: [
      { label: 'Just like that!' },
      { label: 'Or click the left end of a row' },
    ]},
    { label: 'Longer notes can be seen below',
      note: 'Right here.  Be sure to check this area any time you see an "attachment" icon on the cursor row.' },
    { label: "Here are the other key bindings", expanded: false,
      note: "Don't worry about the details yet, these are here for later reference.",
      nodes: [ ...keymapInfo ]},
    { label: 'Green text is a "label"',
      note: 'To edit it, hover the mouse over a row and click the "E" button in the "hover menu".  Or press the "E" key on the keyboard.\n\nTry editing thsis to fffix my typooooz.'
    },
    { title: 'Grey text is an unloaded tab', loaded: false,
      note: 'To open it, double click it or press Enter while the cursor is on it.\n\nThink of it like a "bookmark" which knows which window it goes in, and where it belongs in the tab bar.  It uses no RAM or CPU while it is unloaded.',
      url: '/docs/tutorial-grey-text.html' },
    { label: 'Tutorial Window', type: 'window', loaded: false,
      note: 'This is a saved window.  Double click it to open it!',
      expanded: true,
      nodes: [
        { title: 'Pink tabs auto-open when the saved window is restored', loaded: false,
          wasLoaded: true, url: '/docs/wasloaded-tab.html' },
        { title: 'Grey text is an unloaded tab', loaded: false,
          url: '/docs/tutorial-grey-text.html' },
        { label: 'You may have also noticed...',
          note: `... that you can nest "window" nodes.  This window node is inside of another, and it still works.  It allows you to group related windows together if you want... but you don't have to.` },
      ]},
    { expanded: false,
      title: 'Moving nodes is easy',
      url: '/docs/moving-nodes.html',
      note: 'Open this tab to find out how\n\nYou remember how to open an unloaded tab, right?\n\n... right??' },
    { label: 'Moving nodes to the top level',
      note: 'If you enable the option to open a new window when moving a subtree to the top level, TKTSTO will open a new window for loaded tabs.  When you move the only child of a window, the window container moves with it instead of reopening the same window.' },
    { label: 'Window wrapping playground', expanded: false,
      note: 'Try the "W" hover button on the nodes below to wrap tabs into windows, convert labels into windows, and convert windows back into labels.  Then load/unload tabs and move things around to see how windows follow the tree.',
      nodes: [
        { label: 'Group A', nodes: [
          { title: 'Example Domain', url: 'https://example.com/', loaded: false },
          { title: 'Example Domain (child)', url: 'https://example.com/', loaded: false }
        ]},
        { label: 'Group B', nodes: [
          { label: 'Nested Group', nodes: [
            { title: 'Example Domain', url: 'https://example.com/', loaded: false }
          ]}
        ]}
      ]},
    { label: 'Window delete + unwrap tips', expanded: false,
      note: 'Press "D" on a window node.  If it is expanded and loaded, it unloads (closes the window) but keeps tabs in the tree as wasLoaded.  If it is collapsed and loaded, you will be asked to confirm closing the window and deleting its tabs.  Deleting an unloaded window simply unwraps it.\n\nIf the window has ancestor windows, delete will keep loaded tabs by merging into the nearest ancestor window, creating one if not found.',
      nodes: [
        { label: 'Loaded Window (expanded)', type: 'window', loaded: false, expanded: true,
          note: 'Open this window, then press "D" to unwrap its children without closing tabs.',
          nodes: [
            { title: 'Example Domain', url: 'https://example.com/', loaded: false },
            { title: 'Example Domain (child)', url: 'https://example.com/', loaded: false }
          ]},
        { label: 'Loaded Window (collapsed)', type: 'window', loaded: false, expanded: false,
          note: 'Open this window, collapse it, then press "D" to see the confirmation.',
          nodes: [
            { title: 'Example Domain', url: 'https://example.com/', loaded: false }
          ]}
      ]},
    { label: 'Checkboxes', expanded: false,
      title: 'Double click me',
      url: '/docs/checkboxes.html',
      nodes: [
        { label: 'Groceries', checkbox: '%', nodes: [
          { label: 'Unsorted', nodes: [
            { label: 'Ice cream', checkbox: ' ' },
            { label: 'Soup', checkbox: ' ' },
            { label: 'Popsicles', checkbox: ' ' },
            { label: 'Milk', checkbox: ' ' },
            { label: 'Crackers', checkbox: ' ' },
          ]},
          { label: 'Dry / Canned', checkbox: '%', nodes: [
            { label: 'Cereal', checkbox: ' ' },
          ]},
          { label: 'Cold aisle', checkbox: '%', nodes: [
            { label: 'Cheese', checkbox: '!' },
          ]},
          { label: 'Frozen', checkbox: '%', nodes: [
            { label: 'Pizzas', checkbox: ' ' },
          ]},
        ]},
      ]},
    { label: "Be sure to check the",
      title: 'Options',
      url: '/options/options.html',
      note: 'to choose a theme, set your host name, configure shortcuts, and tweak everything else to your liking.\n\nYou can also choose whether moving a subtree to the top level opens a new window.  If you move the only child of a window, the window container moves with it instead.\n\nIf your browser already opens new tabs next to the current tab, disable "Reorder browser tabs to match the tree" in Options so the tree mirrors the browser’s tab order.\n\nPrefer double-click / Enter on an already focused tab to refocus its window instead of editing?  There is an option for that too.\n\nShift+Up and Shift+Down can optionally move into expanded siblings; each direction has its own toggle if you prefer sibling-only moves.  Shift+PageUp and Shift+PageDown always move at the same level.  You can also assign custom shortcuts to invert the nesting behavior.  Loaded tabs at the top of a window will still hop into the previous loaded window when moving up.\n\nFirefox also has a separate "Manage Extension Shortcuts" page for global commands like Toggle Side Panel, Unload current tab, and Add highlighted text to current tab’s notes.' },
    { label: 'Shift+Up/Shift+Down playground',
      note: 'Safe-to-break branches and leaves.  Try Shift+Up and Shift+Down here (and with Shift+Alt+direction to flip behavior), or flip the Options toggles to compare behaviors.',
      nodes: [
        { label: 'Sibling shuffle (up/down)', expanded: true, nodes: [
          { label: 'Amiable Branch 🌿', expanded: true, nodes: [
            { label: 'Leaf: Alpine 🍃' },
            { label: 'Leaf: Amber 🍁' },
          ]},
          { label: 'Breezy Branch 🌿 (cursor here)', expanded: true, nodes: [
            { label: 'Leaf: Breeze 🍃' },
            { label: 'Leaf: Bramble 🍁' },
          ]},
          { label: 'Chaotic Branch 🌿', expanded: true, nodes: [
            { label: 'Leaf: Comet ☄️' },
          ]},
        ]},
        { label: 'Ancestor branch 🪵', expanded: true, nodes: [
          { label: 'Parent node 🪵', expanded: true, nodes: [
            { label: 'First child 🍁' },
            { label: 'Nested branch 🌿 (cursor here)', expanded: true, nodes: [
              { label: 'Nested leaf 🍃' },
            ]},
            { label: 'Last child 🍁' },
          ]},
        ]},
      ]},
    { label: "You're probably ready",
      note: 'to start organizing your REAL tabs and windows now.  As a first step, try giving a name to each of your windows.  Then maybe organize related tabs together, add some category labels, etc.  Tips and tricks are in the full documentation.' },
    { label: "The rest of the documentation...",
      note: '... is in the "Help" button at the bottom of the sidepanel.' },
    { label: `Also if you're REALLY cool, maybe try the "Donate" button`,
      note: `... if you like this free/open-source project and want to ensure it keeps getting updated.\n\n'cause, like, I need food and stuff.\n\nBut I understand if you don't donate; that's cool too.  Times are rough, and not all of us have spare cash.  But I gotta at least ask.\n\nPolitely.\n\nIn the hidden dark nethers of a tutorial you probably didn't even read.  If you got this far, you're already a hoopier frood than most.`,
      title: 'Donate',
      url: 'https://toykeeper.net/tktsto/donate' },
    { label: "Or join the Discord",
      note: 'Where tech-savvy folks chat about how to fight our corporate overlords, share useful tools for productivity, and generally just hang out to talk about whatever.',
      title: 'Discord : TKTSTO',
      url: 'https://toykeeper.net/tktsto/discord' },
    { label: "There's also GitHub",
      note: 'for github-y type stuff.  You know the drill.',
      title: 'GitHub : TKTSTO',
      url: 'https://toykeeper.net/tktsto/' },
    { label: "When you're done with this tutorial...",
      note: '... feel free to delete it.  First collapse it, then press the red "D" button in the hover menu, or type the letter "D".\n\nYou can generate the tutorial again by pressing "?" on the keyboard.\n\nNote: Deleting the branch will also close and delete any tabs or windows remaining inside the tutorial branch.  Move those first if you want to keep anything.' },
  ]};

  async function addItem (parent, index, details) {
    const newNode = await parent.addChild(index, details,
      { reason: 'tutorial' });
    if (details.nodes) {
      let i = 0;
      for (const kid of details.nodes) {
        await addItem(newNode, i, kid);
        i ++;
      }
    }
  }

  let destParent = tree.root.nodes[0];
  if (parentNode) destParent = parentNode;
  if (! destParent) destParent = tree.root;
  await addItem(destParent, 0, helpInfo);
}
