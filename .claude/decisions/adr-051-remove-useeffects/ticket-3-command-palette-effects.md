---
title: Remove two useEffects from CommandPalette
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Remove two useEffects from CommandPalette

Two effects in CommandPalette.tsx can be moved to event handlers:

### Effect 1 (line 90): Check connection status when `open` changes
Move the Linear/GitHub connection checks into a callback that runs when the palette opens. The component receives `open` as a prop — the parent controls when it opens. Add the async checks to a new `handleOpen` pattern or use an `onOpenChange` approach.

**Approach**: Add state-setting to a ref-guarded render-time check, or add a `checkConnections` call that the parent triggers. Simplest: render-time ref guard.

```tsx
const prevOpenRef = useRef(false);
if (open && !prevOpenRef.current) {
  // Just opened — fire connection checks
  window.electronAPI.linear.isConnected()
    .then(setLinearConnected).catch(() => setLinearConnected(false));
  window.electronAPI.github.checkStatus()
    .then((s) => setGithubConnected(s.installed && s.authenticated))
    .catch(() => setGithubConnected(false));
}
prevOpenRef.current = open;
```

### Effect 2 (line 103): Reset state when palette closes
Move the state resets into the `onClose` handler. The `handleOpenChange` callback already calls `onClose()` — create a local `handleClose` that resets state AND calls `onClose`:

```tsx
const handleClose = useCallback(() => {
  setView("root");
  setSearch("");
  setSelectedIssueId(null);
  setSelectedGitHubIssueNumber(null);
  setIssueListEmpty(false);
  onClose();
}, [onClose]);
```

Then use `handleClose` everywhere `onClose` is currently used within the component.

Remove the `useEffect` import if no longer needed.

## Files to touch
- `src/components/CommandPalette/CommandPalette.tsx` — remove both useEffects, add render-time open check and handleClose wrapper
