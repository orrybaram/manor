---
title: Add PanelLayout and SplitPanelLayout components
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Add PanelLayout and SplitPanelLayout components

Create the UI components that render the panel tree, replacing the current flat session rendering in App.tsx.

## Components

### `src/components/panels/PanelLayout.tsx`

Recursive component (mirrors `PaneLayout`):

```tsx
function PanelLayout({ node, workspacePath }: { node: PanelNode; workspacePath: string }) {
  if (node.type === "leaf") {
    return <LeafPanel panelId={node.panelId} workspacePath={workspacePath} />;
  }
  return (
    <SplitPanelLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspacePath={workspacePath}
    />
  );
}
```

### `src/components/panels/SplitPanelLayout.tsx`

Resizable split container (mirrors `SplitLayout`):
- Same drag-to-resize logic as `SplitLayout`
- Calls `updatePanelSplitRatio` on resize

### `src/components/panels/LeafPanel.tsx`

A single panel with its own tab bar and content area:

```tsx
function LeafPanel({ panelId, workspacePath }: Props) {
  const panel = useAppStore(s => s.workspaceLayouts[workspacePath]?.panels[panelId]);
  const isActivePanel = useAppStore(s => s.workspaceLayouts[workspacePath]?.activePanelId === panelId);

  return (
    <div className={styles.panel} onClick={() => focusPanel(panelId)}>
      <TabBar panelId={panelId} />
      <div className="terminal-container">
        {panel.tabs.map(tab => (
          <div key={tab.id} style={tab.id === panel.selectedTabId ? VISIBLE : HIDDEN}>
            <PaneLayout node={tab.rootNode} workspacePath={workspacePath} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

### TabBar updates

The existing `TabBar` component needs to accept a `panelId` prop so it can:
- Read tabs from the specific panel (not just the active workspace)
- Scope add/close/reorder/pin actions to that panel
- When there's only one panel, it should look identical to today

## App.tsx changes

Replace the current flat session rendering:

```tsx
// Before: flat session list
{wsState.sessions.map(session => (
  <div key={session.id} style={isVisible ? VISIBLE : HIDDEN}>
    <PaneLayout node={session.rootNode} />
  </div>
))}

// After: panel tree
<PanelLayout
  node={workspaceLayout.panelTree}
  workspacePath={activeWorkspacePath}
/>
```

The `TabBar` currently lives outside the terminal-container in App.tsx. With panels, each `LeafPanel` owns its own `TabBar`, so the top-level `TabBar` rendering in App.tsx should be removed.

## Focus indication

The active panel should have a subtle visual indicator (e.g., a highlighted tab bar border or slightly different background) so users know which panel has focus. Use a CSS class like `.panelActive` toggled by `isActivePanel`.

## Files to touch

- `src/components/panels/PanelLayout.tsx` — NEW
- `src/components/panels/SplitPanelLayout.tsx` — NEW
- `src/components/panels/LeafPanel.tsx` — NEW
- `src/components/panels/PanelLayout.module.css` — NEW
- `src/components/tabbar/TabBar/TabBar.tsx` — add `panelId` prop, scope to panel
- `src/App.tsx` — replace flat session rendering with `PanelLayout`

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-106): add PanelLayout and SplitPanelLayout components"

Do not push.
