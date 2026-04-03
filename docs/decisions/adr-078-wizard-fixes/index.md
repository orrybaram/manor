---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-078: Fix Project Setup Wizard UX Issues

## Context

The project setup wizard has several UX issues:

1. **Wizard re-appears when tabs close**: The wizard visibility is controlled by React state (`wizardOpen`), but there's no persistent flag to track whether a project has completed setup. The wizard occupies the same rendering slot as `WorkspaceEmptyState`, and since it takes priority in the ternary (`wizardOpen && wizardProjectId ? wizard : emptyState`), if `wizardOpen` is true when all sessions close, the wizard shows instead of the empty state. The fix is to add a `setupComplete` flag to `ProjectInfo` so the wizard only shows once per project, and to ensure `closeWizard` is called on relevant navigation events.

2. **Wizard looks like a modal**: The `.card` class has `border: 1px solid var(--surface)` and the header/footer have border separators. The wizard should look like an inline content area, not a bordered card.

3. **New workspace doesn't auto-switch and show wizard**: When creating a new workspace via `createWorktree`, the store already calls `selectWorkspace` and `setActiveWorkspace`, so auto-switching should work. However, the wizard doesn't open for new workspaces — the wizard is project-level configuration and shouldn't show for workspace creation. The user likely means the workspace should be switched to and be visible (showing the empty state). Need to verify `setActiveWorkspace` is being called correctly.

4. **Wizard changes not reflected in sidebar**: The wizard calls `updateProject()` which updates the project store, but the sidebar may not be re-rendering because the project store subscriptions aren't picking up the changes immediately. The `updateProject` action calls the IPC and then refreshes projects from the backend — changes should propagate. Need to verify `updateProject` triggers a store update that the Sidebar subscribes to.

## Decision

### Fix 1: One-time wizard with `setupComplete` flag
- Add `setupComplete: boolean` to `ProjectInfo` interface
- Set `setupComplete = true` when wizard closes (in `handleDone` and `handleSkip` on last step)
- Guard wizard display: only show if `!project.setupComplete`
- When `handleAddProject` creates a project, the project starts with `setupComplete: false`

### Fix 2: Remove card borders
- Remove `border` from `.card`
- Remove `border-bottom` from `.header`
- Remove `border-top` from `.footer`

### Fix 3: Auto-switch to new workspace
- Verify `createWorktree` properly switches workspace. The code already calls `selectWorkspace` and `setActiveWorkspace` — trace through to confirm the workspace path is correct and the app re-renders.

### Fix 4: Instant sidebar reflection
- Ensure `updateProject` in project-store triggers a state update that the Sidebar picks up. The current flow calls IPC then refreshes — check if there's a race or stale closure.

## Consequences

- Projects created before this change won't have `setupComplete` — they need a default of `true` so the wizard doesn't re-show for them.
- The wizard becomes a true one-time experience per project.
- Removing borders makes the wizard feel more integrated with the app.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
