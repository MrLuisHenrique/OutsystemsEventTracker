# OutSystems Event Tracer

A Chrome DevTools extension for following **event flows in OutSystems Reactive apps** (O11 and ODC).

In Reactive apps, blocks talk to their parents through events: block X triggers an event, block Y handles it, does some work and triggers another event that the screen handles. Service Studio's debugger shows one action at a time, which makes these chains hard to follow. OutSystems Event Tracer records them as they happen and shows the whole flow, with event inputs and screen and block variables, in a new **OS Events** tab in DevTools.

![A flow in the Chain view](docs/flow-chain.png)

*Version 0.6.0 · Chrome 111 or later*

---

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [How to use](#how-to-use)
  - [Flow tab](#flow-tab)
  - [Following one chain](#following-one-chain)
  - [Search](#search)
  - [Live variables tab](#live-variables-tab)
  - [Block picker](#block-picker)
  - [Debug mode](#debug-mode-step-by-step)
  - [Keyboard shortcuts](#keyboard-shortcuts)
- [Documentation](#documentation)
  - [How it works](#how-it-works)
  - [Development vs production modules](#development-vs-production-modules)
  - [Permissions and privacy](#permissions-and-privacy)
  - [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Features

- **Event flows across blocks.** It shows each Trigger Event, from the block that fired it to the parent that handled it, including events that travel up through several blocks and through placeholders (layouts, cards…).
- **Event inputs.** It shows the values passed with each event.
- **Actions and variables.** For every action that runs, it shows the inputs, locals, outputs and the screen/block variables before and after, with changes highlighted.
- **Server calls.** It records server actions, data actions and aggregates, with their duration.
- **Two views.**
  - **Chain** is a sequence diagram with one column per block.
  - **Tree** is a call tree.
- **Follow one chain.** When many blocks fire events at the same time, you can isolate a single cause → effect line.
- **Search everything.** Search covers action, event and block names and variable names at any depth, and optionally values.
- **Live variables.** It lists every mounted screen and block with its current variables, as a tree.
- **Block picker.** Like the Elements inspector: click a block in the page and jump straight to its variables.
- **Debug mode.** You can pause the app and step through it: every step, every action entry, every Trigger Event, or breakpoints only. DevTools does not jump to the Sources tab.
- **Works in production.** It also works with modules compiled without debug information (see [below](#development-vs-production-modules)).

---

## Install

The extension is not on the Chrome Web Store. Install it from this repository:

1. **Download the code.** On this page click **Code → Download ZIP** and unzip it, or clone it:
   ```bash
   git clone https://github.com/MrLuisHenrique/OutsystemsEventTracker.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (switch at the top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. The extension now appears in the list. You can pin it, but it has no toolbar popup; everything happens in DevTools.

### Updating

1. Download or `git pull` the new version into the same folder.
2. In `chrome://extensions`, press **↻** (reload) on the extension's card.
3. Reload the app page and reopen DevTools.

### Uninstalling

Press **Remove** on the extension's card in `chrome://extensions`.

---

## Quick start

1. Open your OutSystems Reactive app.
2. Open DevTools (**F12** or **Ctrl+Shift+I** / **Cmd+Opt+I**) and select the **OS Events** tab. If you don't see it, look under the **»** menu.
3. If the page was already open before you installed the extension, **reload it (F5)**. The tracer must be loaded before the app starts.
4. The status bar at the bottom should say **● OutSystems detected**.
5. Interact with the app. Each interaction appears as a card in the **Flow** tab.
6. Click any step to see its details on the right.

---

## How to use

### Flow tab

Each user interaction (a click, an input change, a screen load…) becomes one **flow**.

#### Chain view (default)

The chain view is drawn like a sequence diagram:

| Symbol | Meaning |
|---|---|
| Columns | The screens and blocks involved, in the order they join the flow |
| **▶** | What started the flow (for example `OnClick`) |
| **●** | An action, in the column of the block that owns it, with the variables it changed (`LastKind: "Pickup" → "Dropoff"`) |
| **↳** | An action called by another action |
| **⚡ arrow** | A Trigger Event, from the block that fired it to the parent that handles it, with its inputs |
| **⇅** | A server call (server action, data action, aggregate) |

#### Tree view

The tree view shows the same data as a nested call tree. It is useful when flows are deep.

#### Details panel

Click a step to see:

- the block it belongs to and which block handled it (for events)
- event inputs, action inputs, locals and outputs
- screen/block variables before and after, with changes highlighted
- buttons:
  - **🎯 Follow this chain** isolates this flow (see below)
  - **Filter by \<block\>** shows only flows that involve this block
  - **Live variables** jumps to this block's current values
  - **○ Breakpoint** pauses here in debug mode

Values are shown as expandable JSON trees.

#### Toolbar options

| Option | What it does |
|---|---|
| **● Record** | Pause or resume recording |
| **⊘ Clear** | Remove everything recorded so far |
| **⇩ Export** | Save all records as JSON (useful for bug reports) |
| **Hide lifecycle** | Hide On Initialize / On Ready / On Render / On Parameters Changed / On Destroy |
| **Hide data fetch** | Hide automatic data fetches (aggregates, data actions) |
| **Only block events** | Show only flows that contain at least one Trigger Event |
| **Snapshots** | Capture variables before/after each action (turn off if the app gets slow) |
| **Preserve log** | Keep the records when the page reloads |

### Following one chain

When several blocks fire events at the same time, flows get busy. Three tools help you follow one line of cause and effect:

- **Hover.** Move the mouse over any step. Everything it caused, and everything that caused it, is highlighted, and the rest fades out.
- **Follow (focus mode).** **Double-click** a step, press **F**, or click **🎯 Follow this chain**. You then get:
  - only that flow
  - unrelated steps dimmed, or hidden if you tick **hide unrelated steps**
  - a breadcrumb at the top with the path from the origin to the selected step (click any part to jump to it)

  Press **Esc** or click **✕ Stop following** to leave.
- **Keyboard.** Use the arrow keys to walk the chain (see [shortcuts](#keyboard-shortcuts)).

![Following one chain](docs/follow-chain.png)

### Search

The search box in the Flow tab matches:

- action, event, block and module names
- server call names
- **variable names at any depth**: in event inputs, action inputs, locals, outputs and before/after snapshots (for example `Geo` finds `Address.Geo.Lat`)
- variable **values**, when **values** is ticked

Matching steps are highlighted and the matching text is marked. The counter shows how many matches there are. Press **Enter** to go to the next match and **Shift+Enter** for the previous one.

### Live variables tab

This tab shows every mounted screen and block as a tree (screen › layout › block › …) with its **current** variables.

- Click **↻ Refresh** to read the values again, or tick **Auto-refresh (2 s)**.
- Screens, and wrapper blocks without variables (layouts, cards), start expanded. Click a block's header to expand or collapse it.
- **Search** matches block names, variable names at any depth and, while **values** is ticked, values.
  - **Searching a block name** shows that block with all its variables.
  - **Searching a variable name** shows only the variables that contain it, expanded down to the match. Click **Show all N variables** to see the rest of that block.
  - The counter shows `N matches in M blocks`. **Enter** / **▼** go to the next match, **Shift+Enter** / **▲** to the previous one.
- **Hover a block's header** to highlight that block in the page.
- Each header has two buttons:
  - **⌖ Show in page** scrolls the page to the block and flashes it.
  - **⚡ Flows** opens the Flow tab filtered by that block.

![Searching a nested variable](docs/live-search.png)

### Block picker

The block picker works like the element picker in the Elements tab, but selects OutSystems blocks:

1. Click the **arrow button** at the top left of the OS Events panel.
2. Move the mouse over the page. Each block is outlined, and a label shows its path (for example `Layout › LineItem_0_View › Card › LineItem_Location`) and the widget under the mouse (for example `DropOff`).
3. Click to pick the block. The click is **not** passed to the app.
4. The panel switches to **Live variables**, with that block selected and expanded. A breadcrumb shows the path from the screen down to it, and you can click any part of it.

Press **Esc** to cancel the picker.

**Sync with Elements panel:** while this is ticked, selecting an element in the Elements tab also selects its block in Live variables.

| In the page | In the panel |
|---|---|
| ![Picker in the page](docs/picker-page.png) | ![Picked block in the panel](docs/picker-panel.png) |

### Debug mode (step by step)

Click **🐞 Debug** to turn it on. A yellow bar appears. Chrome also shows its own *"OutSystems Event Tracer started debugging this browser"* bar. That is expected; the extension needs it to hold the page while it is paused.

**Pause on:**

| Mode | Pauses at |
|---|---|
| **every step (node)** | Each node of each action (needs modules with debug info) |
| **every action entry** | The start of every client action |
| **every Trigger Event** | Every event a block fires |
| **breakpoints only** | Only where you set a breakpoint (from a step's details) |

Further options:

- **skip lifecycle**: don't pause in On Initialize / On Ready / On Render / On Parameters Changed / On Destroy.
- **skip OutSystemsUI**: don't pause inside actions of `OutSystems*` modules.

When the app pauses, the details panel shows:

- **where it stopped**: the action, node or event
- **the event inputs**, when it stopped on an event
- **the stack**, most recent first, across events back to the original click
- **the current block's variables** at that point

**Controls:**

| Button | Shortcut | What it does |
|---|---|---|
| **⤵ Next step** | F10 | Go to the next pause point of any kind |
| **⏭ Run thread** | F9 | Let the current thread run to the end without pausing |
| **▶ Continue** | F8 | Run until the next pause point of the selected mode |
| **■ Exit** | | Leave debug mode and let the app run |

![Paused on a Trigger Event](docs/debug-pause.png)

### Keyboard shortcuts

**Flow tab:**

| Key | Action |
|---|---|
| ↑ / ↓ | Previous / next step |
| ← | Go to the cause (or collapse) |
| → | Go to the first effect (or expand) |
| F or double-click | Follow the selected step's chain |
| Esc | Stop following |
| Enter / Shift+Enter (in search) | Next / previous match |

**Debug mode:**

| Key | Action |
|---|---|
| F10 | Next step |
| F9 | Run thread |
| F8 | Continue |

---

## Documentation

### How it works

The extension has three parts:

1. **Page script** (`src/inject.js`). Chrome injects it into the app page (in the page's own JavaScript context) before the app loads. It:
   - watches the AMD `define()` calls that load each module (`*.mvc$model`, `*.mvc$view`, `*.mvc$controller`)
   - wraps controller actions, the events a parent passes to a block (`props.events`) and server calls, so each action, Trigger Event and server request is recorded with its inputs and the variables before and after
   - hooks `OutSystemsDebugger.push/pop/handleBreakpoint` in modules compiled with debug info, to get node-level steps
   - maps DOM elements to blocks through React's internal fiber tree, for the picker, highlighting and Live variables

   Records are kept in memory in the page (up to 10,000) until the panel reads them.
2. **DevTools panel** (`panel.html`, `panel.js`, `store.js`). It reads the records from the page every 400 ms, links each event to its handler and each action to its caller, and builds the Chain and Tree views.
3. **Background service worker** (`background.js`). It is only used in debug mode, to pause the page (see below).

#### How the debug pause works

Pausing with a JavaScript `debugger;` statement would make DevTools jump to the Sources tab. Instead:

1. To pause, the page sends a **synchronous** request to a special URL (`/__os_event_tracer_pause__`). This blocks the page's JavaScript.
2. The extension intercepts that request with `chrome.debugger` (Fetch domain). It holds the request until you press Next step, Run thread or Continue.
3. It then answers with your command, and the page carries on.

The request never reaches your server:

- The page first sends an **empty probe**. It sends the pause data only if the extension answered the probe.
- If nothing answers (DevTools closed, extension disabled), debug mode switches itself off.

### Development vs production modules

OutSystems compiles modules differently depending on the environment:

| | Modules **with** debug info (typically dev) | Modules **without** debug info (typically test/prod) |
|---|---|---|
| Actions, events, inputs, variables | ✔ | ✔ (by wrapping the controller's actions) |
| Server calls | ✔ | ✔ |
| Node-level steps ("every step") | ✔ | ✘ |
| Breakpoints on nodes | ✔ | ✘ (breakpoints on actions and events work) |
| Live variables, picker | ✔ | ✔ |

The status bar shows how many modules of each kind were loaded (for example `modules: 1 with debug info / 4 without`).

### Permissions and privacy

| Permission | Why |
|---|---|
| Content script on all sites (`<all_urls>`) | OutSystems apps can be on any domain (OutSystems cloud, ODC, custom domains). The script checks for the OutSystems runtime and does nothing on other sites. |
| `debugger` | Used **only** while debug mode is on, to hold the pause request. Chrome shows its "started debugging this browser" bar while it is active. |

- **No data leaves your browser.** The extension has no server, analytics or tracking. Records live in the page's memory and in the DevTools panel.
- **Export** writes a JSON file to your computer only when you ask for it.
- The debug-mode settings are kept in the tab's `sessionStorage` (key `__osEventTracerDebug`), so debugging can continue across page reloads in that tab.

> Recorded data can include the values of your app's variables and inputs. Check exported JSON files before sharing them.

### Project structure

```
manifest.json      Extension manifest (Manifest V3)
background.js      Service worker: debug-mode pause interception (chrome.debugger / Fetch)
devtools.html/.js  Registers the "OS Events" DevTools panel
panel.html         Panel UI
panel.js           Panel logic: views, search, follow mode, Live variables, picker, debug UI
panel.css          Panel styles (light and dark themes)
store.js           Builds the flow tree from the raw records (links events to handlers, etc.)
src/inject.js      Page script: hooks into the OutSystems runtime and records everything
icons/             Extension icons
docs/              Screenshots used in this README
```

---

## Troubleshooting

| Problem | What to do |
|---|---|
| No **OS Events** tab | Check that the extension is enabled in `chrome://extensions`, then close and reopen DevTools. Look under the **»** menu. |
| Status says *Connecting to the page…* or *Tracer not found* | Reload the app page (F5) with DevTools open. The tracer must load before the app. |
| *OutSystems not detected* | The page is not an OutSystems Reactive app, or it is a Traditional Web app (not supported). |
| Events show **(no handler)** | The parent doesn't handle that event, or the block is rendered in a way the tracer doesn't recognise yet. Use **Export** and open an issue with the JSON. |
| Only actions, no nodes, in debug mode | The modules were compiled without debug info (typical in production). Use **every action entry** or **every Trigger Event**. |
| Debug mode turns itself off | The extension couldn't intercept the pause, usually because DevTools was closed or the debugger bar was cancelled. Turn Debug on again with the panel open. |
| The app feels slow while recording | Untick **Snapshots**, or pause recording with **● Record**. |
| Chrome warns about Developer mode extensions | That is normal for extensions installed with *Load unpacked*. |

---

## Limitations

- **Platform:** Chrome 111+ only (Manifest V3). Supports OutSystems **Reactive** apps (O11 and ODC); Traditional Web and Mobile native builds are not supported.
- **Value capture:** values are captured with limits, up to 5 levels deep, 30 items per list or object, and 2,000 characters per text. Larger values are truncated.
- **Server actions:** what happens inside server actions is not visible. Only the call, its inputs and its duration are shown.
- **Node-level stepping:** this needs modules compiled with debug info.
- **Runtime internals:** the extension relies on internal details of the OutSystems runtime and of React. A future platform version could change them. If something stops working, use **Export** and open an issue with the JSON.
