---
title: Fix integration — setState-in-effect lint errors in the remove dialogs
status: done
priority: high
assignee: sonnet
blocked_by: [13]
---

# Fix integration — setState-in-effect lint errors in the remove dialogs

`pnpm lint` fails with two errors ("Calling setState synchronously within an
effect can trigger cascading renders"):
`src/components/sidebar/RemoveProjectDialog.tsx:27` and
`src/components/sidebar/RemoveFromHostDialog.tsx:29`. Both come from ticket
13's `useEffect`, which resets "Also delete its pod and disk" to checked
whenever the dialog opens.

Remove the effect and reset the state without one. Prefer remounting the
dialog body per opening with a `key`, or resetting in the open handler or
the close handler. Keep the behaviour: every opening starts checked.

## Files to touch
- `src/components/sidebar/RemoveProjectDialog.tsx`
- `src/components/sidebar/RemoveFromHostDialog.tsx`
