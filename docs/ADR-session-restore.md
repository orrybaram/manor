# ADR: Daemon-Backed Session Restore

## Status

Proposed

## Context

Manor currently has **no session restore**. When the app restarts, all terminal sessions — their scrollback content, pane layout, and shell state — are lost. The in-memory Zustand store (`app-store.ts`) holds sessions and pane trees, but nothing is persisted to disk. The `PersistedPaneSession` model in Rust has a `last_cwd` field, but it's never written.

This is the single biggest UX gap versus native terminals like iTerm2, and it becomes especially painful when Manor is used for long-running coding agent sessions where context matters.

[Superset](https://github.com/superset-sh/superset) solves this with a three-layer daemon architecture. We want to adopt the same pattern, adapted for Tauri/Rust.

## Decision

### Architecture: Rust sidecar daemon + scrollback persistence

Introduce a **persistent Rust daemon process** (Tauri sidecar) that owns all PTY sessions and outlives the renderer. The daemon maintains in-memory terminal state and writes scrollback to disk, enabling two restore modes.

### Three-layer design

```
┌─────────────────────────────────────┐
│  Layer 1: Tauri Webview (renderer)  │
│  xterm.js ← display only           │
│  Communicates via Unix socket       │
└──────────────┬──────────────────────┘
               │ Unix domain socket (NDJSON control + binary stream)
┌──────────────▼──────────────────────┐
│  Layer 2: manor-daemon (sidecar)    │
│  Owns PTYs, runs headless emulator  │
│  Persists scrollback to disk        │
│  Lives at ~/.manor/daemon.sock      │
└──────────────┬──────────────────────┘
               │ PTY fd (raw bytes)
┌──────────────▼──────────────────────┐
│  Layer 3: Shell processes           │
│  zsh / bash / fish per pane         │
└─────────────────────────────────────┘
```

### Layer 2: The daemon

A standalone Rust binary shipped as a Tauri sidecar (`manor-daemon`). It:

- **Owns all PTY sessions** — spawns and manages `pty` file descriptors directly
- **Runs a headless terminal emulator** per session using `alacritty_terminal` (or `vte`) to track screen state, cursor position, and terminal modes in-memory
- **Listens on `~/.manor/daemon.sock`** (Unix domain socket) for commands from the Tauri app
- **Auth** via a shared token at `~/.manor/daemon.token`
- **PID tracking** at `~/.manor/daemon.pid` with a spawn-lock to prevent concurrent daemon starts
- **Protocol versioning** — daemon and app negotiate a protocol version on connect; version mismatch triggers graceful daemon restart

#### IPC protocol

Two socket connections per client (mirroring Superset's proven pattern):

| Connection  | Format                                                     | Purpose                                                                       |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Control** | NDJSON request/response                                    | `create_session`, `attach`, `list_sessions`, `resize`, `kill`, `get_snapshot` |
| **Stream**  | Length-prefixed binary frames (4-byte LE header + payload) | PTY output (daemon → app), user input (app → daemon)                          |

Binary framing for the stream connection avoids JSON encoding overhead on high-throughput terminal data.

#### Headless emulator

Each session maintains an `alacritty_terminal::Term` instance that processes all PTY output. This enables:

- **Snapshot generation** — serialize the visible screen + scrollback as ANSI sequences for warm restore
- **Mode tracking** — bracketed paste, mouse mode, application cursor keys, etc. captured as structured state
- **CWD tracking** — parse OSC 7 sequences (already implemented in `pty.rs`)

### Session lifecycle

```
App start → connect to daemon (or spawn it)
         → reconcile: list daemon sessions vs persisted workspace state
         → for each expected session:
              if daemon has it → warm restore (snapshot)
              if daemon lost it → cold restore (scrollback.bin)
              if neither → create fresh session
```

### Restore modes

#### Warm restore (daemon alive, app restarts)

1. App connects to running daemon
2. Calls `get_snapshot(session_id)` → receives `TerminalSnapshot`:
   - `snapshot_ansi: String` — serialized screen state from headless emulator
   - `scrollback_ansi: String` — serialized scrollback buffer
   - `modes: TerminalModes` — DECSET/DECRST flags to replay
   - `cwd: Option<String>` — last known working directory
   - `cols: u16, rows: u16` — terminal dimensions
3. xterm.js writes `snapshot_ansi` to display, replays `modes` via escape sequences
4. Input/output resume over the stream connection — shell process never died

#### Cold restore (daemon also died — crash, reboot, update)

1. App finds no daemon (or stale PID) → spawns new daemon
2. Checks `~/.manor/sessions/{session_id}/` for:
   - `meta.json` — dimensions, cwd, timestamps. Missing `ended_at` = unclean shutdown
   - `scrollback.bin` — raw PTY output, append-only
3. If unclean shutdown detected:
   - Reads `scrollback.bin` (truncated to 500KB, UTF-8 safe boundary)
   - Writes content to xterm.js as initial display
   - Shows a visual indicator: "Session restored from disk — shell restarted"
   - Spawns new shell in same cwd

### Scrollback persistence

The daemon writes two files per session to `~/.manor/sessions/{session_id}/`:

| File             | Format                 | Purpose                                     |
| ---------------- | ---------------------- | ------------------------------------------- |
| `scrollback.bin` | Raw bytes, append-only | PTY output stream for cold restore          |
| `meta.json`      | JSON                   | `{ cols, rows, cwd, created_at, ended_at }` |

**Write path:**

1. PTY produces output → daemon reads it
2. Daemon feeds output to headless emulator (state tracking)
3. Daemon forwards output to connected app client (display)
4. Daemon appends output to in-memory buffer (256KB cap)
5. Buffer flushes to `scrollback.bin` on threshold or timer (every 2s)
6. Hard cap: 5MB per session file, oldest bytes truncated

**Clear-scrollback handling:** If a `\e[3J` (clear scrollback) sequence is detected, `scrollback.bin` is truncated and restarted with only post-clear content.

### Pane layout persistence

Separately from scrollback, persist the session/pane tree structure in the existing `projects.json`:

```json
{
  "workspaces": [
    {
      "sessions": [
        {
          "id": "uuid",
          "title": "...",
          "root_node": { "type": "leaf", "pane_id": "..." },
          "focused_pane_id": "...",
          "pane_sessions": {
            "pane-uuid": {
              "daemon_session_id": "uuid",
              "last_cwd": "/path/to/dir"
            }
          }
        }
      ]
    }
  ]
}
```

On startup, the app reads this layout and calls `attach(daemon_session_id)` for each pane.

### Changes required

#### New: `manor-daemon` sidecar binary

| Module           | Responsibility                                        |
| ---------------- | ----------------------------------------------------- |
| `main.rs`        | Socket listener, auth, spawn lock, signal handling    |
| `session.rs`     | PTY ownership, headless emulator, snapshot generation |
| `protocol.rs`    | NDJSON control + binary stream frame codec            |
| `persistence.rs` | Scrollback writer, meta.json management               |

#### Modified: `src-tauri/`

| File              | Change                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| `pty.rs`          | Remove direct PTY management; replace with daemon client that connects over Unix socket |
| `persistence.rs`  | Add session/pane tree serialization to `projects.json`                                  |
| `models.rs`       | Add `daemon_session_id` to `PersistedPaneSession`                                       |
| `lib.rs`          | Add daemon lifecycle management (spawn, connect, health check)                          |
| `tauri.conf.json` | Register `manor-daemon` as a sidecar                                                    |

#### Modified: `src/` (frontend)

| File               | Change                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `TerminalPane.tsx` | On mount: check for snapshot → write to xterm.js before resuming live stream |
| `app-store.ts`     | Persist session tree to backend on layout changes (add/remove/split)         |

### Implementation phases

**Phase 1 — Cold restore only (no daemon yet)**

- Add scrollback persistence directly in `pty.rs` (write `scrollback.bin` from the PTY reader thread)
- Persist pane layout in `projects.json`
- On startup: restore layout, replay scrollback into xterm.js, spawn fresh shells in saved CWDs
- This gives us 80% of the value with 20% of the complexity

**Phase 2 — Daemon extraction**

- Extract PTY management into `manor-daemon` sidecar
- Add Unix socket IPC (control + stream)
- Warm restore via daemon snapshots

**Phase 3 — Headless emulator + polish**

- Add `alacritty_terminal` headless emulator to daemon
- Snapshot generation for pixel-perfect warm restore
- Mode tracking and replay
- Protocol versioning

## Consequences

### Positive

- **Sessions survive app restarts** — the most requested feature gap
- **Sessions survive daemon crashes** — cold restore from scrollback.bin is a safety net
- **PTY isolation** — daemon crash doesn't take down the UI; UI crash doesn't kill shells
- **Foundation for future features** — session sharing, remote terminals, headless operation
- **Phased approach** — Phase 1 delivers immediate value without the daemon complexity

### Negative

- **Architectural complexity** — two processes instead of one; IPC adds failure modes and debugging surface area
- **New dependency** — `alacritty_terminal` (Phase 3) is a substantial crate; adds compile time and API surface to track
- **Disk usage** — scrollback files at 5MB cap × many sessions could accumulate; needs cleanup policy
- **Daemon lifecycle** — orphaned daemons, version mismatches, and spawn races need careful handling
- **Latency** — IPC hop adds ~1ms per frame vs direct PTY reads; should be imperceptible but needs measurement
