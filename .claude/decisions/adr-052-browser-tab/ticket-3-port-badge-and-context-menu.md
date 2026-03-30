---
title: Update PortBadge with browser tab and context menu options
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Update PortBadge with browser tab and context menu options

Wire up the port badge to open ports in the in-app browser tab, and add a context menu for choosing between in-app and default browser.

## Changes

### 1. Update `PortBadge` (`src/components/PortBadge.tsx`)

Change the click handler from `shell.openExternal` to `addBrowserSession`:

```typescript
const addBrowserSession = useAppStore((s) => s.addBrowserSession);

const handleOpen = useCallback(() => {
  addBrowserSession(`http://localhost:${port.port}`);
}, [port.port, addBrowserSession]);
```

Add a Radix context menu (already used in `SessionButton.tsx`) with two options:
- "Open in Browser Tab" — calls `addBrowserSession`
- "Open in Default Browser" — calls `shell.openExternal`

Import `@radix-ui/react-context-menu` (already a dependency).

### 2. Update styles

Add context menu styles to `Sidebar.module.css` if not already present (can reuse the pattern from `TabBar.module.css`'s context menu styles).

## Files to touch
- `src/components/PortBadge.tsx` — new click behavior + context menu
- `src/components/Sidebar.module.css` — context menu styles (if needed)
