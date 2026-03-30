---
title: Narrow Zustand store selectors for paneCwd and paneTitle
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Narrow Zustand store selectors for paneCwd and paneTitle

The `useSessionTitle` hook and `CommandPalette` component subscribe to the entire `paneCwd` and `paneTitle` maps from the app store. This causes every session tab and the command palette to re-render whenever *any* pane's title or CWD changes.

## Implementation

### 1. Refactor `useSessionTitle` in `SessionButton.tsx`

Currently (lines 10-49):
```ts
const paneCwd = useAppStore((s) => s.paneCwd);
const paneTitle = useAppStore((s) => s.paneTitle);
```

Change to narrow selectors that only subscribe to the specific pane's data:

```ts
function useSessionTitle(sessionId: string): string {
  // First, resolve which pane ID we care about
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    return session?.focusedPaneId ?? null;
  });

  // Then subscribe narrowly to just that pane's title and CWD
  const title = useAppStore((s) => focusedPaneId ? s.paneTitle[focusedPaneId] ?? null : null);
  const cwd = useAppStore((s) => focusedPaneId ? s.paneCwd[focusedPaneId] ?? null : null);

  // Keep the existing title derivation logic (user@host stripping, CWD fallback)
  // but remove the loop over allPaneIds — that was a fallback that subscribed to everything
  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const path = cwdMatch[1];
      const parts = path.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }
  return "Terminal";
}
```

Note: The existing fallback loop (`for (const id of ids)` over `allPaneIds`) subscribed to all pane data. Remove it — the focused pane's title/CWD is sufficient for the tab label. The session title (`session.title`) fallback can use a separate narrow selector if needed.

### 2. Narrow selectors in `CommandPalette.tsx`

Currently (lines 84-85):
```ts
const paneTitle = useAppStore((s) => s.paneTitle);
const paneCwd = useAppStore((s) => s.paneCwd);
```

These are used in the `recentCommands` memo to look up titles for recent views. Replace with a derived selector that extracts only the relevant pane IDs:

```ts
// Derive the specific pane IDs we need from recent views
const recentPaneIds = useMemo(() => {
  const ids: string[] = [];
  for (const rv of recentViews) {
    const ws = useAppStore.getState().workspaceSessions[rv.workspacePath];
    const session = ws?.sessions.find((s) => s.id === rv.sessionId);
    if (session) ids.push(session.focusedPaneId);
  }
  return ids;
}, [recentViews]);

const recentPaneTitles = useAppStore(
  useCallback((s: AppState) => {
    const result: Record<string, string> = {};
    for (const id of recentPaneIds) {
      if (s.paneTitle[id]) result[id] = s.paneTitle[id];
    }
    return result;
  }, [recentPaneIds]),
  shallow
);

const recentPaneCwds = useAppStore(
  useCallback((s: AppState) => {
    const result: Record<string, string> = {};
    for (const id of recentPaneIds) {
      if (s.paneCwd[id]) result[id] = s.paneCwd[id];
    }
    return result;
  }, [recentPaneIds]),
  shallow
);
```

Import `shallow` from `zustand/shallow` for the equality check on the derived objects.

Then update the `recentCommands` memo to use `recentPaneTitles` and `recentPaneCwds` instead of the full maps.

## Files to touch
- `src/components/SessionButton.tsx` — refactor `useSessionTitle` to use narrow selectors
- `src/components/CommandPalette.tsx` — replace wide `paneTitle`/`paneCwd` subscriptions with derived narrow selectors
