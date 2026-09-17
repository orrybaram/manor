---
title: Secondary surfaces — ports, PR badge, processes, recorder, theme picker, welcome, toast
status: done
priority: medium
assignee: sonnet
blocked_by: [5, 6]
---

# Secondary surfaces — ports, PR badge, processes, recorder, theme picker, welcome, toast

Make each of these operable by keyboard, using `ui/Button` where it is a
button, or `role="button"` + `tabIndex=0` + Enter/Space where the element
must stay a container:

1. Ports: section header collapse (`PortsList.tsx:62`), group header
   (`PortGroup.tsx:32`), port badges (`PortBadge.tsx:51`, Enter = same as
   click, Shift+F10 = context menu via ticket 5 helper).
2. PR badge trigger (`PrPopover.tsx:131-150`): focusable, opens on focus and
   Enter, Escape closes. Allow content auto-focus when opened by keyboard
   (currently prevented).
3. Processes view (`ProcessesView.tsx:173, 219, 249, 301, 345, 385`): remove
   `tabIndex={-1}`, give each `Command.Item` an `onSelect` that runs its
   primary action (e.g. kill), so Enter works in the list.
4. Keybinding recorder (`KeybindingsPage.tsx:75-96, 150-157`): Escape
   cancels, Tab/Shift+Tab not captured, reject combos without a modifier
   unless F1–F12, focus returns to the row's button when recording ends.
5. Project theme picker rows (`ProjectSettingsPage.tsx:150`): same arrow-key
   listbox behaviour as `ThemeSection.tsx:112-120`.
6. Welcome drop zone (`WelcomeEmptyState.tsx:57`): focusable, Enter opens
   the project picker.
7. Toast expand (`ToastItem.tsx:69`): button.
8. Sidebar agent row close span (`AgentsList.tsx`): `ui/Button` with label.
9. Diff stats span on workspace row (`ProjectItem.tsx:183`): if clickable,
   make it a button inside the row (keys on it must not trigger row keys —
   the row handler already checks `e.target === e.currentTarget`).
10. Notifications: add bindable `open-notifications` command (no default)
    and a palette entry; rows get ↑/↓ navigation in the popover and mark
    read on focus (same 3s rule as hover).

Run the pointer-only sweep test from `keyboard-navigation.spec.ts` and fix
anything else it lists.

## Files to touch
- `src/components/ports/*`, `src/components/sidebar/PrPopover.tsx`, `ProjectItem.tsx`, `AgentsList.tsx`
- `src/components/command-palette/ProcessesView.tsx`
- `src/components/settings/KeybindingsPage.tsx`, `ProjectSettingsPage.tsx`
- `src/components/*/WelcomeEmptyState.tsx`, `src/components/ui/Toast/ToastItem.tsx`
- `src/components/notifications/*`, `src/lib/keybinding-defs.ts`, `useCommands.tsx`
