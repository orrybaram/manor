---
title: Enable sandbox in BrowserWindow webPreferences
status: done
priority: critical
assignee: haiku
blocked_by: []
---

# Enable sandbox in BrowserWindow webPreferences

Add `sandbox: true` to the BrowserWindow webPreferences in the main process.

## Implementation

In `electron/main.ts`, find the `webPreferences` object (around line 124) and add `sandbox: true`:

```typescript
webPreferences: {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
},
```

This is safe because the app already uses `contextBridge.exposeInMainWorld()` in the preload script and does not rely on any Node.js APIs in the renderer process.

## Files to touch
- `electron/main.ts` — add `sandbox: true` to webPreferences
