---
title: Pull-to-refresh and overflow-menu Refresh / Reload app
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Pull-to-refresh and overflow-menu Refresh / Reload app

Implement the UI half of ADR-220 D5. Follow `.claude/rules/ui-components.md`: use `Button` from `src/components/ui/`, never a raw `<button>`.

## Overflow menu

In `src/components/phone/PhoneOverflowMenu.tsx`, add two items after the existing ones, separated by a divider if the menu already has a divider style:

- **Refresh** (`data-testid="overflow-refresh"`): calls `close()`, then `void refreshBridge()` from `src/bridge/install-web.ts`.
  - Check how phone components import web-only code. If importing `install-web` from a component is a problem, because it is shared with desktop, add a tiny `src/bridge/refresh.ts` that `install-web` registers a function into, and have the menu call that.
  - On desktop the menu is never shown, but keep the import safe anyway.
- **Reload app** (`data-testid="overflow-reload"`): calls `location.reload()`.

Both items are always visible, so `hasItems` (:191) must become true at all times. Make sure the trigger still renders when there are no other targets.

## Pull-to-refresh

New hook `src/components/phone/usePullToRefresh.ts`:

```ts
usePullToRefresh(ref: RefObject<HTMLElement>, onRefresh: () => Promise<void>): { pull: number; refreshing: boolean }
```

- Use touch events on the element.
- Only start tracking when `scrollTop <= 0` at `touchstart`.
- Apply damping, for example `pull = dy * 0.5`, capped at 96px.
- Trigger when the pull is past 64px on release. Set `refreshing` until `onRefresh` settles, with a minimum of 400ms so the spinner is visible.
- Use passive listeners, except the `touchmove` that has to `preventDefault` once a pull is active.
- Keep native `overscroll-behavior: contain` as it is.

Plus a small `PullIndicator` component (with a `.module.css`):
- A spinner or arrow above the content, translated by `pull`.
- Use existing theme tokens or CSS variables for colour.
- Respect `prefers-reduced-motion`.

Wire it up in two places:
- the ChatPane `.scroller` (ChatPane.tsx:209)
- the `PhoneAgentsPanel` list. Check which element scrolls there; `overscroll-behavior` is set at PhoneAgentsPanel.module.css:49.

`onRefresh` calls the same `refreshBridge`. Terminal panes are left out.

Add a unit test for the pure threshold and damping maths: put it in a pure function inside the hook file and test that.

## Files to touch
- `src/components/phone/PhoneOverflowMenu.tsx`
- `src/components/phone/usePullToRefresh.ts` — new
- `src/components/phone/PullIndicator.tsx` and `.module.css` — new
- `src/components/phone/ChatPane/ChatPane.tsx` and `ChatPane.module.css`
- `src/components/phone/AgentsDrawer/PhoneAgentsPanel.tsx` and `.module.css`
- `src/bridge/refresh.ts` (only if needed, see above)
