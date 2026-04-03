---
title: Replace all direct useEffect calls with proper patterns
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Replace all direct useEffect calls with proper patterns

`useEffect` is banned in this project. Replace every direct `useEffect` call with the appropriate pattern per the React patterns skill.

## Changes by file

### `src/components/LeafPane.tsx`

**Line 41-44 — Derived state synced via effect (DELETE)**:
```tsx
useEffect(() => {
  const focused = navState?.webviewFocused ?? false;
  setWebviewFocused(focused ? paneId : null);
}, [navState?.webviewFocused, paneId, setWebviewFocused]);
```
This is derived state. Replace with inline computation in the render body:
```tsx
// After navState is set, compute and push to store synchronously
// Actually, this calls setWebviewFocused (a store setter), so it can't be inline.
// The right fix: call setWebviewFocused in the BrowserPane's fireNavStateChange
// callback chain instead of reacting to state here. But simplest correct fix
// for now: convert to useMountEffect pattern won't work (deps change).
// Best fix: move this into the onNavStateChange callback:
```
Instead of an effect, pass a custom `onNavStateChange` handler that both sets navState AND calls setWebviewFocused:
```tsx
const handleNavStateChange = useCallback((state: BrowserPaneNavState) => {
  setNavState(state);
  setWebviewFocused(state.webviewFocused ? paneId : null);
}, [paneId, setWebviewFocused]);
```
Then pass `handleNavStateChange` instead of `setNavState` to `<BrowserPane onNavStateChange={handleNavStateChange} />`.

**Line 46-58 — DOM registration via effect (convert to ref callback)**:
```tsx
useEffect(() => {
  if (contentType !== "browser") return;
  const id = requestAnimationFrame(() => {
    if (browserRef.current) {
      registerBrowserPane(paneId, browserRef.current);
    }
  });
  return () => {
    cancelAnimationFrame(id);
    unregisterBrowserPane(paneId);
  };
}, [contentType, paneId]);
```
This is DOM node setup. The `browserRef` is only used to register the pane. However, since `BrowserPane` uses `forwardRef` + `useImperativeHandle`, the ref value is set asynchronously. The `requestAnimationFrame` is a workaround for this timing.

