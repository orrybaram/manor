---
title: Store — one paneId scope, and actions return what they mint
status: todo
priority: critical
assignee: opus
blocked_by: [1]
---

# Store — one paneId scope, and actions return what they mint

Fixes correctness bug #2 (three scopes for one identifier) and makes structural
deletion #16 (pre-minted pane IDs).

## Part A — one scope

`focusPane` (`src/store/app-store.ts:1848`) already searches every panel, with
the comment *"Search all panels for the pane, not just the active one"*, using
the canonical `findPanelWithPane(layout, paneId)` helper that `movePaneToTarget`
also uses.

`closePaneById` and `splitPaneAt` instead call `getActivePanelContext(state)`,
so they silently no-op on a pane in a non-active panel. Combined with
`list_panes` reporting all panels, `close_pane` returns `400 Unknown paneId` for
a pane the same tool surface just printed.

Change both to resolve the pane with `findPanelWithPane` and operate on the
panel that actually holds it:

- `closePaneById` (~line 1595): replace `getActivePanelContext` with
  `findPanelWithPane(layout, paneId)`. It already records `panelId` in its
  `ClosedPaneSnapshot`, so undo keeps working.
- `splitPaneAt` (~line 1188): same. It currently derives `panel` from the active
  context and then searches `panel.tabs` for `targetPaneId`.

Do **not** change `getActiveLayoutContext` usage for `path`/`layout` — only the
panel lookup moves.

## Part B — actions return their IDs

`newPaneId` was exported (`app-store.ts:77`) purely so `src/lib/app-commands.ts`
could pre-mint an ID and thread it down as an optional param, then read the tab
back out of the tree with `findTabIdForPane`. Invert it:

| Action | Now returns |
|---|---|
| `addTab()` | `{ tabId: string; paneId: string } \| null` |
| `addTerminalTab(command)` | `{ tabId: string; paneId: string } \| null` |
| `addBrowserTab(url, opts?)` | `{ tabId: string; paneId: string } \| null` |
| `splitPaneAt(target, dir, pos, opts?)` | `string \| null` (the new paneId) |

`null` when the action would have no-opped (no active panel context, unknown
target). Each action mints its own ID and closes over it:

```ts
addTab: () => {
  const paneId = newPaneId();
  const tabId = newTabId();       // or whatever the existing tab-id mint is
  let created = false;
  set((state) => { /* ...existing body, using paneId/tabId...; created = true */ });
  return created ? { tabId, paneId } : null;
},
```

Zustand actions may return values — only the `set` callback must be pure.

Then:
- Un-export `newPaneId` (revert to `function newPaneId()`).
- Delete the `paneId?` option from `addTab`, `addTerminalTab`, `addBrowserTab`,
  and `splitPaneAt`'s `opts`, and from their `AppState` signatures.
- Keep `splitPaneAt`'s `opts` bag for `contentType`/`paneCommand`/`url`.

Existing in-app call sites (`SplitWithSubmenu.tsx`, `useCommands.tsx`,
`TerminalPane.tsx`) ignore the return value — no change needed beyond typecheck.

## Part C — reject incoherent option combinations

`splitPaneAt` currently accepts `{ contentType: "browser", command: "pnpm dev" }`
and writes `pendingPaneCommands[newPane]`, which only a terminal ever drains
(`app-store.ts:2077`) and which `closePaneById` does **not** prune (it prunes
`paneCwd`/`paneTitle`/`paneAgentStatus`/`paneContentType`/`paneUrl` but not
`pendingPaneCommands`) — so the entry leaks. Symmetrically, `url` on a terminal
pane writes `paneUrl` and a tree-leaf `url` that nothing reads.

Add `pendingPaneCommands` to the prune list in `closePaneById` and `closeTab`.
Argument coherence itself is enforced one layer up, in ticket 3 — do not add
validation branches to the store.

## Files to touch
- `src/store/app-store.ts` — `findPanelWithPane` in `closePaneById`/`splitPaneAt`; actions return IDs; un-export `newPaneId`; drop `paneId?` opts; prune `pendingPaneCommands`
- `src/store/__tests__/app-store-split-pane-at.test.ts` — update for the new return + all-panel scope
- `src/store/__tests__/app-store-add-browser-tab.test.ts` — update for the new return
- Add a test: closing/splitting a pane in a **non-active** panel now succeeds

## Verify
`pnpm typecheck` clean. New tests cover: split/close a pane in a non-active
panel; every action's return value; `pendingPaneCommands` pruned on close.
