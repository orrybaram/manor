---
title: Replace just-updated pair with takeJustUpdated
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Replace just-updated pair with takeJustUpdated

`src/components/statusbar/StatusBar/StatusBar.tsx:135-137` adds a raw `useEffect` (banned by `.claude/skills/react/useEffect.md`) to call `acknowledgeJustUpdated()` once About has opened. `hasJustUpdated` is memoized and StatusBar is its only consumer.

Replace `hasJustUpdated` + `acknowledgeJustUpdated` in `src/lib/just-updated.ts` with a single `takeJustUpdated(): boolean` that returns whether an update just landed and acknowledges it in the same call (idempotent: a second call returns false). StatusBar uses it as the `useState` initializer (`useState(takeJustUpdated)`); delete the effect. Preserve the behaviour that a remount (crossing the phone breakpoint) does not reopen About. Update `src/lib/__tests__/just-updated.test.ts` and any other callers (grep).

## Files to touch
- `src/lib/just-updated.ts`
- `src/lib/__tests__/just-updated.test.ts`
- `src/components/statusbar/StatusBar/StatusBar.tsx`
