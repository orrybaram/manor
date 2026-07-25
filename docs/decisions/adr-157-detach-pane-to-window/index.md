---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-157: Detach a pane into a popout window

## Context

ADR-156 rebuilt **tab** dragging on the native HTML5 Drag-and-Drop API (VS Code
style): a single OS-rendered drag image (`DataTransfer.setDragImage`) follows the
cursor everywhere — across the tab bar, over panes, and out onto the desktop —
and because native DnD reports `screenX/screenY` even *outside* the window, a tab
can be torn off into a brand-new popout window (spawn-on-exit, Chrome-style),
handed to another manor window (`transferTab`), or dropped back (reattach).

**Panes never got this.** Pane dragging is still pointer-based
(`PaneDragContext` + `LeafPane`'s status-bar `pointerdown` → `startDrag({type:
"pane"})` → a DOM `PaneDragGhost` tracked with `pointermove` → `pointerup` on a
`PaneDropZone` or the `TabBar`). Pointer events cannot leave the window and there
is no OS drag image, so a pane can only be split/moved *within* the current
window or extracted into a tab. You cannot drag a pane out into its own window.

We want panes to pop out with **the same logic and UI as tabs**: one OS drag
image, tear-off-into-new-window on drag-out, transfer-into-another-window on
release, and orphan handling — reusing ADR-156's machinery rather than inventing
a parallel one.

**Key enabler:** a detached window always hosts a *tab*, and
`DetachedTabPayload` already models a tab whose `rootNode` is an arbitrary pane
tree — including a single `{ type: "leaf", paneId }`. So detaching a pane is just
producing a **single-leaf tab payload** and feeding it through the *existing*
`window:detachTab` / `window:transferTab` IPC. No new window type, no new IPC
channel, no new payload shape. A pane dropped onto another window becomes a tab
there — exactly the desired behavior and identical to a tab drop.

## Decision

Migrate pane dragging from the pointer-based path onto the **same native HTML5
DnD path tabs use**, and route pane tear-off through the existing tab-detach IPC
by wrapping the pane in a single-leaf tab payload.

### 1. Store primitives (reuse the tab-detach pipeline)

Add two pane-scoped functions to `app-store.ts`, mirroring
`serializeTabForDetach` / `removeDetachedTabLocally`:

- **`serializePaneForDetach(paneId): DetachedTabPayload`** — locate the pane,
  build a `DetachedTabPayload` whose `tab.rootNode = { type: "leaf", paneId }`,
  `focusedPaneId = paneId`, a fresh `tab.id`, `paneState` containing only that
  one pane's side-map entries, and the same theme resolution as the tab version.
  `structuredClone` the result. No change to `DetachedTabPayload` — a pane is
  just a tab with a one-leaf tree.
- **`removeDetachedPaneLocally(paneId)`** — release *only that pane's* backend
  without terminating it (`pty.detach` / `webview.unregister`, diff = no-op),
  then remove the pane from its source tab's tree with `removePane` (collapsing
  the split). If the pane is the sole leaf of its tab, this collapses to the
  same effect as removing the whole tab (prune the tab / reset the panel).

The receive/hydrate side needs **no changes**: the destination window already
hydrates a `DetachedTabPayload` into a tab (`window:detachTab`,
`window:tab-received`), and a single-leaf tree hydrates into a one-pane tab.

### 2. Native DnD on the pane handle (`LeafPane`)

Replace the status bar's `handleStatusBarPointerDown` drag-start with native DnD,
mirroring `TabBar`'s tab handlers:

- Make the status bar `draggable` with `onDragStart` / `onDrag` / `onDragEnd`.
- `onDragStart`: record grab offset + the pane's window position, set an
  `application/x-manor-pane` marker on the `DataTransfer`, build and set the
  single OS drag image (reuse a shared drag-image builder — see §4), call
  `startDrag({ type: "pane", paneId, grabOffset })` (so `PaneDropZone`s still
  render), and snapshot `window.getBounds()` + `listWindows()` for the hit-test.
- `onDrag`: **spawn-on-exit tear-off** — the instant the pointer is clearly
  outside this window and not over another manor window, call
  `serializePaneForDetach` + `removeDetachedPaneLocally` + `window.detachTab`,
  exactly as `TabBar.handleTabDrag` does. Guard the sole-pane-of-a-detached-
  window orphan case.
- `onDragEnd`: on-release fallback — if unhandled and released outside, either
  `transferTab` to the window under the release point or `detachTab` a new
  window; handle the orphan-window `setPosition` case.

Reuse `serializePaneForDetach` / `removeDetachedPaneLocally` where the tab code
uses `serializeTabForDetach` / `removeDetachedTabLocally`.

### 3. Teach existing drop targets to accept native pane drops

- **`PaneDropZone`** already has native `dragover`/`drop` handlers for
  `application/x-manor-tab`; add the `application/x-manor-pane` branch calling
  `movePaneToTarget(paneId, targetPaneId, direction, position)`. Retire the
  pointer-based (`onPointerMove`/`onPointerUp`) pane path.
- **`TabBar`** currently extracts a dropped pane via `handlePanePointerUp` →
  `extractPaneToTab`. Replace that with a native `drop` branch for
  `application/x-manor-pane` → `extractPaneToTab`.
- **`PaneDragContext`**: pane drags no longer need the DOM `PaneDragGhost` or the
  global `pointermove` cursor tracking (the OS renders the drag image now), same
  as tabs already dropped their DOM ghost. Keep the `drag` state (`type: "pane"`)
  so drop zones render/highlight; delete `PaneDragGhost` and the cursor effect.

### 4. Shared drag geometry + drag-image helper

Extract the pure, stateless pieces both tab and pane handlers need into
`src/lib/detach-drag.ts`:

- `isOutsideWindow(screenX, screenY, bounds, margin)`
- `findWindowAtPoint(screenX, screenY, windows)`
- `spawnBoundsFor(screenX, screenY, grabOffset)`
- a generalized `buildDragImage(title, contentType, favicon)` (today's
  `buildTabDragImage`, moved so panes render an identical chip).

`LeafPane` consumes these. `TabBar` is **left working as-is** for this ADR
(optionally switched to the helper later) to avoid regressing the shipped tab
tear-off — the helper is additive, not a forced rewrite.

## Consequences

**Better**
- Panes gain full popout parity with tabs: tear-off to a new window, transfer to
  another window, one consistent OS drag visual — no seam, no second code model.
- Zero new IPC / window / payload surface. Detach reuses ADR-156 end to end; a
  pane simply *is* a single-leaf tab once it leaves its tree.
- Removes the bespoke pointer-drag path for panes (`PaneDragGhost`, cursor
  tracking), so there's one drag model in the app instead of two.

**Harder / risks**
- `LeafPane`'s status-bar drag becomes native `draggable`. Native DnD interacts
  differently with the webview/BrowserView overlays than pointer capture did;
  the browser/diff panes' status bars must still initiate a clean drag. Needs
  device testing across terminal, browser, and diff panes.
- Spawn-on-exit relies on the OS delivering non-zero `screenX/Y` outside the
  window (works for tabs today); the on-release fallback covers platforms that
  don't, same as tabs.
- Collapsing a split when a middle pane tears off must keep the remaining tree +
  `focusedPaneId` valid (covered by `removePane`, already used by
  `extractPaneToTab`).
- Two copies of the drag *orchestration* remain (tab in `TabBar`, pane in
  `LeafPane`); only the pure geometry/image helpers are shared. Accepted to avoid
  rewriting shipped tab code.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
