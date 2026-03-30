---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-060: React fiber _debugStack fallback and clipboard formatting

## Context

React 19 removed `_debugSource` from fibers. Instead, it captures `_debugStack` — an Error object whose `.stack` string contains source locations. Our picker script only checks `_debugSource`, so React 19 apps get component names but no file paths.

Additionally, when a user clicks "Pick Element" in the browser toolbar, the result is copied to clipboard as raw JSON. The React component info should be formatted with file paths for easy copy-paste to an agent.

## Decision

1. **Fallback to `_debugStack`** in `getReactFiberInfo()` (both `picker-script.ts` and `webview-server.ts`): When `_debugSource` is missing, parse `node._debugStack.stack` to extract file path and line number. The stack typically contains lines like `at ComponentName (webpack:///./src/Component.tsx:42:5)` or `at ComponentName (http://localhost:3000/src/Component.tsx:42:5)`.

2. **Format clipboard copy** in `BrowserPane.tsx`: Instead of raw JSON, format the React Context section as readable text with file paths (matching the MCP output format).

## Consequences

- Element picker will show file paths for React 19+ apps in dev mode
- Clipboard output becomes more useful for pasting to agents
- Stack parsing is best-effort — prod builds won't have meaningful paths
