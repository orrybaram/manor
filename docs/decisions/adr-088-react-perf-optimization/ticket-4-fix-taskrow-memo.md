---
title: Fix TaskRow memo effectiveness
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Fix TaskRow memo effectiveness

TaskRow is wrapped in `React.memo` but the parent passes `onResumeTask` and `onRemoveTask` as stable callbacks (from `useCallback`). The issue is the inline arrow functions **inside** TaskRow that wrap these callbacks with the `task` argument: `onClick={() => onResumeTask(task)}`.

However, `React.memo` compares **props**, not internal handlers. The memo is actually working correctly here — props `task`, `onResumeTask`, and `onRemoveTask` are referentially stable across renders (the parent uses `useCallback` for both handlers and `removeTask` comes from Zustand).

Re-reading the code: the memo IS effective. The inline handlers inside TaskRow don't affect memo — they're recreated only when TaskRow itself re-renders, which memo prevents. No change needed for the memo itself.

**What we CAN improve**: change TaskRow to accept `taskId: string` and `taskName: string` etc. as primitive props instead of the full `task` object, so memo comparison is cheaper and more resilient. But this is a minor optimization.

**Decision**: Skip this ticket — the memo is already working correctly. The inline handlers inside a memo'd component don't break memo; they're only created when the component actually renders.

## Files to touch
- No changes needed — this was a false positive in the audit
