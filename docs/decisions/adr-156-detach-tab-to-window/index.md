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

# ADR-156: Detach a tab into its own popup window

## Context

Manor is today a **single-`BrowserWindow`** app. The entire UI hierarchy —
workspaces → panels → tabs → panes — lives in one renderer's Zustand store
(`src/store/app-store.ts`) and is persisted per `workspacePath`. Tabs are the
draggable unit; a tab holds a binary tree of panes, where each pane is a
terminal (daemon-backed PTY, keyed by `paneId`), a browser (`<webview>`, keyed
by `paneId`), or a diff view.

Users want to pull a tab out of the main window into a **separate popup window**
so they can watch a long-running agent, keep a browser preview visible, or lay
work across multiple monitors. Cross-panel tab moves already exist
(`moveTabToPanel`, `splitPanelWithTab`, `extractPaneToTab`); this ADR extends
that mental model across the process boundary into a second window.

Two properties of the existing architecture make this tractable:

- **Terminals survive re-attach.** PTYs live in a persistent daemon keyed by
  `paneId`. `pty.detach(paneId)` releases a session *without killing it*; a
  second renderer can `pty:create`/attach the same `paneId` and resume the live
  session. This is what lets a terminal move windows with zero data loss.
- **Move primitives already serialize a tab.** The store already plucks a `Tab`
  out of one container and re-inserts it elsewhere. A detach is the same
  operation with the destination being a *new window's store* rather than a
  panel in the same layout.

Two properties make it hard:

- **The single-window assumption is pervasive.** `electron/app-lifecycle.ts`
  holds one `mainWindow`; PTY stream events and notifications are forwarded only
  to it.
- **Persistence is keyed by `workspacePath` only.** Two windows persisting the
  same workspace would clobber each other.

### Product decisions (confirmed with user)

- **Trigger:** *Both* — drag a tab out past the window edge **and** a
  "Move tab to new window" menu item.
- **Content:** *All tab types.* Terminals re-attach live. Browsers re-navigate
  to their saved URL (live DOM/scroll is lost — unavoidable with `<webview>`).
  Diffs are recreated from their descriptor.
- **Persistence:** *Ephemeral windows.* Detached windows are session-only — not
  saved or restored on relaunch. This sidesteps the `workspacePath` collision
  entirely: detached-mode renderers do not run the layout-save subscription.

## Decision

Introduce **secondary renderer windows** that host a single detached tab, with a
one-shot IPC handoff of that tab's serialized state.

### 1. Main process: multi-window foundation

- Refactor `electron/window.ts`: extract shared `webPreferences`/handlers into a
  helper and add `createDetachedWindow(windowId)` alongside `createWindow()`.
  Detached windows load the same renderer with an extra arg
  `--manor-detached=<windowId>` (mirrors the existing `--manor-packaged` pattern)
  and open at caller-supplied bounds. They do **not** read/write
  `windowBoundsFile` (ephemeral).
- Add a lightweight `WindowManager` in `app-lifecycle.ts`: a `Set<BrowserWindow>`
  plus the designated primary. The existing `get mainWindow()` getter keeps
  returning the primary (backward-compatible with every current handler).
- **Broadcast PTY stream events and notifications to all live windows** instead
  of only the primary. Each renderer only holds xterm/webview instances for the
  panes it hosts, so events for panes it doesn't own are harmlessly ignored.

### 2. Detach IPC + handoff channel

New module `electron/ipc/window.ts` (registered in `electron/ipc/index.ts`,
exposed through `electron/preload.ts` + `src/electron.d.ts`):

- `window:detachTab(payload, spawnBounds)` — main creates a detached window,
  stashes `payload` keyed by the new `windowId`.
