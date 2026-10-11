---
title: Centralize drawer close wiring and extract swipe hooks
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Centralize drawer close wiring and extract swipe hooks

- `src/components/sidebar/Sidebar/Sidebar.tsx:426-435` composes `onShowAll={onShowAgents && (() => { onShowAgents(); onNavigate?.(); })}` — drawer behaviour in the desk Sidebar, against ADR-219 ("Sidebar is untouched").
- `src/components/phone/PhoneChrome.tsx:72-96` copy-pastes `setDrawerOpen(false); fn()` five times but passes `onShowAgents` unwrapped.
- `SidebarDrawer.tsx:221,242` closes via `onNavigate` too.
- `SidebarDrawer.tsx:45-168` holds two touch state machines; `useEdgeSwipeToOpen` exported for PhoneChrome. They lock direction differently (edge-open `:81` `|dy| > AXIS_SLOP_PX && |dy| > dx`; close `:141-143` locks after 8px). The component's JSDoc (`:26-44`) is orphaned above `AXIS_SLOP_PX`.
- `PhoneChrome.tsx:48-50` gates edge swipe on `!notificationsOpen` only; Settings, palette, other dialogs aren't covered.

Do:
1. One `closeThen(fn)` in PhoneChrome wrapping every outbound drawer action including `onShowAgents`; revert the Sidebar `onShowAll` composition to plain `onShowAll={onShowAgents}`. Remove redundant close-via-`onNavigate` paths where `closeThen` now covers them (keep `onAgentSelect={onNavigate}` if it is the only close for that action).
2. Move both hooks to `src/components/phone/useDrawerSwipe.ts` with one shared direction-lock helper; restore the JSDoc onto `SidebarDrawer`.
3. Edge swipe takes `enabled`; PhoneChrome passes "no other modal/sheet open" (notifications, settings, palette, overflow menu — find their open state).
4. `tests/e2e/phone.spec.ts:353`: replace `if (!(await drawer.isVisible()))` with `await expect(drawer).toBeHidden()` and reopen unconditionally. Do NOT run Playwright.
5. Keep `.claude/rules/ui-components.md` (no raw buttons).

## Files to touch
- `src/components/sidebar/Sidebar/Sidebar.tsx`
- `src/components/phone/PhoneChrome.tsx`
- `src/components/phone/SidebarDrawer.tsx`
- `src/components/phone/useDrawerSwipe.ts` (new)
- `tests/e2e/phone.spec.ts`
