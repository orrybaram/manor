# ADR: Terminal Session History Persistence

## Status
Accepted

## Context
When Manor closes and reopens, all terminal sessions restart from scratch — panes open in the worktree root directory and have no shell history. Users lose their working context on every app restart.

## Decision
Persist two pieces of session state per pane:

1. **Working directory** — tracked in real-time via `GHOSTTY_ACTION_PWD` (Ghostty fires this on every shell `cd` via OSC 7 / shell integration). Stored in a `paneCWD: [PaneID: String]` in-memory map and written to `projects.json` on save.

2. **Shell history** — each pane gets a dedicated `HISTFILE` environment variable pointing to `~/Library/Application Support/Manor/sessions/<paneUUID>.history`. Shells (zsh/bash) read and write this file automatically. Since `PaneID` is `Codable` and already persisted in the tab tree, the UUID is stable across restarts.

## Architecture

### New data structures (`ProjectPersistence.swift`)
```swift
struct PersistedPaneSession: Codable {
    var lastCWD: String?
}
```
Added as `paneSessions: [String: PersistedPaneSession]` on `PersistedWorktree` (key = pane UUID string).

Static helpers on `ProjectPersistence`:
- `sessionsDirectory` → `~/Library/Application Support/Manor/sessions/`
- `historyFile(for: PaneID)` → `<sessionsDirectory>/<uuid>.history`

### CWD tracking (`ManorWindowController.swift`)
- New property: `private var paneCWD: [PaneID: String] = [:]`
- `GHOSTTY_ACTION_PWD` handler in `GhosttyAppDelegate` extension updates this map in real-time
- `persistProjects()` passes `paneCWD` to `ProjectPersistence.persist(...)`
- `loadProjects()` receives `paneCWD` back from `ProjectPersistence.restore()` and populates it
- `startMissingSurfaces(for:)` uses saved CWD per-pane instead of always defaulting to the worktree root

### History file injection (`ManorWindowController.swift`)
- `startSurfaceForPane` injects env vars via `ghostty_surface_config_s.env_vars`:
  - `HISTFILE` → per-pane history file path
  - `HISTSIZE=10000`, `SAVEHIST=10000` (zsh), `HISTFILESIZE=10000` (bash)
- A private helper `withEnvVarsC(_:body:)` handles the Swift→C string lifetime correctly using recursive `withUnsafeMutableBufferPointer` nesting

## Consequences

### Positive
- Shell history survives app restarts per-pane
- Panes reopen in their last working directory
- No changes to Ghostty internals required — uses existing `GHOSTTY_ACTION_PWD` callback and `env_vars` surface config
- History files are isolated per-pane (no cross-contamination between split panes)

### Negative
- History files accumulate in the sessions directory when panes are permanently closed (no automatic cleanup)
- CWD tracking requires Ghostty shell integration to be active (default for most users)
- If a user has a custom `HISTFILE` set in their shell config, our injected value takes precedence

### Neutral
- `projects.json` grows slightly with `paneSessions` data per worktree
- Sessions directory created lazily on first save

## Files Modified
- `Sources/ManorApp/Models/ProjectPersistence.swift`
- `Sources/ManorApp/App/ManorWindowController.swift`
