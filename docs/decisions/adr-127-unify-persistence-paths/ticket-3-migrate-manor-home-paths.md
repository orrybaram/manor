---
title: Migrate hardcoded ~/.manor paths to paths.ts getters
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2]
---

# Migrate hardcoded `~/.manor` paths

Every `path.join(..., ".manor", ...)` (or `$HOME/.manor/...` in shell-script string templates) that can be replaced at edit time should come from `paths.ts`. Leaves shell-template strings alone — those are emitted as-is into hook scripts that run outside Node and cannot `require()` paths.ts.

Ticket 2 touches `persistence.ts` for the `manorDataDir()` duplicate; this ticket also touches `persistence.ts` for the `~/.manor/worktrees/` call sites. Blocked by ticket 2 to avoid merge conflict.

## Node-side replacements (swap to `paths.ts` getters)

### `electron/persistence.ts`
- Line 695: `path.join(os.homedir(), ".manor", "worktrees", slugify(project.name))` → `path.join(worktreesDir(), slugify(project.name))`
- Line 838: same swap

### `electron/agent-hooks.ts`
- Line 143-148: `HOOK_SCRIPT_PATH` → call `hookScriptPath()`
- Line 150-154: `HOOK_PORT_FILE` → call `hookPortFile()`
- Note: lines 168 (`$HOME/.manor/hook-port` inside the embedded shell script) and 144-146 / 152 (`process.env.HOME || "/tmp"`) are fallbacks inside `HOOK_SCRIPT` — a string template. **Do not change the shell template.** The JS-side constants wrap the same path; swap those to getter calls.

### `electron/webview-server.ts`
- Line 47-51: `PORT_FILE = path.join(process.env.HOME || "/tmp", ".manor", "webview-server-port")` → replace with `webviewServerPortFile()` call

### `electron/portless.ts`
- Line 13-17: `PORT_FILE = ...` → `portlessProxyPortFile()`

### `electron/mcp-webview-server.ts`
- Line 20-24: `PORT_FILE = ...` → `webviewServerPortFile()` from `paths.ts`
- Verify the build includes `paths.ts` in the MCP server bundle. The MCP server is a standalone node entry; check the build config (`vite.config.*` or `electron-builder`) so the import resolves at runtime. If the MCP server is bundled separately and can't see `paths.ts`, inline a minimal copy here with a comment pointing at `paths.ts` as the source of truth. Prefer the shared import if the build allows it.

### `electron/terminal-host/index.ts`
- Lines 19-23: `MANOR_DIR`, `DAEMON_DIR`, `SOCKET_PATH`, `TOKEN_PATH`, `PID_PATH` → call `daemonDir()`, `daemonSocketFile()`, `daemonTokenFile()`, `daemonPidFile()` from `paths.ts`. Same build-reachability concern as MCP server — daemon runs as a detached node process. Check whether `electron/paths.ts` is bundled into the daemon output.

### `electron/terminal-host/client.ts`
- Line 24: `MANOR_DIR = path.join(os.homedir(), ".manor")` → `manorHomeDir()`
- Line 390: `legacyDaemonsDir = path.join(MANOR_DIR, "daemons")` — unchanged path semantics, just uses the new constant

### `electron/terminal-host/layout-persistence.ts`
- Line 42: `LAYOUT_FILE` → `layoutFile()`

### `electron/terminal-host/scrollback.ts`
- Line 13: `SESSIONS_DIR` → `scrollbackSessionsDir()`

### `electron/ipc/processes.ts`
- Line 10: `DAEMON_DIR = path.join(os.homedir(), ".manor", "daemon")` → `daemonDir()`
- Line 13: `getPidPath()` → `daemonPidFile()`

## Shell-string templates (leave unchanged)

These emit strings that are written to files and executed outside Node. They cannot import `paths.ts`. Leave them as hardcoded `$HOME/.manor/...`:

- `electron/agent-hooks.ts` — `HOOK_SCRIPT` body
- `electron/webview-cli-script.ts` — check file, treat similarly

Add a comment above each hardcoded occurrence pointing at the corresponding getter, so future drift is visible:

```ts
// Keep in sync with paths.hookPortFile() — this string is emitted into a shell script.
PORT=$(cat "$HOME/.manor/hook-port" 2>/dev/null)
```

## Daemon / MCP server build reachability

Before completing this ticket, verify that `paths.ts` is reachable from:
1. The Electron main bundle (trivially yes)
2. The daemon bundle (`electron/terminal-host/index.ts` — spawned via `ELECTRON_RUN_AS_NODE=1`)
3. The MCP server bundle (`electron/mcp-webview-server.ts` — spawned by Claude Code)

Check the build config. If any of these three can't import `paths.ts` from the emitted output, either (a) adjust the build config, or (b) for that specific entry, inline the needed getters with a `// source of truth: electron/paths.ts` comment and keep the rest on the shared import.

## Sanity check

After edits, run:
```
rg '"\.manor"' electron/ | grep -v paths.ts | grep -v "Keep in sync"
```

Every remaining hit should be either inside a shell-string template or explicitly annotated as intentional.

Run tests:
```
pnpm vitest run persistence agent-hooks webview-server portless terminal-host
pnpm tsc --noEmit
```

## Files to touch
- `electron/persistence.ts` (worktrees paths)
- `electron/agent-hooks.ts` (HOOK_SCRIPT_PATH, HOOK_PORT_FILE)
- `electron/webview-server.ts` (PORT_FILE)
- `electron/portless.ts` (PORT_FILE)
- `electron/mcp-webview-server.ts` (PORT_FILE; verify build reachability)
- `electron/terminal-host/index.ts` (daemon constants; verify build reachability)
- `electron/terminal-host/client.ts` (MANOR_DIR)
- `electron/terminal-host/layout-persistence.ts` (LAYOUT_FILE)
- `electron/terminal-host/scrollback.ts` (SESSIONS_DIR)
- `electron/ipc/processes.ts` (DAEMON_DIR, getPidPath)

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-127): Migrate hardcoded ~/.manor paths to paths.ts getters"

Do not push.
