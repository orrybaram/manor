---
title: Phone chrome — top bar, tab strip, no status bar
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Phone chrome — top bar, tab strip, no status bar

ADR-181 D3. Ticket 2 makes one pane fill the screen; this gives it a frame.

## What to build

In phone mode (`useLayoutMode()` from ticket 1), `App.tsx`'s primary render:

- **Top bar** — a new `src/components/phone/PhoneTopBar.tsx`: a drawer toggle
  (left), the active workspace's display name (centre, truncated), the
  pane-switcher button and the palette button (right). The two buttons only
  *call* callbacks here; tickets 4, 5 and 6 build what they open, so wire them
  to state in `App.tsx` that those tickets consume. Use `<Button>` from
  `ui/Button` and lucide icons (the repo's rule in `.claude/rules/ui-components.md`).
  Touch targets at least 44 × 44 px.
- **Tab strip** — the active panel's existing `TabBar`, restyled for phone
  under `.app[data-layout="phone"]`: one row, horizontal scroll, no
  new-tab-drag affordances. Only the *active* panel's tab bar shows; the
  others belong to panels ticket 2 has hidden.
- **Status bar** — not rendered in phone mode.
- **Sidebar** — not rendered inline in phone mode (ticket 4 puts it in a
  drawer).

Desk mode is unchanged. Keep the phone-only styles in
`src/components/phone/Phone.module.css` and the `data-layout` selectors, not
scattered media queries — `useLayoutMode` is the one breakpoint.

The phone shell's height is `100lvh` (large viewport), **not** `100dvh` —
ticket 7 depends on the soft keyboard never changing the shell's height. Say
so in a comment where you set it.

## Files to touch
- `src/components/phone/PhoneTopBar.tsx` — new
- `src/components/phone/Phone.module.css` — new
- `src/App.tsx` — phone-mode chrome, state for drawer / switcher / palette-open
- `src/components/tabbar/TabBar/*` — phone styling only
