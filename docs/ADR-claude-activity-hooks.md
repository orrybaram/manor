# ADR: Claude Activity Hooks in the UI

## Status
Proposed

## Context

Manor users increasingly run Claude Code sessions inside worktree terminals. There is no visual feedback about the state of those sessions — you can't tell from the sidebar or tab bar whether Claude is actively working, waiting for input, or done.

Three signal states matter:

1. **Active** — Claude is running (thinking, editing, executing tools).
2. **Needs attention** — Claude has stopped and is waiting for the user (permission request, question, or error it can't resolve).
3. **Done** — Claude finished its task successfully.

Claude Code exposes these states through its hook system (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`). The hooks fire shell commands; we can use them to write a small status file per session that Manor watches.

## Decision

### Signal sources: zero-install, purely observational

No hook installation required. All three signals flow through Ghostty's existing `ghosttyAction` callback, which Manor already handles, plus macOS process inspection APIs.

#### Signal 1 — Process monitoring → `active` / `idle`

Manor injects a `MANOR_PANE_ID=<uuid>` env var into every pane shell at surface creation time (alongside the existing `HISTFILE` and `ZDOTDIR` injections — one additional line).

A background poller (every 2 seconds) walks the macOS process list via `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_ALL)` and reads each process's environment with `KERN_PROCARGS2`. When a process named `claude` (or `node` running a `claude` script) is found carrying a known `MANOR_PANE_ID`, that pane transitions to `active`. When no such process exists, the pane is `idle`.

This gives us the primary running/not-running signal without any cooperation from Claude Code.

#### Signal 2 — `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` → `waiting`

Claude Code sends an OSC 9 desktop notification (`\e]9;message\a`) when it needs user input (permission requests, questions it can't resolve, errors requiring a decision). Ghostty converts this to `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` with `title` and `body` fields. Manor already handles `ghosttyAction` — we add a `case GHOSTTY_ACTION_DESKTOP_NOTIFICATION:` branch that identifies the source surface via `target.target.surface`, maps it to a `PaneID`, and sets that pane's state to `waiting`.

#### Signal 3 — `GHOSTTY_ACTION_COMMAND_FINISHED` → `done` / `waiting`

When shell integration is active, Ghostty fires `GHOSTTY_ACTION_COMMAND_FINISHED` on the surface where a foreground command exits, carrying `exit_code` and `duration`. We add a `case GHOSTTY_ACTION_COMMAND_FINISHED:` branch: `exit_code == 0` → `done`; non-zero → `waiting` (Claude stopped with an error, likely needs attention).

#### State transition summary

| Event | New state |
|---|---|
| `claude` process found with matching `MANOR_PANE_ID` | `active` |
| `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` on surface | `waiting` |
| `GHOSTTY_ACTION_COMMAND_FINISHED` exit 0 | `done` |
| `GHOSTTY_ACTION_COMMAND_FINISHED` exit ≠ 0 | `waiting` |
| No `claude` process + no recent signal | `idle` |

### New state in `AppState`

```swift
enum ClaudeSessionState {
    case idle      // no status file or file is stale (> 5 min)
    case active    // Claude is running
    case waiting   // Claude needs the user
    case done      // Claude finished successfully
}

// Key = PaneID
@Published var claudeSessionStates: [PaneID: ClaudeSessionState] = [:]
```

A derived computed property aggregates per-pane states up to the worktree level:

```swift
func claudeState(forWorktree wt: WorktreeModel) -> ClaudeSessionState {
    // Returns .active if any pane is active, else .waiting if any waiting, else .done if any done, else .idle
}

func activeClaudeCount(forWorktree wt: WorktreeModel) -> Int {
    // Count of panes in .active state
}
```

### Visual design

#### 1. Sidebar — worktree row badge

Each worktree row in `SidebarProjectsView` gets a status badge on the trailing edge:

| State | Badge |
|---|---|
| `active` (N sessions) | Spinning arc loader with `N` in the center (white number, ~14pt circle) |
| `waiting` | Solid red dot (8pt) |
| `done` | Solid green dot (8pt) |
| `idle` | Nothing |

The spinning loader uses a SwiftUI `@State private var rotation: Double` driven by a `.onAppear` animation (`Animation.linear(duration: 1).repeatForever(autoreverses: false)`), not a `Timer`.

When N > 1 the number is shown; when N == 1 the number is omitted (just the spinner).

#### 2. Tab bar — per-tab indicator

Each tab item in `TabBarSwiftUIView` adds a small status dot in the leading edge of the tab label area:

| State | Indicator |
|---|---|
| `active` | Tiny spinning arc (10pt, same animation) |
| `waiting` | Red dot (6pt) |
| `done` | Green dot (6pt) |
| `idle` | Nothing |

Tab-level state is the aggregate of all panes within that tab (same priority: active > waiting > done > idle).

#### 3. Color tokens

Use existing `GhosttyTheme` where possible; add two semantic colors:

```swift
extension GhosttyTheme {
    var claudeActiveColor: NSColor { .white.withAlphaComponent(0.75) }
    var claudeWaitingColor: NSColor { NSColor(red: 0.85, green: 0.25, blue: 0.25, alpha: 1) }
    var claudeDoneColor: NSColor { NSColor(red: 0.3, green: 0.8, blue: 0.4, alpha: 1) }
}
```

## Architecture

### New files
- `Sources/ManorApp/Services/ClaudeSessionMonitor.swift` — owns the 2-second `DispatchSourceTimer` that walks the process list, publishes `[PaneID: ClaudeSessionState]` changes on `@MainActor`.
- `Sources/ManorApp/Views/ClaudeStatusBadge.swift` — reusable SwiftUI view for spinner + dot variants.

### Modified files
- `AppState.swift` — add `claudeSessionStates`, start/stop `ClaudeSessionMonitor`, add derived helpers.
- `AppState.swift` (`startSurfaceForPane`) — add `MANOR_PANE_ID=<uuid>` to the existing `envVarPairs` array (one line).
- `ManorWindowController.swift` — add `case GHOSTTY_ACTION_DESKTOP_NOTIFICATION:` and `case GHOSTTY_ACTION_COMMAND_FINISHED:` branches to `ghosttyApp(_:didReceiveAction:target:)`.
- `TabBarView.swift` — read tab-level aggregate state; add `ClaudeStatusBadge` to each tab item.
- `SidebarProjectsView.swift` — read worktree-level aggregate state + count; add `ClaudeStatusBadge` to worktree rows.

## Consequences

### Positive
- Zero user setup — no hooks to install, no `~/.claude/settings.json` to modify.
- Zero changes to Ghostty internals — purely additive: one env var + two new `case` branches in the existing action handler.
- Works for any version of Claude Code, past or future.
- SwiftUI's reactive binding means badges appear/disappear automatically with no manual sync.
- Users who don't use Claude Code see no UI change (badge is hidden when `idle`).

### Negative
- Process monitoring polls every 2 seconds — minor CPU cost, but negligible for a desktop app.
- `MANOR_PANE_ID` leaks into all child processes of the shell (low risk; it's an opaque UUID with no security implications).
- `GHOSTTY_ACTION_COMMAND_FINISHED` requires Ghostty shell integration to be active; users without it won't get `done` state (they still get `active`/`waiting`).
- `GHOSTTY_ACTION_DESKTOP_NOTIFICATION` requires Claude Code to send OSC 9 when needing attention — verified behavior but could change in future Claude Code versions.

### Neutral
- `done` state auto-clears to `idle` after 60 seconds so the green dot doesn't linger indefinitely.
- Process monitoring naturally handles multiple Claude sessions per pane (count reflects running processes, not a single flag).
