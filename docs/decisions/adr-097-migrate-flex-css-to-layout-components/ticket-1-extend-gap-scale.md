---
title: Extend Layout gap scale with missing sizes
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Extend Layout gap scale with missing sizes

Add `"2xs": 2` and `"xxs": 6` to the `gapScale` record and `GapSize` type in `Layout.tsx`.

## Files to touch
- `src/components/ui/Layout/Layout.tsx` — add `"2xs": 2` and `"xxs": 6` to `GapSize` type and `gapScale` record. Insert them before `"xs"` to maintain ascending order.
