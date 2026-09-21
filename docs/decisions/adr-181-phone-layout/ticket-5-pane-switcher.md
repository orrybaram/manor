---
title: The pane switcher sheet
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# The pane switcher sheet

ADR-181 D3/D4. With no swipe (D4), this sheet and the tab strip are how a
phone moves between panes.

- A new `src/components/phone/PaneSwitcherSheet.tsx`: a bottom sheet (Radix
  Dialog, anchored to the bottom, drag handle optional) opened by ticket 3's
  switcher button.
- It lists the **active workspace's** panels → tabs → panes, in layout order.
  Each row: the pane's title (the same source `useTabTitle` / `paneTitle`
  use), a terminal/browser/diff icon, and the pane's agent dot (reuse
  `AgentDot` / `pickBestPaneStatus` so it matches the desk exactly). The
  current pane is marked.
- Tapping a row sets the viewport with the **existing** actions —
  `focusPanel`, `selectTab`, `focusPane` — and closes the sheet. No new state:
  "which pane is the phone showing" *is* the viewport (ADR-179 D3, ADR-181
  Context). Ticket 2 then makes that pane the visible one.
- Claimed tabs (another desktop window holds them, ADR-179 D4) are shown, since
  a browser is never a claimant and sees the whole workspace.

## Tests

Unit: given a layout with two panels and a split tab, the sheet lists every
pane; tapping one calls the right viewport actions.

## Files to touch
- `src/components/phone/PaneSwitcherSheet.tsx` — new
- `src/App.tsx` — render it in phone mode
- `src/components/phone/__tests__/PaneSwitcherSheet.test.tsx` — new