- `window:getDetachPayload()` — the new renderer pulls its payload once on boot
  (payload can't ride through `loadFile`).
- `window:getBounds()` — source renderer fetches the current window's outer
  bounds at drag start (needed to decide "released outside the window").

### 3. Store: serialize / remove / hydrate

In `src/store/app-store.ts`:

- `serializeTabForDetach(tabId): DetachedTabPayload` — the `Tab` (id, title,
  `rootNode`, `focusedPaneId`) plus **every per-pane side-map entry** for its
  panes: `paneCwd`, `paneTitle`, `paneContentType`, `paneUrl`, `paneFavicon`,
  `paneAgentStatus`, `paneAudioPlaying/Muted`, `panePickedElement`.
- `removeDetachedTabLocally(tabId)` — remove the tab from its panel **without
  killing its panes**: `pty.detach` each terminal, `webview.unregister` each
  browser, drop the side-map entries. (Distinct from `closeTab`, which kills
  sessions.)
- `hydrateDetachedTab(payload)` — build a minimal one-panel/one-tab layout in a
  fresh store and repopulate the side-maps, so the normal render path
  re-attaches PTYs / re-mounts webviews by `paneId`.

### 4. Detached-window renderer bootstrap

`src/main.tsx` / `src/App.tsx` read the `--manor-detached` flag. When detached:
skip the normal workspace load, **skip the layout-save subscription** (guard the
`useAppStore.subscribe` in `app-store.ts`), pull the payload via
`window:getDetachPayload`, hydrate, and render the single panel. On window close,
close the tab normally (killing its panes) — the window is ephemeral.

### 5. Drag-out trigger (`TabBar.tsx`)

Extend the existing pointer-drag. Today, when the pointer leaves the tab bar the
code releases pointer capture and hands off to in-window pane drop zones. For
drag-out we **retain pointer capture** so `pointermove`/`pointerup` keep firing
with `screenX/screenY` even outside the OS window. On `pointerup`, if the screen
point is outside the window's outer bounds (fetched via `window:getBounds` at
drag start), call detach at those coordinates; otherwise fall through to the
existing pane-drop / reorder behavior.

### 6. "Move tab to new window" menu item

Add the action to the tab context menu; it detaches the tab centered on the
current window (no drag geometry needed). Shares the same store + IPC path.

### 7. Reattach a tab back into the main window

A detached window can send its tab **back to the primary window**. The reverse
handoff mirrors detach: the detached renderer serializes its tab, releases its
panes without killing them (`pty.detach` / `webview.unregister`, i.e. reuse
`removeDetachedTabLocally`), sends the payload over `window:reattachTab`, and
closes. Main forwards the payload to the **primary** window's webContents; the
primary renderer receives it and inserts the tab into the active panel via a new
`receiveReattachedTab(payload)` store action (re-attaching PTYs / re-mounting
webviews by `paneId`, exactly like hydrate but into the existing layout). Trigger
is a "Move tab back to main window" menu item in the detached window. Because the
tab lands in the primary window's active workspace, it is persisted normally
again.

## Consequences

**Better**

- Real multi-window UX: monitor agents / previews on a second display.
- Terminals move with zero data loss (daemon re-attach).
- A `WindowManager` + broadcast model is the foundation for any future
  multi-window work (tear-off panels, detached previews).

**Harder / risks**

- **Browsers lose live state.** Only the URL survives; DOM/scroll/form state is
  reset on re-navigate. Documented and accepted.
- **Broadcasting stream events to all windows** is slightly wasteful and must be
  robust to destroyed/reloading webContents (guards already exist for the single
  window; extend them per-window).
- **Drag-out edge cases.** Pointer-capture-outside-window behavior and
  multi-monitor coordinate math are fiddly; the menu item is the reliable
  fallback, so drag-out can ship even if some geometry edge cases remain.
- **Orphaned daemon sessions.** Because detached windows are ephemeral, a crash
  (vs. clean close) could leave detached PTYs un-reclaimed until the next daemon
  reconcile — same failure mode as any un-closed session today.
- **Reattach lands the tab in the *active* workspace/panel of the primary
  window**, which may differ from where it was detached from. Accepted: an
  explicit "back to main" action, not a "return to exact origin."
- **Closing a detached window still closes its tab** (kills panes); reattach is
  the explicit path to preserve it. "Close returns tab to main" is a possible
  future refinement, deliberately not the default here.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
