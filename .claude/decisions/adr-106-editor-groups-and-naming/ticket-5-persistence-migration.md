---
title: Update persistence with v2 layout format and migration
status: todo
priority: high
assignee: sonnet
blocked_by: [2]
---

# Update persistence with v2 layout format and migration

Update the layout persistence to support the new panel tree structure while migrating v1 layouts.

## New persisted types

In `src/electron.d.ts`:

```typescript
export interface PersistedTab {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
  paneSessions: Record<string, PersistedPaneSession>;
}

export interface PersistedPanel {
  id: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

export interface PersistedWorkspaceV2 {
  workspacePath: string;
  panelTree: PanelNode;
  panels: Record<string, PersistedPanel>;
  activePanelId: string;
}

export interface PersistedLayout {
  version: 2;
  workspaces: PersistedWorkspaceV2[];
}
```

## Migration (v1 → v2)

In the electron main process persistence loader:

```typescript
function migrateV1toV2(v1: PersistedLayoutV1): PersistedLayout {
  return {
    version: 2,
    workspaces: v1.workspaces.map(ws => {
      const panelId = `panel-${crypto.randomUUID()}`;
      return {
        workspacePath: ws.workspacePath,
        panelTree: { type: "leaf", panelId },
        panels: {
          [panelId]: {
            id: panelId,
            tabs: ws.sessions.map(s => ({
              ...s,
              // PersistedSession fields map directly to PersistedTab
            })),
            selectedTabId: ws.selectedSessionId,
            pinnedTabIds: ws.pinnedSessionIds ?? [],
          }
        },
        activePanelId: panelId,
      };
    }),
  };
}
```

When loading: if `version === 1` (or missing), run migration. Save back as v2.

## Serialization

Update the `serializeLayout` function in the electron main process to serialize the new panel tree structure when saving layout state.

## Files to touch

- `src/electron.d.ts` — new persisted types
- `electron/layout-persistence.ts` (or wherever persistence lives) — migration logic, updated serialize/deserialize
- `src/store/app-store.ts` — update `loadPersistedLayout` to handle new format

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-106): update persistence with v2 layout format and migration"

Do not push.
