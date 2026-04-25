---
title: Atomic navigateToTask via single Zustand action
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Atomic navigateToTask via single Zustand action

`src/utils/task-navigation.ts` calls four discrete `useAppStore` actions in sequence: `selectProject`, `selectWorkspace`, `selectTab`, `focusPane`. Each call triggers a render; subscribers see intermediate states (e.g. project selected but no workspace yet). Comments imply atomicity that doesn't exist.

See ADR-136 §"Change 4" for context.

## What to change

Add a composed action `navigateToContext` to `src/store/app-store.ts`:

```ts
navigateToContext: (ctx: {
  projectId: string;
  workspacePath: string;
  tabId: string;
  paneId: string;
}) =>
  set((state) => {
    // Compose all four state changes inline. Reuse the field-level update
    // logic from the existing four actions but apply directly to the draft
    // state, NOT by calling the actions (which would call set internally
    // and defeat atomicity).

    // 1. Select project
    const nextProject = ctx.projectId;

    // 2. Select workspace by path inside that project
    const project = state.projects[ctx.projectId];
    const workspaceIndex = project?.workspaces.findIndex(
      (w) => w.path === ctx.workspacePath,
    ) ?? 0;

    // 3. Select tab and 4. focus pane within the active layout
    const layout = state.workspaceLayouts[ctx.workspacePath];
    if (!layout) return state; // workspace not yet rehydrated; bail

    const panel = Object.values(layout.panels).find((p) =>
      p.tabs.some((t) => t.id === ctx.tabId),
    );
    if (!panel) return state;

    const updatedPanel = {
      ...panel,
      selectedTabId: ctx.tabId,
      focusedPaneId: ctx.paneId,
    };

    return {
      ...state,
      activeProjectId: nextProject,
      activeWorkspacePath: ctx.workspacePath,
      activeWorkspaceIndex: workspaceIndex,
      workspaceLayouts: {
        ...state.workspaceLayouts,
        [ctx.workspacePath]: {
          ...layout,
          activePanelId: panel.id,
          panels: { ...layout.panels, [panel.id]: updatedPanel },
        },
      },
    };
  }),
```

Then `src/utils/task-navigation.ts` replaces its four-call sequence with a single `useAppStore.getState().navigateToContext({ ... })`.

The four existing actions (`selectProject`, `selectWorkspace`, `selectTab`, `focusPane`) remain — keyboard shortcuts and the command palette still call them individually. Only the task-navigation flow uses the composed action.

The exact field shape (workspaceIndex vs workspacePath, panel structure) needs to match `app-store.ts` reality; treat the snippet above as a guide and reconstruct from the actual state shape.

## Files to touch

- `src/store/app-store.ts` — add `navigateToContext` action.
- `src/utils/task-navigation.ts` — replace the four-call sequence with `navigateToContext`.

## Tests

`src/store/__tests__/app-store-navigate-to-context.test.ts` (new):

1. Seed store with a project, a workspace, a layout containing a panel with a tab and a pane. Call `navigateToContext`. Assert all four selections happened.
2. Subscribe a spy to the store; call `navigateToContext`. Spy should fire exactly once (one re-render), not four times.
3. Call with a tabId that does not exist in any panel — store state must not change.
4. Call with a workspacePath that has no layout — store state must not change.
