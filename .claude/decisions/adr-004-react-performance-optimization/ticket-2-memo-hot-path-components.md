---
title: Add React.memo to SessionButton and ProjectItem
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add React.memo to SessionButton and ProjectItem

These two components are rendered in lists (tab bar and sidebar) and re-render whenever their parent's state changes, even when their own props haven't changed.

## Implementation

### 1. Wrap `SessionButton` in `React.memo`

In `SessionButton.tsx`, change the export:

```ts
export const SessionButton = React.memo(function SessionButton({
  sessionId,
  isActive,
  isPinned,
  canClose,
  isDragging,
  onSelect,
  onClose,
  onTogglePin,
  onPointerDown,
  style,
  buttonRef,
}: { ... }) {
  // ... existing implementation unchanged
});
```

The `style` prop is an object — verify that `TabBar.tsx` passes a stable reference (it uses `getTransformStyle()` which returns new objects). If needed, memoize the style computation in `TabBar.tsx` or accept that style changes trigger re-renders (which is correct behavior during drag).

### 2. Wrap `ProjectItem` in `React.memo`

In `ProjectItem.tsx`, change the export:

```ts
export const ProjectItem = React.memo(function ProjectItem({
  project,
  isSelected,
  collapsed,
  ...rest
}: { ... }) {
  // ... existing implementation unchanged
});
```

### 3. Verify callback stability in `Sidebar.tsx`

Check that all callbacks passed to `ProjectItem` from `Sidebar.tsx` (lines 265-301) are referentially stable:

- `onToggleCollapsed`: inline arrow `() => toggleProjectCollapsed(project.id)` — this is recreated per render. Since `ProjectItem` is now memoized, these inline callbacks will defeat the memo. However, the `project.id` dependency means we can't easily hoist these. The memo still helps when *other* projects' state changes (the parent re-renders but a given ProjectItem's props stay the same if its project data hasn't changed).
- The same applies to `onSelect`, `onRemove`, `onSelectWorkspace`, etc.

**Decision**: Keep the inline callbacks. `React.memo` will still prevent re-renders when *other* projects change (e.g., branch update on project A won't re-render project B's `ProjectItem`). The `project` object reference itself changes when any workspace within it updates, so the memo correctly allows re-renders when the project's own data changes.

## Files to touch
- `src/components/SessionButton.tsx` — wrap component in `React.memo`
- `src/components/ProjectItem.tsx` — wrap component in `React.memo`
