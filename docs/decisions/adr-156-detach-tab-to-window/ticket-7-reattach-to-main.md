---
title: Reattach a tab back into the main window
status: done
priority: high
assignee: opus
blocked_by: [4]
---

# Reattach a tab back into the main window

Reverse the detach: send a detached window's tab back to the primary window and
close the detached window. Panes must survive the trip (no session kills).

## Requirements

1. **IPC `window:reattachTab`** — `invoke(payload: DetachedTabPayload): Promise<void>`
   (add to `electron/ipc/window.ts`, preload, `src/electron.d.ts`).
   - Main forwards the payload to the **primary** window's webContents:
     `primaryWindow.webContents.send("window:tab-reattached", payload)` (use the
     window registry from ticket 1 to find the primary).
   - Then close the calling (detached) window.

2. **Primary renderer listener.** In the primary window's bootstrap (`App.tsx`),
   subscribe to `window:tab-reattached` (expose the listener through preload,
   following the existing `on...`/event-subscription pattern used elsewhere in
   `electronAPI`). On receipt, call `receiveReattachedTab(payload)`.

3. **Store action `receiveReattachedTab(payload: DetachedTabPayload)`** in
   `src/store/app-store.ts`:
   - Insert `payload.tab` into the **active panel** of the active workspace layout
     (append to `tabs`, set `selectedTabId = tab.id`). Reuse the same insertion
     path `moveTabToPanel`/`addTab` use — do not hand-roll a divergent one.
   - Repopulate every per-pane side-map from `payload.paneState` (same as
     `hydrateDetachedTab` in ticket 3) so PTYs re-attach and webviews re-mount by
     `paneId`.
   - The normal layout-save subscription then persists it (it's back in a
     primary-window layout), so the tab is durable again.

4. **Trigger: "Move tab back to main window" menu item** in the **detached
   window's** tab menu (the detached window renders the same `TabButton` menu
   from ticket 6; show this item only when `electronAPI.isDetached`). Handler:
   ```ts
   const payload = serializeTabForDetach(tabId);
   removeDetachedTabLocally(tabId);        // detach panes, drop from this store
   await window.electronAPI.window.reattachTab(payload);
   // main closes this window
   ```

## Files to touch
- `electron/ipc/window.ts` — add `window:reattachTab`; forward to primary + close sender.
- `electron/preload.ts` — expose `reattachTab` + the `onTabReattached` listener.
- `src/electron.d.ts` — type both.
- `src/App.tsx` — subscribe to `window:tab-reattached` in the primary window.
- `src/store/app-store.ts` — add `receiveReattachedTab`.
- `src/components/tabbar/TabButton.tsx` (+ tab menu) — add the detached-only "back to main" item.

## Notes
- Reuse `serializeTabForDetach` / `removeDetachedTabLocally` (ticket 3) verbatim
  — reattach is detach with a different destination (primary store vs. new window).
- Verify a live terminal keeps streaming after a full round trip:
  main → detached → back to main.
