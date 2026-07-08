---
title: Store — caller-supplied pane IDs, split URL, layout snapshot
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Store — caller-supplied pane IDs, split URL, layout snapshot

Pane IDs are minted inside store actions (`newPaneId()`), so a caller can't learn
the ID of the pane it just created. Let callers supply one. Also fix
`splitPaneAt` dropping `url`, and add a serializable layout snapshot.

## 1. `splitPaneAt` — options bag, `url`, `paneId`

Current signature (`src/store/app-store.ts:1154`):

```ts
splitPaneAt(targetPaneId, direction, position, contentType?, paneCommand?)
```

Seven positional params is too many. Collapse the trailing optionals:

```ts
splitPaneAt(
  targetPaneId: string,
  direction: SplitDirection,
  position: "first" | "second",
  opts?: {
    contentType?: "terminal" | "browser" | "diff" | "task";
    paneCommand?: string;
    url?: string;
    /** Caller-supplied pane ID; defaults to newPaneId(). */
    paneId?: string;
  },
): void
```

Inside: `const newPane = opts?.paneId ?? newPaneId();`

**Bug to fix while here:** the action sets `paneContentType[newPane]` but never
`paneUrl[newPane]`. Pass `url` into `insertSplitAt`'s leaf and set
`paneUrl: { ...state.paneUrl, [newPane]: url }` when `url` is given. This is why
in-app "Split with → Browser" yields a browser pane with an empty URL bar.
Check whether `insertSplitAt` in `src/store/pane-tree.ts` accepts a `url` for the
new leaf — if not, add it (the `PaneNode` leaf already has an optional `url`).

**Update all call sites** to the options bag. Find them with
`grep -rn 'splitPaneAt' src/`. Known: `SplitWithSubmenu.tsx`, `TerminalPane.tsx`,
`LeafPane.tsx`, `useCommands.tsx`, `PaneDropZone.tsx` (verify against grep — do
not trust this list).

## 2. `addBrowserTab` — accept `paneId`

`src/store/app-store.ts:647` — widen the opts bag:

```ts
addBrowserTab(url: string, opts?: { background?: boolean; paneId?: string })
```

`const paneId = opts?.paneId ?? newPaneId();`

`addTab(paneId?)` and `addTerminalTab(command, paneId?)` already accept one — no
change needed there. Note `addTerminalTab` uses `tab.focusedPaneId` (not the
`paneId` arg) as the pending-command key; confirm `createTab(undefined, paneId)`
sets `focusedPaneId === paneId` so they agree.

## 3. `paneTreeSnapshot` selector

New export in `src/store/pane-tree.ts` (pure, no store import — take the pieces
it needs as arguments so it stays unit-testable like the rest of that module):

```ts
export interface PaneSnapshot {
  paneId: string;
  contentType: "terminal" | "browser" | "diff";
  url?: string;
  focused: boolean;
}
export interface TabSnapshot {
  tabId: string;
  title: string;
  active: boolean;
  focusedPaneId: string;
  panes: PaneSnapshot[];
}
export function flattenPaneTree(
  node: PaneNode,
  focusedPaneId: string,
  paneContentType: Record<string, string>,
  paneUrl: Record<string, string>,
): PaneSnapshot[]
```

`contentType` resolves from the store's `paneContentType` map (the source of
truth) with a `"terminal"` default when absent — **not** from the tree leaf's
inline `contentType`, which `swapSiblings` and `updateLeafContentType` discard.
Same for `url` / `paneUrl`. Depth-first, left-to-right order.

Then a thin `getLayoutSnapshot()` on the store (in `app-store.ts`, using
`getActivePanelContext`) returning `{ workspacePath, tabs: TabSnapshot[] }` across
all panels of the active workspace. Flatten panels into one `tabs` array —
panel-level structure is explicitly out of scope (see ADR Consequences).

## Files to touch

- `src/store/pane-tree.ts` — `flattenPaneTree` + snapshot types; `url` on `insertSplitAt` if missing
- `src/store/app-store.ts` — `splitPaneAt` options bag + `url` fix + `paneId`; `addBrowserTab` `paneId`; `getLayoutSnapshot`
- All `splitPaneAt` call sites found by grep
- `src/store/pane-tree.test.ts` — `flattenPaneTree` cases: single leaf, nested splits (assert DFS order), missing `paneContentType` → `"terminal"`, `url` only on browser panes, `focused` set on exactly one pane
- `src/store/__tests__/app-store-add-browser-tab.test.ts` — supplied `paneId` is used verbatim; omitted `paneId` still generates one
- New `src/store/__tests__/app-store-split-pane-at.test.ts` — supplied `paneId` used; `url` lands in `paneUrl`; `contentType: "task"` still not persisted to the tree (`app-store.ts:1170`)

## Constraint

Behavior-preserving for every existing caller. The options-bag conversion is a
pure refactor; `pnpm typecheck` catching every call site is the point.
