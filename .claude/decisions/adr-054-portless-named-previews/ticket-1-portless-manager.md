---
title: Create PortlessManager class
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Create PortlessManager class

Implement `electron/portless.ts` with a `PortlessManager` class that wraps the portless library's proxy server.

## Implementation

1. Add `portless` as a dependency (`bun add portless`)
2. Create `electron/portless.ts` with:

```typescript
import { createProxyServer, type RouteInfo } from "portless";
```

### PortlessManager class

- **`routes: RouteInfo[]`** — current route table, initially empty.
- **`server`** — the proxy server instance returned by `createProxyServer`.
- **`start(proxyPort?: number)`** — calls `createProxyServer({ proxyPort: proxyPort ?? 1355, getRoutes: () => this.routes })`. If port 1355 is in use, try a random free port. Write the chosen port to `~/.manor/portless-proxy-port`.
- **`stop()`** — close the proxy server.
- **`updateRoutes(routes: RouteInfo[])`** — replaces `this.routes`. No proxy reload needed since portless calls `getRoutes()` on every request.
- **`hostnameForPort(workspacePath, projectName, branch, isMain)`** — compute the `.localhost` hostname:
  - Base: `projectName` or `basename(workspacePath)`, sanitized (lowercase, replace non-alphanumeric with hyphens, max 63 chars).
  - If `branch` is set and `!isMain`, prefix: `${sanitize(branch)}.${base}.localhost`.
  - Otherwise: `${base}.localhost`.

Export a singleton instance.

## Files to touch
- `electron/portless.ts` — new file, the entire PortlessManager class
- `package.json` — add `portless` dependency
