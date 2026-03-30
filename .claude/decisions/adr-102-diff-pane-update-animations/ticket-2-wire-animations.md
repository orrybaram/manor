---
title: Track file changes and apply animation classes
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Track file changes and apply animation classes

Wire the CSS animation classes into the DiffPane component by tracking which files are new or updated across diff refreshes.

## Implementation

1. Create a `useRef` to store the previous file state: a `Map<string, number>` mapping file path → a simple content hash (`file.added * 1000 + file.removed + file.lines.length`).

2. After `files` are computed from `parseDiff`, compare against the previous state:
   - Files in current but not in previous → mark as "new"
   - Files in both but with different hash → mark as "updated"
   - Store results in a `useState<Map<string, "new" | "updated">>` (so it triggers re-render with classes)

3. After rendering with animation classes, clear the animation state after the animation duration (~500ms) using a `useEffect` with `setTimeout`.

4. Update the previous file state ref after comparison.

5. Apply classes:
   - On the `.file` div: add `styles.fileNew` or `styles.fileUpdated`
   - On the `.fileListItem` div: add `styles.fileListItemNew` or `styles.fileListItemUpdated`

6. Skip animations on initial load (when previousFiles ref is empty/null).

## Files to touch
- `src/components/workspace-panes/DiffPane/DiffPane.tsx` — add ref tracking, state for animation classes, useEffect for cleanup, apply classes to elements
