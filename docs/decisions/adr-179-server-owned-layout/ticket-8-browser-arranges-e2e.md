---
title: E2E — the browser arranges, the desk follows, and back
status: done
priority: high
assignee: sonnet
blocked_by: [5, 6, 7]
---

# E2E — the browser arranges, the desk follows, and back

ADR-179 D7 proven end to end, same discipline as `tests/e2e/web-app.spec.ts`
(real app, real listener, real browser page, nothing fabricated).

## `tests/e2e/web-app.spec.ts` — extend

1. **Browser splits, desk shows it.** From the browser, split the shared
   terminal pane (command palette or the pane menu). Assert the desktop
   window renders two panes (`assertVisiblePaneCount`), and `GET /panes`
   lists both.
2. **Desk closes, browser follows.** Close the new pane on the desktop.
   Assert the browser is back to one pane and shows no error toast.
3. **No toast.** Assert the "Layout changes aren't saved" toast never
   appears (it no longer exists — assert by text absence after step 1).
4. **Selection is local.** Open a second tab on the desktop; select tab 1 in
   the browser and tab 2 on the desktop; assert each still shows its own
   after a `layout.changed` (e.g. rename a pane title from the browser).
5. **Reopen from the browser.** Close a pane on the desktop, reopen it from
   the browser's palette; it is back on both.

## `tests/e2e/detach.spec.ts` — from ticket 6, if it was not written there

Detach on the desktop, assert the browser still lists the tab and can type
into it, close the popup, the tab is back in the primary.

## Also

- Remove any fixture/helper that reached into `layout.save` or
  `_cachedLayout`.
- `pnpm test:e2e` full run green.

## Files to touch
- `tests/e2e/web-app.spec.ts`, `tests/e2e/detach.spec.ts`
- `tests/e2e/helpers/*` — only what the above needs
