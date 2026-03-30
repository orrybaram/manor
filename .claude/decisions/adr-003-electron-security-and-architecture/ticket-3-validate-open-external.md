---
title: Validate openExternal URL protocol
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Validate openExternal URL protocol

The `shell:openExternal` IPC handler passes any URL from the renderer directly to `shell.openExternal()`. A compromised renderer could trigger arbitrary protocol handlers (e.g., `file://`, `smb://`, custom protocols). Add URL validation in the main process handler.

## Implementation

Find the `shell:openExternal` handler in `electron/main.ts` (around line 556). Replace the direct pass-through with validated logic:

```typescript
ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  if (typeof url !== "string") {
    throw new Error("Invalid URL: expected string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  return shell.openExternal(url);
});
```

This whitelists only `https:` and `http:` protocols. If we need `mailto:` or other protocols later, they can be added to the allowlist explicitly.

## Files to touch
- `electron/main.ts` — replace `shell:openExternal` handler with validated version
