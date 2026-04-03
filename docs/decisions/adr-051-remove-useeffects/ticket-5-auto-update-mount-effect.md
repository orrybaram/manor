---
title: Convert useAutoUpdate to useMountEffect
status: done
priority: low
assignee: haiku
blocked_by: []
---

# Convert useAutoUpdate to useMountEffect

`useAutoUpdate.ts` uses raw `useEffect` with `[addToast]` as deps. Since `addToast` is a stable Zustand selector, this is effectively a mount-only effect. Convert to `useMountEffect` for consistency with the project's progressive useEffect ban.

## Implementation

```ts
import { useMountEffect } from "./useMountEffect";
import { useToastStore } from "../store/toast-store";

export function useAutoUpdate() {
  const addToast = useToastStore((s) => s.addToast);

  useMountEffect(() => {
    if (!window.electronAPI?.updater?.onUpdateDownloaded) return;
    const cleanup = window.electronAPI.updater.onUpdateDownloaded(
      ({ version }: { version: string }) => {
        addToast({ ... });
      },
    );
    return cleanup;
  });
}
```

Remove `useEffect` import, add `useMountEffect` import.

## Files to touch
- `src/hooks/useAutoUpdate.ts` — swap useEffect for useMountEffect
