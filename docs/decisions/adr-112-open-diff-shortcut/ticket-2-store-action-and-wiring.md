---
title: Add openDiff store action and wire keybinding
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add openDiff store action and wire keybinding

Create a new store action that respects the preference, and wire it to the keyboard shortcut and command palette.

## Tasks

### 1. Add `openDiffInNewPanel` action to app-store

In `src/store/app-store.ts`, add a new action `openDiffInNewPanel` near the existing `openOrFocusDiff` (around line 776). This action should:

1. First search for an existing diff pane (same logic as `openOrFocusDiff` lines 729-756). If found, focus it and return.
2. If no existing diff, create a new panel split (horizontal) with a diff tab:
   - Get active panel context via `getActivePanelContext(state)`
   - Generate `newPanelId()`, `newPaneId()`, `newTabId()`
   - Create a Tab with `contentType: "diff"` 
   - Use `insertPanelSplit(layout.panelTree, panel.id, "horizontal", newPId)` to split
   - Set the new panel as active with the diff tab selected
   - Record content type in `paneContentType`

Also add the action to the store's type interface.

### 2. Wire keybinding in App.tsx handler map

In `src/App.tsx`, in the `handlersRef.current` object (around line 283):

1. Import `usePreferencesStore` if not already imported
2. Add handler for `"open-diff"`:
```typescript
"open-diff": () => {
  const { diffOpensInNewPanel } = usePreferencesStore.getState().preferences;
  if (diffOpensInNewPanel) {
    openDiffInNewPanel();
  } else {
    openOrFocusDiff();
  }
},
```

Make sure to destructure `openDiffInNewPanel` from the app store alongside the existing `openOrFocusDiff`.

### 3. Add shortcut to command palette

In `src/components/command-palette/useCommands.tsx`, update the "open-diff" command (around line 106) to show the shortcut:

```typescript
{
  id: "open-diff",
  label: "Open Diff",
  shortcut: fmt("open-diff"),
  keywords: ["git", "changes", "diff", "staged"],
  action: () => {
    const { diffOpensInNewPanel } = usePreferencesStore.getState().preferences;
    if (diffOpensInNewPanel) {
      openDiffInNewPanel();
    } else {
      openOrFocusDiff();
    }
    onClose();
  },
},
```

Import `usePreferencesStore` and destructure `openDiffInNewPanel` from the app store at the top of the hook.

## Files to touch
- `src/store/app-store.ts` — add `openDiffInNewPanel` action + type
- `src/App.tsx` — add `"open-diff"` handler that checks preference
- `src/components/command-palette/useCommands.tsx` — add shortcut display and preference-aware action
