# OutSystems Event Tracer (Chrome DevTools) — v0.6

A Chrome extension that adds an **OS Events** tab to DevTools. In OutSystems Reactive apps (O11 and ODC) it shows, for each interaction:

- **Trigger Event** from a block → the handler in the parent (also when events travel up through several blocks or placeholders)
- **Event inputs** (for example `LineItemLocation_Fields = {...}`)
- The actions that ran, with **screen/block variables before and after** (changes highlighted)
- Action inputs, locals and outputs
- Server calls (server actions, data actions, aggregates) with their duration
- **Live variables**: every mounted screen/block and its current variables

## Install

1. Unzip into a folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder (the one that contains `manifest.json`).
4. Open the OutSystems app, open DevTools (F12) and go to the **OS Events** tab.
5. If the page was already open before you installed the extension, reload it (F5).

When updating from an older version, remove the old one first (or press ↻ on its card), then reload the app page.

## Flow tab

### Chain view (default)

Each interaction is a card drawn like a sequence diagram:

- **Columns** = the screens/blocks involved, in the order they join the flow.
- **▶** = what started the flow (for example `Button OnClick`).
- **●** = an action, in the column of its owner, with the variables it changed. `↳` = an action called by another action.
- **⚡ arrow** = a Trigger Event, from the block to the parent that handles it, with its inputs.
- **⇄** = a server call.

### Tree view

The same data as a call tree. Useful for deep nesting.

### Search

The search box looks at action, event, block and module names **and at variable names**, including nested ones (`AS_GetLocationDisplay`, `Geo`, …) in inputs, parameters, locals, outputs and before/after variables. Tick **values** to search values as well.

- Matching steps are highlighted and the text is marked.
- **Enter** / **Shift+Enter** go to the next / previous match. The counter shows how many there are.

### Following one chain when many things happen at once

- **Hover** a step: its whole lineage (causes and effects) is highlighted and everything else fades.
- **Double-click** a step, press **F**, or click **🎯 Follow this chain** in the details: only that flow is shown, unrelated steps are dimmed (or hidden, with *hide unrelated steps*), and a breadcrumb at the top shows the path. **Esc** or **✕ Stop following** exits.
- **Keyboard**: ↑/↓ previous/next step, ← go to the cause (or collapse), → first effect (or expand).
- The details panel also has **Filter by <block>** and **Live variables** (jump to that block's current variables).

Other options: *hide lifecycle*, *hide fetches*, *only flows with events*, *snapshots* (capture variables before/after), *preserve log* across reloads, **Export** to JSON.

## Live variables tab

- A tree of mounted screens and blocks (screen › layout › block …) with their current variables.
- **Search** finds block names *and* variable names at any depth (and values, while *values* is ticked — on by default). Searching a block shows the block with all its variables. Searching a variable shows only the variables that contain it, expanded to the match; *Show all N variables* shows the rest. **Enter** / ▲▼ move between matches.
- Hover a block → it is highlighted in the page. **⌖ Show in page** scrolls to it. **⚡ Flows** filters the Flow tab by it.

### Block picker (like the Elements inspector)

Click the **arrow button** at the top left, then hover the page: each block is outlined with its name (and the widget name, e.g. `DropOff`). Click to pick it. The panel opens Live variables on that block, with a breadcrumb from the screen down to it. **Esc** cancels. The click is not passed to the app.

With **Sync with Elements panel** ticked, selecting an element in the Elements tab also jumps to its block.

## Debug mode (step by step)

Click **🐞 Debug**. A yellow bar appears with:

- **Pause on**: every step / every action entry / every Trigger Event / breakpoints only (add breakpoints from a step's details).
- *skip lifecycle*, *skip OutSystemsUI*.
- **⤵ Next step** (F10), **⏭ Run thread** (F9 — finish the current thread without pausing), **▶ Continue** (F8 — until the next pause point), **■ Exit**.

While paused, the details show the stack (across events, back to the original click) and the variables of the current block. The page stays frozen, but DevTools does **not** jump to Sources: the pause is a synchronous request that the extension holds and answers. Chrome shows a "started debugging this browser" bar while debug mode is on; that is expected.

The pause data never reaches the server: the page first sends an empty probe, and only if the extension answers it is the data sent. If the probe is not answered (DevTools closed, extension off), debug mode switches itself off.

## Dev vs production modules

- Modules compiled **with debug info** (dev): actions, nodes and breakpoints by node.
- Modules **without debug info** (production/optimized): the extension wraps the controller's actions, so actions, events, inputs and variables still show. Node-level steps and node breakpoints are not available; *every action entry* and *Trigger Event* pauses work.

## Limitations

- Tested against a simulated OutSystems runtime on real React 16 and 17, not against every Platform version. If something looks wrong, **Export** and send the JSON.
- Values are serialized with a depth/size limit; very large lists are truncated.
- Server action internals are not visible (only the call, its inputs and its duration).
- Chrome only (Manifest V3, Chrome 111+).
