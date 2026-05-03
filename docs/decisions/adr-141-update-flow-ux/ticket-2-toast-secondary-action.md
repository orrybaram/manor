---
title: Toast secondary action + dismiss control
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Toast secondary action + dismiss control

Extend the toast primitive so it can render a secondary action button and a dismiss `X` for persistent toasts. Required by the update toast (Q3: "Restart now" + "Later" + dismiss).

## Required changes

1. **`src/store/toast-store.ts`** — extend the `Toast` interface:
   ```ts
   secondaryAction?: { label: string; onClick: () => void };
   ```
   No other store changes.

2. **`src/components/ui/Toast/ToastItem.tsx`** — render order: primary `action`, then `secondaryAction` (if present) styled as a tertiary/ghost variant. For `toast.persistent === true`, render an `X` (lucide `X` icon, size 12-14) to the right of the action buttons that calls `removeToast(toast.id)`. The `X` should NOT appear on non-persistent toasts (auto-dismiss already handles them).

3. **CSS** — locate the existing `Toast.module.css` (next to `ToastItem.tsx`) and add styles for the secondary button (subtler than `.actionButton`) and the close `X` (icon button, no background). Match the existing visual language — don't invent new tokens.

4. **No regressions to existing toast callers** — secondary action is purely additive and persistent dismiss only affects toasts that were previously undismissable. Verify by grepping `addToast(` callers; none currently use a persistent toast in a way that would be harmed by gaining a dismiss button.

## Files to touch
- `src/store/toast-store.ts` — schema extension
- `src/components/ui/Toast/ToastItem.tsx` — render logic
- `src/components/ui/Toast/Toast.module.css` (or whatever co-located stylesheet exists) — styles

## Acceptance
- Existing toasts render unchanged.
- A test toast created with `{ persistent: true, action: {...}, secondaryAction: {...} }` shows three controls in order: action, secondary, X.
- Clicking X removes the toast.
- `pnpm lint` and typecheck pass.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): Toast secondary action + dismiss control"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
