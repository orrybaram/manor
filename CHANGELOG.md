# Changelog

















## [0.5.13] - 2026-06-17

Features:
- Browser popups that communicate with their opener now open in a managed child window
- Links set to open in the background now correctly open in a new background tab

Fixes:
- Popups and new windows now open reliably using native window handling
- The browser now opens explicit `file:`, `data:`, and `about:` URLs directly instead of running a search
- Browser popups no longer fail to open due to an incorrectly formatted setting
- Shell sessions no longer leak history into the wrong file, and now run `.zlogout` cleanly on exit
- Nested terminal launches no longer break shell environment setup
- Webview automation now reconnects correctly after Manor restarts
- The diff watcher no longer errors on directories that aren't git repositories

## [0.5.12] - 2026-06-12

**Features**
- Sessions now automatically resume where they left off when relaunching the app
- Default branch is detected when a project is created and re-checked at startup to catch drift

**Fixes**
- Branch name casing is now preserved instead of being normalized
- Resume commands now preserve custom flags and no longer append duplicate arguments
- Shell history now respects your global HISTFILE setting instead of overriding it

**Improvements**
- Branch names are handled consistently across the app
- Remote branch lists now refresh origin/HEAD for more accurate default-branch detection

## [0.5.11] - 2026-06-05

Features
- Search terminal scrollback with cmd+f
- Hide and unhide workspaces from the sidebar
- Share a single zsh history file across all panes

Fixes
- Diff view now sizes to full content instead of being capped by a max height
- Hidden workspaces submenu now matches the workspace-list layout

## [0.5.10] - 2026-06-01

**Features**
- Right-click the Projects header in the sidebar to open a context menu

**Fixes**
- Orphaned active tasks no longer linger in the sidebar
- Fixed pane ownership not transferring correctly when creating a task

## [0.5.9] - 2026-06-01

Features:
- Add a "New Project" command to the command palette
- Open the new workspace dialog with a playful empty state when a search returns no results

Fixes:
- Reliably focus the name input when opening the new workspace dialog

Improvements:
- Always keep the Projects section expanded in the sidebar and remove the collapse toggle
- Streamline the sidebar by removing add buttons and tidying the diff file list layout

## [0.5.8] - 2026-05-03

### Features
- Check for Updates menu item in native app menu
- AboutModal now shows Check button, last-checked time, and restart row
- Toasts gain secondary action button and dismiss control

### Improvements
- Update notifications surface via toasts with live status
- Faster, more reliable update checks with periodic background polling

## [0.5.7] - 2026-05-02

Features
- Stream `git push` output live with progress toasts in DiffPane
- Click toasts to expand and view full push output, with auto-expand on errors

Improvements
- Cancel in-flight pushes from the UI
- Clearer push error messages via categorized failure types

## [0.5.6] - 2026-05-02

### Fixes
- Late hook events on responded sessions now dropped correctly

### Improvements
- Hook event handling refactored with typed events and pure state transitions for reliability

## [0.5.5] - 2026-04-29

### Features
- Diff pane: sticky action bar, sidebar layout at wide widths, grouped push+commit action
- Task list: pagination with retention pruning for faster loads
- Working directory now refreshes live from terminal `cd` events

### Fixes
- Generic terminal notifications no longer flip task status incorrectly
- Recover stuck "requires input" tasks during sweeps, bridge handoff, and replacement
- Hook events buffered until the relay connects, preventing lost signals
- Pending Stop signals now apply before sessions transition to completed
- Stale task reconciliation now keys off paneId instead of agent session ID
- Skip spurious agent-detection flip on session start

### Improvements
- More robust hook script (Node-based JSON parsing replaces bash)
- Atomic write for `~/.manor/hook-port` to avoid partial reads
- Validate `agentKind` values and inject `MANOR_AGENT_KIND` per connector
- Monotonic clock for idle sweep math (immune to wall-clock jumps)
- Main process is now authoritative for unseen flags and `resumedAt` timestamps
- Atomic task navigation via a single store action
- Allowlisted fields for `tasks:update` IPC for tighter safety
- O(1) task lookups via id-index
- Removed dead `unlinkPane` code path

## [0.5.4] - 2026-04-22

**Features**
- Duplicate tab now preserves the full pane layout
- Push button added to the diff pane for pushing commits directly from Manor
- Auto-resume active Claude sessions after Manor restarts
- Background setup scripts show a persistent toast and can be reattached via MiniTerminal
- Better tracking of agent subagent start/stop activity

**Fixes**
- Fixed a race when creating new terminals that could miss the initial working directory
- Unified agent status across the tab bar and sidebar
- Orphaned daemon sessions now appear in the Processes view
- Daemon sessions survive version upgrades via a stable socket path
- Task-input toast clears on sidebar navigation; diff watcher quieter for local-only repos
- Previous pane task is properly unlinked on auto-resume
- Handle PTY creation failures gracefully in the terminal lifecycle
- Corrected agent title and status handling
- Commit modal keeps its own state instead of relying on a toast

**Improvements**
- Stale and orphaned tasks are now reconciled on startup and when panes close
- More reliable detection of finished agent runs with inactivity and gone-state sweeps
- Cleaner shell environment inheritance for spawned terminals
- Existing worktrees are handled more gracefully
- Centralized filesystem paths for a more consistent ~/.manor layout

## [0.5.3] - 2026-04-11

**Features**
- Add restart button for portless proxies in the Processes view

**Fixes**
- Include local branches in the existing branch dropdown when creating workspaces
- Clear stale greyed-out state when workspaces change
- Pass base branch and existing branch options through the full worktree creation flow
- Unpack MCP webview server from asar so agents can read it
- Use React state for favicon error handling instead of imperative DOM manipulation
- Fix panel layout crash by keying on workspace path

**Improvements**
- Add recursion guard and fail-fast to uncaught exception handler

## [0.5.2] - 2026-04-07

**Fixes**
- Reset terminal now properly kills the old shell and starts a fresh session
- Startup commands no longer fire before the shell is ready
- Feedback dialog automatically focuses the title field when opened

**Features**
- Screenshots now render inline in Linear ticket detail view

## [0.5.1] - 2026-04-06

**Features**
- Pre-warmed terminal sessions for instant new task startup
- Agent command injection during prewarm for faster session initialization

**Fixes**
- Fixed macOS notification permissions not registering correctly
- Fixed agent command not starting in certain prewarm scenarios
- Fixed potential blocking when writing to prewarmed sessions

## [0.5.0] - 2026-04-06

**Features**
- Add process kill support from the command palette
- Add confirmation dialog for "Kill All" action
- Add "New Workspace" action to the local workspace empty state
- Add processes management to the command palette
- Add colored bottom borders to tabs by content type
- CMD+click on file paths in the terminal now opens them in your editor
- Tasks now display a unified title and status from agent streams

**Fixes**
- Fix garbled and wavy text in terminal rendering
- Fix errors when the daemon is unreachable and empty filter edge case
- Fix dock badge notification dot appearance
- Fix periodic page refreshes caused by proxy server timeouts

## [0.4.2] - 2026-04-05

**Improvements**
- Added a helpful hint when prompted to save your Linear API key to the keychain

## [0.4.1] - 2026-04-05

**Features**
- Added a keyboard shortcut to open diffs directly from the terminal
- Added a toggle in General Settings to configure diff behavior

## [0.4.0] - 2026-04-05

**Fixes**
- Fixed WebGL text rendering glitches after resizing the terminal
- Updated app icon with correct colors
