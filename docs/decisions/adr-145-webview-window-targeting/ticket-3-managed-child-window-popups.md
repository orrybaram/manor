---
title: Managed child window for communicating popups (OAuth/SSO/payment)
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Managed child window for communicating popups

Replace the `TODO(ticket-3)` deny branch from Ticket 1 with a real, owned child
`BrowserWindow` so popups that depend on the opener relationship work end-to-end:
`window.opener`, `popup.postMessage()`, `popup.closed`, `window.close()`, and
named-target reuse. This is the only mechanism that preserves the Chromium opener
relationship — it cannot be emulated with a manor tab.

## Implementation

1. **Allow the open in `setWindowOpenHandler`** for the communicating-popup branch
   (`disposition: "new-window"` and/or non-empty `features`): return
   `{ action: "allow", overrideBrowserWindowOptions: { ... } }`. Parent the child
   to the main `BrowserWindow` (`parent`), set a sensible default size, and
   normalize/clamp any requested `features` size. Configure secure `webPreferences`
   consistent with the rest of the app (contextIsolation on, nodeIntegration off,
   sandbox on) — match `electron/window.ts` defaults.

2. **Track child windows.** Use the `did-create-window` event (or the handler's
   `createWindow` callback) to capture the child `BrowserWindow` / its
   `WebContents`. Keep a registry keyed by originating `paneId` so children can be
   cleaned up. Apply the same external-link policy as the main window — give the
   child's `webContents` a `setWindowOpenHandler` that routes *its* further
   `window.open`s sensibly (e.g. `shell.openExternal` for http/https like
   `electron/window.ts:120`, to avoid unbounded popup chains).

3. **Lifecycle / cleanup.** Destroy or close tracked child windows when:
   - the originating pane is unregistered (`webview:unregister`), and
   - the main window closes.
   Ensure no orphaned windows or listener leaks. Remove registry entries on the
   child's `closed` event.

4. **Verify opener semantics** with a manual or scripted check: opener can
   `postMessage` to the child and observe `child.closed` flip after the child
   calls `window.close()`. A minimal OAuth-style popup (open → child posts a
   message back to `window.opener` → opener closes it) should round-trip.

## Files to touch
- `electron/ipc/webview.ts` — replace the Ticket-1 popup deny branch with the
  `{ action: "allow", overrideBrowserWindowOptions }` path; capture and register
  the child window; clean up on `webview:unregister`.
- `electron/window.ts` — if a shared helper for creating/securing child windows or
  hooking main-window-close cleanup fits better here, add it (reuse the existing
  `webPreferences` and `setWindowOpenHandler` external-link policy at ~line 120).
- (Optional) a small new module e.g. `electron/ipc/popups.ts` if the child-window
  registry + lifecycle is cleaner extracted; otherwise keep it in `webview.ts`.