Simplest fix: convert to `useMountEffect` since this should only run once when the browser pane mounts (the paneId doesn't change). But it depends on `contentType`. Better: keep as `useMountEffect` and gate on contentType being "browser" at call time. Actually the component always renders either a browser or terminal, so if it's browser the effect should run once.

Convert to: Replace `useEffect` with `useMountEffect` — but `useMountEffect` doesn't take deps. Since `contentType` and `paneId` don't change for a given LeafPane instance, a mount effect is correct:
```tsx
useMountEffect(() => {
  if (contentType !== "browser") return;
  const id = requestAnimationFrame(() => {
    if (browserRef.current) {
      registerBrowserPane(paneId, browserRef.current);
    }
  });
  return () => {
    cancelAnimationFrame(id);
    unregisterBrowserPane(paneId);
  };
});
```

Remove `useEffect` from imports, add `useMountEffect` import, add `useCallback` import.

### `src/components/ProjectSetupWizard.tsx`

**Lines 74-89, 92-112, 115-141 — Mount-only effects**: All three have `[]` deps. Convert all to `useMountEffect`:

```tsx
// Line 74: Initialize state from project
useMountEffect(() => { ... });

// Line 92: Discover agents
useMountEffect(() => { ... });

// Line 115: Check Linear connection
useMountEffect(() => { ... });
```

**Lines 153-157 — Cleanup-only effect**: This is `useEffect(() => cleanup, [])`. Convert to `useMountEffect`:
```tsx
useMountEffect(() => {
  return () => {
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
  };
});
```

Replace `useEffect` import with `useMountEffect` import from `../hooks/useMountEffect`.

### `src/components/NewWorkspaceDialog.tsx`

**Lines 69-90 — Fetch branches on open/project change**: This has `[open, activeProjectId]` deps, so it's NOT mount-only. This is a data-fetching side effect driven by prop changes.

The correct pattern: this should ideally be a `useQuery` with `enabled: open && !!activeProjectId`. But since we don't want to over-architect, the simplest correct fix is to move the fetch into the `handleOpenAutoFocus` callback (which runs when dialog opens) and also call it when `activeProjectId` changes while open. Actually, the cleanest pattern is:

Since `open` and `activeProjectId` change, and we need to react to those changes, this is one of the few cases where an effect-like pattern is needed. Use `useMountEffect` won't work. The best fix here: keep the logic but wrap it in a custom hook or convert to `useQuery`:

```tsx
const { data: remoteBranches = [], isLoading: loadingBranches } = useQuery({
  queryKey: ["remote-branches", activeProjectId],
  queryFn: () => window.electronAPI.projects.listRemoteBranches(activeProjectId),
  enabled: open && !!activeProjectId,
});
```

This eliminates the effect entirely. Add `useQuery` import from `@tanstack/react-query` (already used elsewhere in the project).

**Lines 166-170 — Scroll highlighted into view**: This reacts to `highlightIndex` changes. Convert to a ref callback on the highlighted item instead:

In the dropdown rendering, use a ref callback on the highlighted item:
```tsx
ref={i === highlightIndex ? (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest" }) : undefined}
```
Delete the `useEffect` at line 166-170.

### `src/components/BrowserPane.tsx`

**Line 114-116 — Sync ref to latest callback**:
```tsx
useEffect(() => {
  onNavStateChangeRef.current = onNavStateChange;
}, [onNavStateChange]);
```
This is a ref sync pattern. Assign directly in the render body instead:
```tsx
onNavStateChangeRef.current = onNavStateChange;
```
Delete the effect.

**Lines 161-173 — Three effects syncing refs**:
```tsx
useEffect(() => { urlRef.current = url; }, [url]);
useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
useEffect(() => { highlightIndexRef.current = highlightIndex; }, [highlightIndex]);
```
Same pattern — assign directly in the render body:
```tsx
urlRef.current = url;
suggestionsRef.current = suggestions;
highlightIndexRef.current = highlightIndex;
```
Delete all three effects.

**Lines 267-358 — Webview event listener setup**: This is mount-only setup with `[paneId, ...]` deps where paneId doesn't change. Convert to `useMountEffect`:
```tsx
useMountEffect(() => {
  const wv = webviewRef.current;
  if (!wv) return;
  // ... rest of the effect body unchanged
});
```
The dependency array included store selectors (`setPaneTitle`, `setPaneUrl`, etc.) which are stable (Zustand selectors). And `paneId` doesn't change. So `useMountEffect` is correct.

### `src/components/GitHubNudge.tsx`

**Line 82 — Cleanup effect**:
```tsx
useEffect(() => cleanup, [cleanup]);
```
This runs cleanup when `cleanup` changes, but `cleanup` is a `useCallback` with `[]` deps so it's stable. This is effectively mount-only cleanup. Convert to:
```tsx
useMountEffect(() => cleanup);
```

### `src/App.tsx`

**Lines 246-251 — Wizard cleanup on project removal**:
```tsx
useEffect(() => {
  if (wizardOpen && wizardProjectId && !projects.some((p) => p.id === wizardProjectId)) {
    setWizardOpen(false);
    setWizardProjectId(null);
  }
}, [wizardOpen, wizardProjectId, projects]);
```
This is derived state — it computes whether wizard should close based on projects list. Convert to inline render-time check (same pattern as the theme ref check already at line 257):
```tsx
if (wizardOpen && wizardProjectId && !projects.some((p) => p.id === wizardProjectId)) {
  // Project was removed while wizard was open — schedule close
  // Use queueMicrotask to avoid setState during render
  queueMicrotask(() => {
    setWizardOpen(false);
    setWizardProjectId(null);
  });
}
```
Actually, the cleanest approach is the same pattern already used at line 257 for theme: use a ref to track previous value and respond to changes synchronously. But since this is a guard condition (not a derived value), the simplest approach is to just check in the render and bail out of the wizard rendering:

Replace the effect with a check right before rendering the wizard:
```tsx
const wizardStillValid = wizardOpen && wizardProjectId && projects.some((p) => p.id === wizardProjectId);
```
Then use `wizardStillValid` instead of `wizardOpen && wizardProjectId` in the JSX. No state update needed — if the project disappears, the wizard simply won't render, and the stale state will get cleared next time something triggers `closeWizard`.

### `src/components/CommandPalette/IssueDetailView.tsx`

**Lines 139-144 — Ref sync effect**:
```tsx
useEffect(() => {
  issueDetailRef.current = issueDetail;
  handleCreateWorkspaceRef.current = handleCreateWorkspace;
  handleOpenInBrowserRef.current = handleOpenInBrowser;
  handleNewTaskRef.current = handleNewTask;
});
```
Assign directly in the render body instead. Delete the effect and the eslint-disable comments around it.

## Files to touch
- `src/components/LeafPane.tsx` — replace 2 useEffects
- `src/components/ProjectSetupWizard.tsx` — replace 4 useEffects with useMountEffect
- `src/components/NewWorkspaceDialog.tsx` — replace 2 useEffects (one with useQuery, one with ref callback)
- `src/components/BrowserPane.tsx` — replace 5 useEffects (4 ref syncs + 1 useMountEffect)
- `src/components/GitHubNudge.tsx` — replace 1 useEffect with useMountEffect
- `src/App.tsx` — replace 1 useEffect with inline derived check
- `src/components/CommandPalette/IssueDetailView.tsx` — replace 1 useEffect with direct ref assignment
