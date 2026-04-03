---
title: Namespace terminal host daemon by version
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Namespace terminal host daemon by version

Move daemon runtime files from `~/.manor/` to `~/.manor/daemons/{version}/` so different Manor versions get isolated daemons.

## Implementation

### `electron/terminal-host/index.ts` (daemon)

Replace the hardcoded paths:
```typescript
const MANOR_DIR = path.join(os.homedir(), ".manor");
const SOCKET_PATH = path.join(MANOR_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(MANOR_DIR, "terminal-host.token");
const PID_PATH = path.join(MANOR_DIR, "terminal-host.pid");
```

With version-namespaced paths:
```typescript
const MANOR_DIR = path.join(os.homedir(), ".manor");
const version = process.env.MANOR_VERSION || "unknown";
const DAEMON_DIR = path.join(MANOR_DIR, "daemons", version);
const SOCKET_PATH = path.join(DAEMON_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(DAEMON_DIR, "terminal-host.token");
const PID_PATH = path.join(DAEMON_DIR, "terminal-host.pid");
```

Update the `setup()` function to create `DAEMON_DIR` instead of `MANOR_DIR`.

### `electron/terminal-host/client.ts` (client)

Same path change. The client already receives `version` in its constructor and sets `MANOR_VERSION` env var when spawning the daemon. Use the same version for path computation:

Replace:
```typescript
const MANOR_DIR = path.join(os.homedir(), ".manor");
const SOCKET_PATH = path.join(MANOR_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(MANOR_DIR, "terminal-host.token");
const PID_PATH = path.join(MANOR_DIR, "terminal-host.pid");
```

With:
```typescript
const MANOR_DIR = path.join(os.homedir(), ".manor");
```

And make `SOCKET_PATH`, `TOKEN_PATH`, `PID_PATH` instance properties of `TerminalHostClient` computed from the version passed to the constructor. Add a `daemonDir` getter. For the `"unknown"` fallback, use `this.clientVersion || "unknown"`.

**Remove the version mismatch kill-and-restart logic** (lines ~87-111 in `doConnect()`). Since each version now has its own daemon, version mismatches can't happen. Simplify `doConnect()` to just: check if running → spawn if not → connect → authenticate → connect stream.

## Files to touch
- `electron/terminal-host/index.ts` — version-namespace daemon paths
- `electron/terminal-host/client.ts` — version-namespace client paths, remove version mismatch restart logic
