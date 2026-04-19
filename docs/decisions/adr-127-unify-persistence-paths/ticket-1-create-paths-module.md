---
title: Create electron/paths.ts with all named path getters
status: done
priority: high
assignee: opus
blocked_by: []
---

# Create `electron/paths.ts`

Create a new module that owns every filesystem path Manor writes to. Later tickets replace duplicated helpers and hardcoded strings with imports from this module.

## Design constraints

- **Must be Electron-free.** The daemon (`electron/terminal-host/index.ts`) and MCP webview server (`electron/mcp-webview-server.ts`) are spawned as standalone Node processes and import this module. Do not import from `electron` (`app`, `safeStorage`, etc.). Use `os.homedir()` and `process.platform` for resolution.
- **Named getters, not string constants.** Each path must be a function so test overrides (setting `HOME` in a tmpdir) work without module-load-time caching.
- **Two roots, clear comment.** Module-level doc comment must state the rule: anything in `manorHomeDir()` has an external reader (daemon / shell hook / MCP / git); everything else goes in `manorDataDir()`.

## API to implement

```ts
// Root resolvers
export function manorDataDir(): string;   // ~/Library/Application Support/Manor (mac), ~/.local/share/Manor (linux)
export function manorHomeDir(): string;   // ~/.manor (both platforms — external-boundary root)

// Data-dir getters
export function projectsFile(): string;           // <data>/projects.json
export function tasksFile(): string;              // <data>/tasks.json
export function preferencesFile(): string;        // <data>/preferences.json
export function keybindingsFile(): string;        // <data>/keybindings.json
export function windowBoundsFile(): string;       // <data>/window-bounds.json
export function zoomLevelFile(): string;          // <data>/zoom-level.json
export function linearTokenFile(): string;        // <data>/linear-token.enc
export function shellSessionsDir(): string;       // <data>/sessions  (zsh history files)
export function shellZdotdir(): string;           // <data>/zdotdir

// Home-dir (~/.manor) getters — each has an external reader, do not move
export function daemonDir(): string;              // <home>/daemon
export function daemonSocketFile(): string;       // <home>/daemon/terminal-host.sock
export function daemonPidFile(): string;          // <home>/daemon/terminal-host.pid
export function daemonTokenFile(): string;        // <home>/daemon/terminal-host.token
export function hookPortFile(): string;           // <home>/hook-port
export function hooksDir(): string;               // <home>/hooks
export function hookScriptPath(): string;         // <home>/hooks/notify.sh
export function webviewServerPortFile(): string;  // <home>/webview-server-port
export function portlessProxyPortFile(): string;  // <home>/portless-proxy-port
export function scrollbackSessionsDir(): string;  // <home>/sessions  (terminal scrollback — NOT zsh history)
export function layoutFile(): string;             // <home>/layout.json
export function worktreesDir(): string;           // <home>/worktrees
```

## Implementation notes

- `manorDataDir()`: replicate the existing logic exactly —
  ```ts
  process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Manor")
    : path.join(os.homedir(), ".local", "share", "Manor");
  ```
- `manorHomeDir()`: `path.join(os.homedir(), ".manor")`. (Some existing call sites use `process.env.HOME || "/tmp"` — switch to `os.homedir()` for consistency. `os.homedir()` already handles the fallback via `USERPROFILE` on Windows and `HOME` on Unix.)
- No `mkdirSync` calls in this module. Call sites create directories when they write.
- Add unit tests at `electron/__tests__/paths.test.ts`:
  - Mock `os.homedir()` returns a tmpdir; assert each getter returns the expected absolute path on darwin and linux
  - Confirm no getter imports from electron (compile-time via tsc + a runtime assertion that `require.cache` has no electron key after loading the module is not portable — skip runtime check, just rely on the doc + build)

## Module-level doc comment (include verbatim at the top)

```ts
/**
 * Central filesystem-path registry for Manor.
 *
 * Two roots:
 *   - manorDataDir()  — app-internal state (~/Library/Application Support/Manor on macOS).
 *                       Only Electron main reads/writes these files.
 *   - manorHomeDir()  — ~/.manor.  A stable, well-known path for anything an
 *                       external process needs to find: the detached daemon,
 *                       shell-level agent hooks, the standalone MCP webview
 *                       server, and `git worktree` (user-facing).
 *
 * Rule: if a new file has an external reader (another process, a shell script,
 * git, the user's file manager), put it under manorHomeDir().  Otherwise put
 * it under manorDataDir().
 *
 * This module must stay Electron-free — the daemon and MCP server import it
 * from standalone Node processes.  Do not import `electron` here.
 */
```

## Files to touch
- `electron/paths.ts` — new module, the full API above
- `electron/__tests__/paths.test.ts` — new, platform-branch coverage

## Verification
- `pnpm tsc --noEmit` passes
- `pnpm vitest run paths` passes

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-127): Create electron/paths.ts with all named path getters"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
