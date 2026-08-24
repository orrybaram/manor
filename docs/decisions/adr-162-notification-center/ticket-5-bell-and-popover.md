---
title: Bell entry point and notifications popover
status: todo
priority: high
assignee: opus
blocked_by: [3, 4]
---

# Bell entry point and notifications popover

The user-facing surface: a bell with an unread badge in the sidebar titlebar,
opening a popover that lists notification history grouped by day.

## 1. Popover component

New `src/components/notifications/NotificationsPopover.tsx` +
`NotificationsPopover.module.css`.

Structure follows `src/components/sidebar/PrPopover.tsx` — Radix
`@radix-ui/react-popover` — but **click-triggered, not hover**. `PrPopover`'s
hover-with-delay behaviour suits a badge you brush past; a notification list is
something you deliberately open.

Trigger: a bell (`lucide-react/dist/esm/icons/bell`) rendered as `<Button
variant="ghost" size="sm">` from `src/components/ui/Button/Button`, wrapped in
`Tooltip` from `src/components/ui/Tooltip/Tooltip`. Per the project's
ui-components rule, never a raw `<button>` for this. Unread count renders as a
small badge overlaying the bell; hide it entirely at zero.

Content:

- Header: "Notifications", plus "Mark all read" (disabled at zero unread) and
  "Clear" actions. These are `Button variant="ghost"`/`link` — match whatever
  the existing popover and section headers use.
- Empty state when the list is empty: a single muted line, in the style of
  `TasksView.module.css`'s `.empty`.
- Scrollable body, grouped by day using `getDateBucket` / `BUCKET_ORDER` from
  `src/utils/date-buckets.ts` (ticket 4), bucketing on `record.timestamp`,
  rendered in `BUCKET_ORDER` sequence with a group header per non-empty bucket.
  This mirrors `TasksView`'s date-group markup — reuse its visual language.
- Row: kind icon, `title`, `body` (single line, ellipsized), relative time via
  `relativeShortThenDate` from `src/utils/relative-time.ts`, and an unread dot
  for `!record.read`. Unread rows read slightly stronger than read ones.
  Icons by kind — pick from `lucide-react` in the style already used across the
  sidebar (e.g. message-square for `pr-comment`, circle-check for
  `pr-approved`, circle-x for `pr-changes-requested` / `pr-checks-failed`,
  and something agent-flavoured for `agent-responded` /
  `agent-requires-input`; `AgentDot` is available if it fits).
- Row click → `navigateToNotification(record)` from
  `src/utils/notification-navigation.ts` (ticket 3), then close the popover.
  That helper already marks the record read.

State comes from `useNotificationStore` (ticket 3). The component reads and
calls actions; it does not talk to `window.electronAPI` directly.

Styling: CSS module using the app's existing custom properties — copy the token
usage from `PrPopover.module.css` and `TasksView.module.css` rather than
inventing colours. Cap the popover height and let the body scroll.

## 2. Mount it

`src/components/sidebar/Sidebar/Sidebar.tsx` — render
`<NotificationsPopover />` inside the `styles.titlebar` div, after the
`styles.navControls` group holding the back/forward buttons. Add whatever
minimal flex/gap rule `Sidebar.module.css` needs to seat it on the right of
that row; do not restructure the titlebar.

## Verification

`npm run typecheck` and `npm run build` must pass. Check the popover renders at
both narrow and wide sidebar widths (the sidebar is user-resizable) — the
popover content should have its own width and not inherit the sidebar's.

## Files to touch

- `src/components/notifications/NotificationsPopover.tsx` — new.
- `src/components/notifications/NotificationsPopover.module.css` — new.
- `src/components/sidebar/Sidebar/Sidebar.tsx` — mount the bell in the titlebar.
- `src/components/sidebar/Sidebar/Sidebar.module.css` — titlebar layout tweak
  if needed.
