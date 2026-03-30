---
title: Add env var port discovery for webview and portless servers
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add env var port discovery for webview and portless servers

Add `MANOR_WEBVIEW_PORT` and `MANOR_PORTLESS_PORT` environment variables so PTY-spawned tools always connect to the correct Manor instance, even when multiple instances are running.

## Implementation

### `electron/main.ts` — set env vars after server start

After the servers start (around line 1207-1210), add:
```typescript
process.env.MANOR_WEBVIEW_PORT = String(webviewServer.port);
process.env.MANOR_PORTLESS_PORT = String(portlessManager.proxyPort);
```

The webview server needs a public `port` getter. Check if it exists; if not, add one.

### `electron/webview-server.ts` — expose port

Add a public getter if not already exposed:
```typescript
get serverPort(): number {
  return this.port;
}
```

### `electron/mcp-webview-server.ts` — prefer env var

Update port discovery to check env var first:
```typescript
function readPort(): number {
  const envPort = process.env.MANOR_WEBVIEW_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  // Fall back to file
  ...existing file-based logic...
}
```

### `electron/webview-cli-script.ts` — prefer env var in shell script

Update the `get_port()` function in the generated CLI script:
```bash
get_port() {
  if [ -n "$MANOR_WEBVIEW_PORT" ]; then
    echo "$MANOR_WEBVIEW_PORT"
    return
  fi
  if [ ! -f "$PORT_FILE" ]; then
    die "Manor is not running or has no webview server active"
  fi
  cat "$PORT_FILE"
}
```

### `electron/agent-hooks.ts` — reverse hook script port priority

Update the PORT line in the hook script from:
```bash
PORT=$(cat "$HOME/.manor/hook-port" 2>/dev/null || echo "$MANOR_HOOK_PORT")
```
To:
```bash
PORT=${MANOR_HOOK_PORT:-$(cat "$HOME/.manor/hook-port" 2>/dev/null)}
```

This makes the env var primary and file the fallback.

## Files to touch
- `electron/main.ts` — set `MANOR_WEBVIEW_PORT` and `MANOR_PORTLESS_PORT` env vars
- `electron/webview-server.ts` — add public port getter if needed
- `electron/mcp-webview-server.ts` — check env var before file for port discovery
- `electron/webview-cli-script.ts` — update `get_port()` to prefer env var
- `electron/agent-hooks.ts` — reverse hook script port resolution priority
