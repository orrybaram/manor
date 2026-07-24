---
title: Navigator bridge — record, replay, prune
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Navigator bridge — record, replay, prune

The single place that maps between the history store (ticket 1) and the layout
state in `app-store`, in BOTH directions. This is the correctness-critical piece:
the recorder and the replayer must not form a feedback loop.

## a. Current-location selector

Add a pure selector that derives the current `Location` from `app-store` state:
- If there is no `activeWorkspacePath` (or the active surface is Home), return
  `{ kind: "surface", surface: "home" }`.
- Otherwise read `layout = workspaceLayouts[activeWorkspacePath]`, then
  `panelId = layout.activePanelId`, `tabId = layout.panels[panelId].selectedTabId`,
  and return `{ kind: "workspace", workspacePath, panelId, tabId }`.

Reuse the existing selectors near `src/store/app-store.ts:380-398`
(`getActivePanel` etc.) rather than re-reading the tree by hand where possible.

## b. Recorder

Subscribe to `app-store` (Zustand `subscribe`) for changes to the derived current
location. When it changes AND `navigation-history-store.getState().isNavigating`
is `false`, call `record(loc)`. Set up the subscription once (e.g. a
`useNavigationHistory()` hook mounted once in `App.tsx`, or a module-level
`subscribe` initialized at store creation — match the repo's existing pattern for
cross-store subscriptions). Record the initial location on mount.

## c. Replay (goBack / goForward)

Expose `navigateBack()` / `navigateForward()`:
1. `setNavigating(true)`.
2. Call the store's `goBack()`/`goForward()` to get the target `Location`.
3. **Prune stale**: validate the coordinate against the live layout — workspace
   exists in `workspaceLayouts`, `panelId` exists in `layout.panels`, `tabId`
   exists in that panel's tabs. If invalid, drop the entry from the store and try
   the next one in the same direction; if none valid, stop.
4. Dispatch existing `app-store` actions to reconstruct the target:
   `setActiveWorkspace(workspacePath)` (`app-store.ts:214/553`), then
   `focusPanel(panelId)` (`:332`), then `selectTab(tabId)` (`:251`). For a
   `surface: "home"` target, switch to the Home surface the same way the sidebar
   does.
5. `setNavigating(false)` (in a `finally`, after the app-store updates have been
   applied — flush via `queueMicrotask`/`setTimeout(0)` if the subscription fires
   asynchronously, so the guard is still up when the recorder sees the change).

## Feedback-loop guard — verify explicitly
After wiring, confirm that a `navigateBack()` does NOT itself append a new history
entry (the guard must be up for the entire duration of the resulting app-store
change and its subscription callback). Add a test or a temporary assertion.

## Files to touch
- `src/store/app-store.ts` — add/export the current-location selector (co-locate with existing selectors ~`:380-398`).
- `src/hooks/useNavigationHistory.ts` — new: recorder subscription + `navigateBack`/`navigateForward` + prune logic.
- `src/App.tsx` — mount `useNavigationHistory()` once (near other top-level hooks).
