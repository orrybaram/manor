---
title: Remove onEmptyChange useEffects from issue views
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Remove onEmptyChange useEffects from GitHubIssuesView and LinearIssuesView

Both components have identical `useEffect(() => { onEmptyChange?.(isEmpty); }, [isEmpty, onEmptyChange])` patterns. These notify the parent of derived state — a classic "unnecessary effect" per React docs.

## Implementation

Replace each with a render-time ref-guarded call:

```tsx
const prevEmptyRef = useRef<boolean | undefined>(undefined);
if (isEmpty !== prevEmptyRef.current) {
  prevEmptyRef.current = isEmpty;
  onEmptyChange?.(isEmpty);
}
```

Remove the `useEffect` import from both files (replace with `useRef`).

## Files to touch
- `src/components/CommandPalette/GitHubIssuesView.tsx` — replace useEffect with render-time ref guard
- `src/components/CommandPalette/LinearIssuesView.tsx` — replace useEffect with render-time ref guard
