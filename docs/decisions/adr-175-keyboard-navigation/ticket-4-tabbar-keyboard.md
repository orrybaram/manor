---
title: Tab bar — tablist semantics, roving focus, focusable close and add buttons
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Tab bar — tablist semantics, roving focus, focusable close and add buttons

1. `TabBar.tsx`: container `role="tablist"` (`aria-orientation="horizontal"`).
2. `TabButton.tsx:107`: `role="tab"`, `aria-selected`, `tabIndex` 0 for the
   selected tab else -1. onKeyDown (only when `e.target === e.currentTarget`):
   ←/→ move focus to prev/next tab (wrap), Home/End first/last, Enter/Space
   select (same as click). Leave Shift+F10 / Meta+. hook for ticket 5.
3. Close control (`:157`) → `<Button>` from `ui/Button` (icon variant),
   `aria-label="Close tab"`, `data-testid="tab-close"`, `tabIndex` follows
   the tab (0 only when its tab is focused/selected so Tab from a tab reaches
   it). Keep hover-only visual but also visible on `:focus-visible` and when
   the tab has `:focus-within`. Same for the mute control (`:137`) with
   `aria-label`.
4. "+" button (`TabBar.tsx:626`): `aria-label="New tab"`. Shift+F10 on it
   opens the Browser/Agent popover that currently opens on right-click.
5. Focus style: `:focus-visible` ring on tabs (`TabBar.module.css`).
6. Selecting a tab via Enter must keep focus on the tab (the terminal
   focus-steal is suppressed by `isNavRegionFocused` from ticket 2).

## Files to touch
- `src/components/tabbar/TabBar.tsx`, `TabButton.tsx`, `TabBar.module.css`
