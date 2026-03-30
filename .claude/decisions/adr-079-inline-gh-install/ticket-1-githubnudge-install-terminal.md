---
title: Add inline xterm install terminal to GitHubNudge
status: done
priority: high
assignee: opus
blocked_by: []
---

# Add inline xterm install terminal to GitHubNudge

Rewrite `GitHubNudge.tsx` to support an embedded xterm terminal that installs `gh` via Homebrew, and update `WorkspaceEmptyState.tsx` to pass a refresh callback. Also add the necessary CSS.

## Implementation

### GitHubNudge.tsx

Add state machine with three phases: `idle` → `installing` → `done`

**Idle state**: Current nudge UI plus an "Install Now" button (styled like `nudgeLink` but as a visible button).

**Installing state**:
- Create a PTY session: `window.electronAPI.pty.create(paneId, null, cols, rows)`
- Mount xterm `Terminal` into a ref'd div below the nudge bar
- Load `FitAddon` only
- Apply theme from `useThemeStore((s) => s.theme)` converted to `ITheme`
- Subscribe to `pty.onOutput` and `pty.onExit`
- Write `brew install gh\r` to the PTY
- Terminal container slides open via CSS `max-height` transition (0 → 200px)

**Done state** (on PTY exit with code 0):
- Show a success indicator (checkmark icon replacing the terminal or overlaid)
- Call `onInstalled?.()` callback
- Clean up PTY via `pty.close(paneId)`

**Error state** (on PTY exit with non-zero code):
- Leave terminal visible so user can read the error
- Show a "Try Again" or "Close" option

### WorkspaceEmptyState.tsx

- Pass `onInstalled` prop to `GitHubNudge`
- `onInstalled` callback re-runs the GitHub status check + issue fetch (same logic as `fetchGitHubIssues`)

### EmptyState.module.css

Add styles:
- `.nudgeInstallBtn` — "Install Now" button styling
- `.nudgeTerminalWrapper` — sliding container with `max-height` transition
- `.nudgeTerminal` — the xterm container div (200px height, rounded corners, overflow hidden)
- `.nudgeSuccess` — success checkmark animation

## Files to touch
- `src/components/GitHubNudge.tsx` — main changes, add xterm integration
- `src/components/WorkspaceEmptyState.tsx` — pass `onInstalled` callback to GitHubNudge
- `src/components/EmptyState.module.css` — add terminal and animation styles
