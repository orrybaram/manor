---
title: Shortcuts in browser pages and popout windows
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# Shortcuts in browser pages and popout windows

1. Webview (`electron/ipc/webview.ts:396-442`, `before-input-event`): in
   addition to the fixed browser keys, if the input matches any combo in the
   current keybinding map (load via `electron/keybindings.ts`; stay in sync
   when the user edits bindings), `preventDefault` and send it to the host
   renderer on the existing channel the renderer uses to run commands (find
   how Esc Esc / zoom are forwarded; reuse). Also forward F6 / Shift+F6.
   Precedence while a page has focus: the browser's own ⌘[ ⌘] ⌘L ⌘R ⌘F ⌘=
   ⌘- ⌘0 win over pane navigation (current behaviour); everything else goes
   to the app. Share the combo-matching code with the renderer
   (`src/lib/keybinding-defs.ts` is importable from electron if no DOM deps;
   otherwise extract a pure matcher).
2. Renderer side: receive the forwarded command and call the same handler
   path as `dispatchKeybinding`. `focus-next-region` from a webview moves
   DOM focus out of the webview (blur it first).
3. URL bar (browser pane toolbar): `browser-back`/`browser-forward`/
   `browser-find` should take precedence over `next-pane`/`prev-pane` while
   the URL input is focused, and `browser-find` should work there. Fix the
   registry-order match in `dispatchKeybinding` by scoping browser-* combos
   to "browser pane focused".
4. Popout windows (`src/DetachedApp.tsx:130-151`): for commands only the main
   window implements (`settings`, `command-palette`, `new-workspace`,
   `next-workspace`, `prev-workspace`, `history-*`, `toggle-sidebar`,
   `focus-sidebar`), send an IPC to main that focuses the main window and
   runs the command there. Add the preload/IPC plumbing following existing
   patterns (grep `DetachedApp` IPC usage).
5. Unit test the pure matcher.

## Files to touch
- `electron/ipc/webview.ts`, `electron/keybindings.ts`, preload, `electron/main.ts` if IPC registry lives there
- `src/lib/keybinding-commands.ts`, `src/lib/keybinding-defs.ts`
- `src/DetachedApp.tsx`, `src/App.tsx`
