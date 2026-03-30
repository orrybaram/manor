---
title: Update formatElementContext to show file paths for all React components
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Update formatElementContext to show file paths for all React components

Change the React Context section in `formatElementContext` to list every component with its source file path, using a stack-trace-like format.

**Before:**
```
## React Context
Component: Button at /src/components/Button.tsx:42
Parent chain: App > Form > Button
```

**After:**
```
## React Context
  in Button (at /src/components/Button.tsx:42)
  in Form (at /src/features/auth/Form.tsx:18)
  in App (at /src/App.tsx:7)
```

Components without `_debugSource` should render as just `  in ComponentName` (no path).

## Files to touch
- `electron/mcp-webview-server.ts` — update the React Context block in `formatElementContext` (around lines 315-328)
