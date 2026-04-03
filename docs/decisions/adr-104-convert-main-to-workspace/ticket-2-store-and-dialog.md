---
title: Add store action, dialog, and context menu item
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add store action, dialog, and context menu item

Wire up the frontend: store action, a simple dialog for naming the workspace, and the context menu item on the main workspace.

## Implementation

### `src/store/project-store.ts` — Add store action

Add `convertMainToWorktree` to the store interface and implementation:

```typescript
// Interface addition:
convertMainToWorktree: (projectId: string, name: string) => Promise<string | null>;

// Implementation (similar pattern to createWorktree):
convertMainToWorktree: async (projectId: string, name: string) => {
  let updated;
  try {
    updated = await window.electronAPI.projects.convertMainToWorktree(projectId, name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, "");
    useToastStore.getState().addToast({
      id: `convert-error-${Date.now()}`,
      message: "Failed to convert to workspace",
      status: "error",
      detail,
    });
    return null;
  }
  if (!updated) return null;
  set((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
  }));
  // Find and select the new worktree workspace
  const newWs = updated.workspaces.find((ws) => !ws.isMain && ws.name === name);
  const wsPath = newWs?.path ?? null;
  if (wsPath) {
    const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
    if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);
  }
  return wsPath;
},
```

### `src/components/sidebar/ConvertToWorkspaceDialog.tsx` — New dialog

Create a simple dialog component. Keep it minimal — similar structure to existing dialogs like `MergeWorktreeDialog`:

Props:
```typescript
{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: string;  // The branch being converted (displayed read-only)
  onConfirm: (name: string) => void;
}
```

UI:
- Title: "Convert to Workspace"
- Show the branch name as read-only info text (e.g. "Move branch `feature-x` to a new workspace")
- Name input field (pre-filled with the branch name)
- Cancel and "Convert" buttons

Use the same dialog styles as existing dialogs (`@radix-ui/react-dialog`). Use the existing `Input` and `Button` components. Use the existing dialog CSS patterns from `MergeWorktreeDialog.module.css` or `DeleteWorktreeDialog.module.css` as a reference — create a new `ConvertToWorkspaceDialog.module.css` if needed, or reuse shared styles from `Sidebar.module.css`.

### `src/components/sidebar/ProjectItem.tsx` — Add context menu item and dialog

1. Add state: `const [convertWorkspaceOpen, setConvertWorkspaceOpen] = useState(false);`

2. In the workspace context menu, add a new item **only for main workspaces on non-default branches**. Add it after "Copy Path" and before the existing non-main separator. The condition is `ws.isMain && ws.branch && ws.branch !== project.defaultBranch`:

```tsx
{ws.isMain && ws.branch && ws.branch !== project.defaultBranch && (
  <>
    <ContextMenu.Separator className={styles.contextMenuSeparator} />
    <ContextMenu.Item
      className={styles.contextMenuItem}
      onSelect={() => setConvertWorkspaceOpen(true)}
    >
      Convert to Workspace…
    </ContextMenu.Item>
  </>
)}
```

3. Add the dialog at the bottom of the component (alongside other dialogs):

```tsx
<ConvertToWorkspaceDialog
  open={convertWorkspaceOpen}
  onOpenChange={setConvertWorkspaceOpen}
  branch={mainWorkspace?.branch || ""}
  onConfirm={async (name) => {
    const result = await useProjectStore.getState().convertMainToWorktree(project.id, name);
    if (result) setConvertWorkspaceOpen(false);
  }}
/>
```

Where `mainWorkspace` is derived: `const mainWorkspace = project.workspaces.find(ws => ws.isMain);`

4. Add the import for `ConvertToWorkspaceDialog` at the top.

## Files to touch
- `src/store/project-store.ts` — Add `convertMainToWorktree` action
- `src/components/sidebar/ConvertToWorkspaceDialog.tsx` — New dialog component (create)
- `src/components/sidebar/ProjectItem.tsx` — Add context menu item and dialog integration
