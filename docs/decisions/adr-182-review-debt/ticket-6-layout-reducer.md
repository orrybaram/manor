---
title: Layout reducer as take + graft with a typed handler table
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Layout reducer as take + graft with a typed handler table

ADR-182 D6, which also fixes regression 3 (a reopened browser pane loses its URL).

## Problem
`src/lib/layout/commands.ts` is 1490 lines:
- **Duplicated moves.** Six move-style handlers each re-implement "remove from source, attach to target". Across them are 8 inline `pinnedTabIds ?? []` filters and 11 `t.id === X ? {...t, rootNode} : t` mappers.
- **Inconsistent empty-panel handling:**
  - `splitPanel` and `splitPanelWithTab` never remove the panel they emptied.
  - `moveTabToPanel` removes it but has no fallback tab.
  - `closeTab` leaves an empty sole panel behind.
- **Speculative fallback ids.** `fallbackTab`/`fallbackPanelId` force 9 sender sites to mint tabs speculatively.
- **Dead output.** `releasedPanes` is computed in 6 branches and never read.
- **Hand-synced list.** `COMMAND_TYPES` (`layout-store.ts:154`) duplicates the command union by hand.

## Take and graft
- Add two primitives:
  - `take(layout, { tabId } | { paneId }) → { layout, subtree }`
  - `graft(layout, target, subtree)`
- **Empty-panel rule.** Pick one rule and apply it inside `take`: an emptied non-sole panel is removed, and an emptied sole panel stays as a legal empty panel. Check `closeTab` and the empty-layout rendering so the rule matches current visible behaviour. Document any behaviour change in the commit message.
- **Moves.** Each move becomes take + graft + hint.
- **Drop the fallback fields.** Remove `fallbackTab`/`fallbackPanelId` from the commands, and remove the speculative `createTab()`/`newPanelId()` at the sender sites (`app-store.ts:~1690,1708,1737,2102,2113,2164,2178` and the routes).
- **Merge split commands.** Fold `split-pane` into `split-pane-at` with `position: "second"`.

## Handler table
- Replace the big switch with `const HANDLERS: { [K in LayoutCommand["type"]]: Handler<Extract<LayoutCommand, { type: K }>> }`.
- Export `isLayoutCommandType = (t): t is … => t in HANDLERS`, and delete `COMMAND_TYPES` in `layout-store.ts`.

## Result shape
- The reducer returns `{ layout, closedStack, killPanes, hint? }`. Delete `releasedPanes`, and stop `LayoutEffects` from extending `LayoutHint`.
- `LayoutStore.apply` returns `{ version, hint, addedPaneIds }`.
- Remove the callers' before/after diffs and pre-checks:
  - `routes/panes.ts` `/panes/reopen` (~411-438)
  - `/tabs/:id/pin` `wasPinned` (~915)
  - the extract no-op pre-checks in the route (~593) and in `app-store.extractPaneToTab` (~1721)

## Closed stack
- `ClosedPaneEntry` becomes `{ leaf, tabId, panelId, title? }`, reinserted with `insertSubtreeAt`. This keeps the URL and content type.
- Delete:
  - the reducer's third `paneMetadata` argument
  - `treeMetadata`/`paneMetadata` in `layout-store.ts`, plus its `as PaneContentType` cast
  - the `PaneMetadata*` types
  - `ClosedTabEntry.paneMetadata`

## Module split
Split into `src/lib/layout/commands/{types,tabs,panes,panels,graft,index}.ts`, each under 400 lines. Keep the public import path `src/lib/layout/commands` working via `index.ts`.

## Tests
- Keep `src/lib/layout/__tests__/commands.test.ts` green. Adapt it only where fallback fields or `releasedPanes` disappear.
- Add a test for reopening a closed browser pane with its URL.

## Files to touch
- `src/lib/layout/commands.ts` → `src/lib/layout/commands/*`, `src/lib/layout/__tests__/commands.test.ts`
- `electron/layout/layout-store.ts`, `electron/routes/panes.ts` (the sender sites only), `src/store/app-store.ts` (the sender sites only), `src/store/__tests__/fake-layout-server.ts`
