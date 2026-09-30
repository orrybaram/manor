---
title: Drop the renderer's duplicate last-used-host write
status: todo
priority: medium
assignee: haiku
blocked_by: [2]
---

# Drop the renderer's duplicate last-used-host write

In `src/store/project-store.ts` `createWorktree`, delete the two lines after the `set(...)`:

```ts
    // A linked project's host picker starts here next time (ADR-192).
    if (updated.group)
      void get().setGroupLastUsedHost(updated.group.id, updated.hostId);
```

Main records it now (ADR-203 §4). Touch nothing else in the file — another workspace is editing
it. Update any renderer test that asserted this call (grep `setGroupLastUsedHost` under `src/`).

## Files to touch
- `src/store/project-store.ts` — delete those lines only
