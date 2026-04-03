---
title: Add CategoryConfig type and refactor root view to config array
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add CategoryConfig type and refactor root view to config array

This is a single-ticket refactor — all changes are tightly coupled.

## Changes

### 1. Update `types.ts` — add `suffix` to `CommandItem` and new `CategoryConfig` type

Add to `CommandItem`:
```ts
suffix?: ReactNode;
```

Add new type:
```ts
export interface CategoryConfig {
  id: string;
  heading: string;
  visible: boolean;
  items: CommandItem[];
}
```

Note: `CommandItem` is defined in both `types.ts` and `useWorkspaceCommands.tsx`. The canonical one should be in `types.ts`. The duplicate in `useWorkspaceCommands.tsx` should be removed (it's already re-exported from there by `useCustomCommands.tsx` and `useCommands.tsx`).

### 2. Update `CommandPalette.tsx` — build config array, replace inline JSX

Build a `categories: CategoryConfig[]` array in a `useMemo` that references:
- `taskCommands` → `{ id: "tasks", heading: "Tasks", visible: true, items: taskCommands }`
- `customCommands` → `{ id: "run", heading: "Run", visible: customCommands.length > 0, items: customCommands }`
- Workspace groups → expand `workspaceGroups` map into one entry per group
- `commands` → `{ id: "commands", heading: "Commands", visible: true, items: commands }`
- Linear items → build `CommandItem[]` with suffix chevron, `visible: showLinear`
- GitHub items → build `CommandItem[]` with suffix chevron, `visible: showGitHub`

Replace the root view `<>...</>` block with:
```tsx
{categories.filter(c => c.visible).map((cat, i) => (
  <Fragment key={cat.id}>
    {i > 0 && <Command.Separator className={styles.separator} />}
    <Command.Group heading={cat.heading} className={styles.group}>
      {cat.items.map((cmd) => (
        <Command.Item
          key={cmd.id}
          value={`${cat.heading} ${cmd.label}`}
          onSelect={cmd.action}
          className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
        >
          {cmd.icon && <span className={styles.icon}>{cmd.icon}</span>}
          <span className={styles.label}>{cmd.label}</span>
          {cmd.shortcut && <span className={styles.shortcut}>{cmd.shortcut}</span>}
          {cmd.isActive && <span className={styles.activeBadge}>current</span>}
          {cmd.suffix && <span className={styles.chevron}>{cmd.suffix}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  </Fragment>
))}
```

### 3. Fix imports in `useCommands.tsx` and `useCustomCommands.tsx`

Both currently import `CommandItem` from `./useWorkspaceCommands`. Update to import from `./types` instead.

### 4. Remove duplicate `CommandItem` from `useWorkspaceCommands.tsx`

Delete the `CommandItem` interface and export from `useWorkspaceCommands.tsx`. It should import from `./types`.

## Files to touch
- `src/components/CommandPalette/types.ts` — add `suffix` field and `CategoryConfig` type
- `src/components/CommandPalette/CommandPalette.tsx` — build config array, replace inline JSX
- `src/components/CommandPalette/useCommands.tsx` — fix import path
- `src/components/CommandPalette/useCustomCommands.tsx` — fix import path
- `src/components/CommandPalette/useWorkspaceCommands.tsx` — remove duplicate type, import from types
