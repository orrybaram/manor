---
title: Add confirmation dialog when closing pane with running agent
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add confirmation dialog when closing pane with running agent

Implement a confirmation dialog that appears when a user attempts to close a pane that has an active agent session (`thinking`, `working`, or `requires_input`).

## Implementation

### 1. Add store field for pending close confirmation

In `src/store/app-store.ts`:

- Add `pendingCloseConfirmPaneId: string | null` to the store state (init as `null`)
- Add `setPendingCloseConfirmPaneId(paneId: string | null)` setter
- Add `requestClosePane()` method that:
  1. Gets the focused pane's agent status from `paneAgentStatus[focusedPaneId]`
  2. If status is `thinking`, `working`, or `requires_input` → set `pendingCloseConfirmPaneId` to the pane ID (show dialog)
  3. Otherwise → call `closePaneById()` directly (close immediately)
- Add `requestClosePaneById(paneId: string)` with same logic but for a specific pane ID

### 2. Create `CloseAgentPaneDialog.tsx`

In `src/components/CloseAgentPaneDialog.tsx`:

Follow `RemoveProjectDialog.tsx` pattern exactly:
- Props: `open: boolean`, `onOpenChange: (open: boolean) => void`, `onConfirm: () => void`
- Uses `@radix-ui/react-dialog` with the existing CSS classes from `Sidebar.module.css`
- Title: "Close Pane"
- Description: "An agent is currently running in this pane. Are you sure you want to close it?"
- Buttons: "Cancel" (`.confirmCancel`) and "Close" (`.confirmRemove`)

### 3. Update `LeafPane.tsx`

- Change `handleClose` to call `requestClosePaneById(paneId)` instead of `focusPane() + closePane()`
- Still call `focusPane(paneId)` before requesting close

### 4. Update `App.tsx`

- Change the `"close-pane"` keybinding handler to call `requestClosePane()` instead of `closePane()`
- Render `<CloseAgentPaneDialog>` at the top level, reading `pendingCloseConfirmPaneId` from store
- On confirm: call `closePaneById(pendingCloseConfirmPaneId)` then clear the pending ID
- On cancel/dismiss: clear the pending ID

## Files to touch
- `src/store/app-store.ts` — Add `pendingCloseConfirmPaneId` state and `requestClosePane`/`requestClosePaneById` methods
- `src/components/CloseAgentPaneDialog.tsx` — New dialog component (small, follows existing pattern)
- `src/components/LeafPane.tsx` — Use `requestClosePaneById` in `handleClose`
- `src/App.tsx` — Use `requestClosePane` in keybinding, render dialog
