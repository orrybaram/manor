---
title: Remove Zustand subscribe useEffect from useTerminalHotkeys
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Remove Zustand subscribe useEffect from useTerminalHotkeys

The `useEffect` at useTerminalHotkeys.ts:20 subscribes to `useKeybindingsStore` just to keep `bindingsRef.current` updated. This is unnecessary — the codebase already uses render-time ref assignment for this pattern elsewhere (e.g., `activeSessionRef.current = activeSession` in App.tsx).

## Implementation

Replace:
```ts
useEffect(() => {
  return useKeybindingsStore.subscribe((s) => {
    bindingsRef.current = s.bindings;
  });
}, []);
```

With a direct store read + render-time assignment:
```ts
const bindings = useKeybindingsStore((s) => s.bindings);
const bindingsRef = useRef(bindings);
bindingsRef.current = bindings;
```

Remove the `useEffect` import.

## Files to touch
- `src/hooks/useTerminalHotkeys.ts` — replace useEffect with render-time ref assignment
