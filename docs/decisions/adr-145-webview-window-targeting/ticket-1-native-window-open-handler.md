---
title: Replace injected-JS interception with native setWindowOpenHandler
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Replace injected-JS interception with native setWindowOpenHandler

Foundational change. Move new-window decisions from the injected
`INTERCEPT_NEW_WINDOW_SCRIPT` to Electron's native `setWindowOpenHandler` on the
guest `WebContents`, and remove the injected script. This single change fixes
bug #1 (`_parent`/`_self`/`_top` hijacked into new tabs) and bug #2 (iframe
`window.open` silently dropped).

## Spike first (acceptance gate)

Before finalizing the routing table, verify on the project's Electron version,
inside a `<webview>` with `allowpopups`, what `disposition` and `features` values
`setWindowOpenHandler` actually receives for:
- a plain `<a target="_blank">` click
- a cmd/ctrl+click and a middle-click
- `window.open(url)` with no features
- `window.open(url, '_blank', 'width=500,height=600')`
- `window.open(url, '_parent')` and `'_self'` / `'_top'` (confirm these do NOT
  reach the handler — they should be `will-navigate` instead)
- `window.open` called from inside an `<iframe>` (confirm the handler now fires)

Record the observed mapping in a comment next to the handler so the routing is
documented, not assumed.

## Implementation

1. **Enable the native open path.** Add the `allowpopups` attribute to the
   `<webview>` element so guest `window.open` requests reach our handler instead
   of being blocked. The handler (below) is now the sole authority on what opens.

2. **Register `setWindowOpenHandler`** on the guest `wc` inside the
   `webview:register` handler, alongside the existing context-menu / escape /
   console listeners. Route by intent:
   - **Navigation-style** (`disposition` `foreground-tab` / `background-tab`, i.e.
     `_blank` links, cmd/middle-click, featureless `window.open`): return
     `{ action: "deny" }` and `rendererWebContents.send("webview:new-window",
     paneId, url, { background: disposition === "background-tab" })`. (Ticket 2
     consumes the `background` flag; send it now.)
   - **Communicating popup** (`disposition: "new-window"` and/or a non-empty
     `features` string): return `{ action: "deny" }` **for now** with a clear
     `TODO(ticket-3)` — Ticket 3 replaces this branch with the managed child
     window. Do not silently route popups to tabs.

3. **Remove the injected interception.** Delete `INTERCEPT_NEW_WINDOW_SCRIPT`, the
   `did-finish-load` injection (`injectNewWindowIntercept`), and the
   `console-message` listener that parses `__manor_new_window__:`. Update the
   `webview:unregister` cleanup (`newWindowConsoleCleanup`) accordingly — replace
   it with cleanup for the new handler if any teardown is needed (note:
   `setWindowOpenHandler` is replaced, not removed; clearing it on unregister is
   optional since the `wc` is going away, but remove the now-dead cleanup map).
   Keep the image context-menu "Open Image in New Tab" path
   (`webview.ts:74-81`) intact — it still sends `webview:new-window`.

## Files to touch
- `electron/ipc/webview.ts` — register `setWindowOpenHandler` with intent-based
  routing; delete `INTERCEPT_NEW_WINDOW_SCRIPT`, `injectNewWindowIntercept`, the
  `console-message` new-window listener, and the `newWindowConsoleCleanup` map.
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — add `allowpopups`
  to the `<webview>` element (~line 524).

## Out of scope
- Background-tab focus handling end-to-end (Ticket 2 consumes the flag).
- The managed child window for popups (Ticket 3).
