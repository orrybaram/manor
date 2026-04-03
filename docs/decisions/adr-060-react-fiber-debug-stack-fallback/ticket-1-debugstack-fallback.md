---
title: Add _debugStack fallback to React fiber extraction
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add _debugStack fallback to React fiber extraction

Update `getReactFiberInfo()` in both `electron/picker-script.ts` and `electron/webview-server.ts` to fall back to parsing `_debugStack` when `_debugSource` is not available.

After checking `node._debugSource`, if it's missing, check `node._debugStack`:
- It's an Error object with a `.stack` string property
- Parse stack frames to extract fileName and lineNumber
- Stack frames look like: `at ComponentName (webpack:///./src/Component.tsx:42:5)` or `at ComponentName (http://localhost:3000/src/Component.tsx:42:5)` or `at ComponentName (/absolute/path/src/Component.tsx:42:5)`
- Extract the file path (strip webpack:/// or URL prefixes) and line number from the first meaningful frame

## Files to touch
- `electron/picker-script.ts` — update `getReactFiberInfo()` (lines 97-134)
- `electron/webview-server.ts` — update `getReactFiberInfo()` (lines 561-593)
