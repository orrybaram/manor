---
title: Thread background-tab disposition through new-window IPC
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Thread background-tab disposition through new-window IPC

Ticket 1 sends a `{ background }` flag with `webview:new-window` for cmd/middle-
click opens. Wire that flag through to tab creation so background-tab opens do not
steal focus, while keeping foreground the default for all existing callers.

## Implementation

1. **Preload** (`electron/preload.ts:454-462`): extend `onNewWindow` so the
   callback receives the optional `{ background }` payload sent by the main
   process. Keep it backward-compatible (absent → foreground).

2. **Types** (`src/electron.d.ts:607`): update the `onNewWindow` signature to
   include the optional `background` argument/flag.

3. **BrowserPane** (`src/components/workspace-panes/BrowserPane/BrowserPane.tsx`
   ~438-443): pass the flag into the store call —
   `addBrowserTab(openUrl, { background })`.

4. **Store** (`src/store/app-store.ts:235` interface, `:647` impl): change
   `addBrowserTab(url)` to `addBrowserTab(url, opts?: { background?: boolean })`.
   When `background` is true, create the tab but do **not** set it as
   `selectedTabId` (leave the current selection). Default/absent → current
   behavior (create and select). Verify all existing callers still compile —
   they call `addBrowserTab(url)` with one arg and must keep foreground behavior:
   - `src/App.tsx:320`
   - `src/components/sidebar/WorkspaceEmptyState.tsx:195`
   - `src/components/tabbar/TabBar/TabBar.tsx:409`
   - `src/components/command-palette/useCommands.tsx:115,421` (and the
     `addBrowserTab` type in `useCommands.tsx:29`)
   - `src/components/ports/PortBadge.tsx:21`

## Files to touch
- `electron/preload.ts` — extend `onNewWindow` payload.
- `src/electron.d.ts` — update `onNewWindow` type.
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — pass `background`.
- `src/store/app-store.ts` — `addBrowserTab(url, { background })`, skip selection
  when background; update the store interface type.
- `src/components/command-palette/useCommands.tsx` — update the `addBrowserTab`
  prop type if it constrains the signature.
