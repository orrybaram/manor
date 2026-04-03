---
title: Remove theme sync useEffect from App.tsx
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Remove theme sync useEffect from App.tsx

The `useEffect` at App.tsx:116 syncs `currentProjectThemeName` to `applyProjectTheme`. This is state-to-state synchronization that should happen in the store.

## Implementation

Move the theme application into the project store's `selectWorkspace` / `setSelectedProjectIndex` actions, or add a Zustand `subscribe` call inside the theme store that reacts to project store changes. The simplest approach: in `App.tsx`, replace the `useEffect` with a render-time ref-guarded call since `applyProjectTheme` is idempotent.

**Preferred approach** — render-time ref guard in App.tsx:
```tsx
const prevThemeRef = useRef(currentProjectThemeName);
if (currentProjectThemeName !== prevThemeRef.current) {
  prevThemeRef.current = currentProjectThemeName;
  applyProjectTheme(currentProjectThemeName);
}
```

Remove the `useEffect` import if no longer needed (check other usages in the file first — the `useMountEffect` calls don't use it directly).

## Files to touch
- `src/App.tsx` — remove useEffect at line 116, add render-time ref guard
