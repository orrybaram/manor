---
title: Detached-window renderer bootstrap
status: todo
priority: critical
assignee: opus
blocked_by: [3]
---

# Detached-window renderer bootstrap

Make the renderer boot into "detached mode" when launched with
`--manor-detached=<windowId>`: skip normal workspace load and persistence, pull
the handoff payload, hydrate the single tab, and render it. Wire the ephemeral
lifecycle (closing the window closes the tab).

## Requirements

1. **Detect detached mode**
   - Read the `--manor-detached` arg. Follow the existing pattern used for
     `--manor-packaged` (parsed in preload and surfaced synchronously; see
     `window.ts:88-89` and how `electronAPI` exposes `isPackaged`). Surface an
     `isDetached: boolean` (and optionally `detachedWindowId`) on `electronAPI`.

2. **Guard the layout-save subscription**
   - In `src/store/app-store.ts`, the `useAppStore.subscribe(...)` that calls
     `saveActiveWorkspaceLayout` (around `app-store.ts:2749`) and the
     `beforeunload` flush must be **no-ops in detached mode**. A detached window
     must never call `window.electronAPI.layout.save` (prevents the
     `workspacePath` collision). Gate on `electronAPI.isDetached`.

3. **Bootstrap in `App.tsx` / `main.tsx`**
   - When `isDetached`:
     - Do NOT run the normal `layout:load` / `getRestoredSessions` path.
     - Call `window.electronAPI.window.getDetachPayload()`; if null (e.g. reload),
       show a minimal empty state or close — do not crash.
     - Call `hydrateDetachedTab(payload)` (ticket 3), then render the existing
       panel/pane tree for that single tab. Reuse the normal
       `PanelLayout`/`LeafPanel` render path; a detached window is just a window
       whose store contains exactly one panel with one tab.
     - Hide/'/no-op any primary-window-only chrome that doesn't make sense in a
       detached window (e.g. the project sidebar / workspace switcher) — keep the
       tab bar + panes. Use judgment; minimal is fine.

4. **Ephemeral lifecycle**
   - On detached window close, the tab's panes should be terminated (this window
     owned them after detach). Either let the main process close/kill on
     `window.closed`, or have the renderer call the normal close-tab path in a
     `beforeunload`. Pick one and make it deterministic — no orphaned live
     sessions on a *clean* close. (Crash-time orphans are accepted per the ADR.)

## Files to touch
- `electron/preload.ts` — parse `--manor-detached`; expose `isDetached` / `detachedWindowId`.
- `src/electron.d.ts` — type `isDetached` / `detachedWindowId`.
- `src/main.tsx` / `src/App.tsx` — branch on detached mode; hydrate + render single tab; trim primary-only chrome.
- `src/store/app-store.ts` — gate the layout-save subscription + `beforeunload` flush on `isDetached`.

## Notes
- After this ticket, a detached window can be created and correctly hosts a
  handed-off tab. Tickets 5 and 6 add the two ways to *trigger* the detach.
- Test the terminal re-attach end to end: a running command in the source tab
  must keep streaming in the detached window.
