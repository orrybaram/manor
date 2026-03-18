# ADR: Migrate from Swift/AppKit to Tauri with ghostty-web

## Status
Proposed

## Context

Manor is a native macOS terminal application built with Swift (SwiftUI + AppKit) using GhosttyLib via C FFI for terminal rendering on a Metal-backed `CAMetalLayer`. While this approach delivers excellent native performance, it has significant drawbacks:

1. **Platform lock-in** — the entire codebase (Swift, AppKit, Metal, SPM) is macOS-only. Supporting Linux or Windows would require a full rewrite.

2. **Swift is outside the contributor's core expertise** — the primary developer has a web/React background. Every feature takes longer than it would in TypeScript, and debugging AppKit lifecycle issues (surface pinning, `NSView` identity, `CAMetalLayer` ordering) has been a recurring time sink.

3. **Complex build pipeline** — the current build requires Zig (for GhosttyKit xcframework), swiftc with custom linker flags, VFS overlays, and a Makefile that orchestrates all of it. This is fragile and hard to maintain.

4. **ghostty-web now exists** — [coder/ghostty-web](https://github.com/coder/ghostty-web) compiles GhosttyLib to WebAssembly and renders to an HTML `<canvas>`. This provides Ghostty's terminal quality without requiring Metal, AppKit, or C FFI. The I/O interface is trivially simple: `term.write(data)` for input, `term.onData(cb)` for output.

5. **Tauri is a mature, lightweight alternative** — Tauri v2 provides native window management, system tray, IPC, and file system access with a Rust backend and web frontend. The binary size is comparable to the current Swift build (~15-20MB). Tauri supports macOS, Linux, and Windows from a single codebase.

## Decision

Rewrite Manor as a Tauri v2 application with:

- **Frontend**: TypeScript + React, using ghostty-web for terminal rendering
- **Backend**: Rust, managing PTY sessions, git operations, persistence, and port scanning
- **Terminal**: ghostty-web (WASM) rendering to `<canvas>` in the webview

Drop the Swift/AppKit/Metal stack entirely.

## Architecture

### High-level overview

```
┌──────────────────────────────────────────────────┐
│                  Tauri Window                     │
│  ┌────────────────────────────────────────────┐  │
│  │              Webview (React)                │  │
│  │  ┌──────────┬─────────────────────────┐    │  │
│  │  │ Sidebar  │  Tab Bar                │    │  │
│  │  │          ├─────────────────────────┤    │  │
│  │  │ Projects │  ghostty-web <canvas>   │    │  │
│  │  │ Ports    │  (per pane)             │    │  │
│  │  │          │                         │    │  │
│  │  └──────────┴─────────────────────────┘    │  │
│  └──────────────────┬─────────────────────────┘  │
│                     │ Tauri IPC (invoke/events)   │
│  ┌──────────────────┴─────────────────────────┐  │
│  │              Rust Backend                   │  │
│  │  ┌─────────────┐  ┌────────────────────┐   │  │
│  │  │ PTY Manager │  │ Project/Persistence │   │  │
│  │  │ (per pane)  │  │ (JSON, same format) │   │  │
│  │  └─────────────┘  └────────────────────┘   │  │
│  │  ┌─────────────┐  ┌────────────────────┐   │  │
│  │  │ Git Ops     │  │ Port Scanner       │   │  │
│  │  └─────────────┘  └────────────────────┘   │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Frontend (React + TypeScript)

The UI maps directly from the current SwiftUI views:

| Current (SwiftUI)              | New (React)                     |
|-------------------------------|---------------------------------|
| `RootView`                    | `<App />` root layout           |
| `SidebarContainerView`        | `<Sidebar />`                   |
| `SidebarProjectsView`         | `<SidebarProjects />`           |
| `SidebarPortsView`            | `<SidebarPorts />`              |
| `TabBarView`                  | `<TabBar />`                    |
| `PaneLayoutView`              | `<PaneLayout />` (recursive)    |
| `GhosttySurfaceRepresentable` | `<TerminalPane />` (ghostty-web)|
| `EmptyStateView`              | `<EmptyState />`                |
| `ThemeDivider`                | `<Divider />`                   |

#### State management

Replace `AppState` + `*Manager` classes with a state management approach familiar from React. Options include Zustand, Jotai, or React context — choose based on complexity at implementation time. The state shape mirrors the current model:

```typescript
interface AppState {
  projects: ProjectModel[];
  selectedProjectId: string | null;
  sidebarVisible: boolean;
  sidebarWidth: number;
  activePorts: ActivePort[];
}
```

Tab and pane state remain nested within `ProjectModel → WorktreeModel → TabModel → PaneNode`, matching the current `ManorCore` models.

#### Terminal pane component

```typescript
function TerminalPane({ paneId }: { paneId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({ fontSize: 14 });
    term.open(containerRef.current!);
    termRef.current = term;

    // PTY output → terminal display
    const unlisten = listen(`pty-output-${paneId}`, (e) => {
      term.write(e.payload as string);
    });

    // User input → PTY
    term.onData((data) => {
      invoke('pty_write', { paneId, data });
    });

    // Resize → PTY
    term.onResize(({ cols, rows }) => {
      invoke('pty_resize', { paneId, cols, rows });
    });

    return () => {
      unlisten.then(fn => fn());
      invoke('pty_close', { paneId });
      term.dispose();
    };
  }, [paneId]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
```

### Backend (Rust)

#### PTY management

Each pane gets its own PTY session managed in Rust. Use `portable-pty` for cross-platform PTY support.

```rust
use portable_pty::{CommandBuilder, PtySize, native_pty_system, PtyPair};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct PtySession {
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
    // child process handle for cleanup
}

struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[tauri::command]
fn pty_create(
    app: AppHandle,
    state: State<'_, PtyState>,
    pane_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, .. })?;

    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // Inject MANOR_PANE_ID for shell integration
    cmd.env("MANOR_PANE_ID", &pane_id);

    let _child = pair.slave.spawn_command(cmd)?;

    // Reader thread: PTY output → frontend event
    let reader = pair.master.try_clone_reader()?;
    let app_handle = app.clone();
    let pid = pane_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    app_handle.emit(&format!("pty-output-{}", pid), data).ok();
                }
            }
        }
    });

    let writer = pair.master.take_writer()?;
    state.sessions.lock().unwrap().insert(pane_id, PtySession { pair, writer });
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, PtyState>, pane_id: String, data: String) {
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&pane_id) {
        session.writer.write_all(data.as_bytes()).ok();
    }
}

#[tauri::command]
fn pty_resize(state: State<'_, PtyState>, pane_id: String, cols: u16, rows: u16) {
    if let Some(session) = state.sessions.lock().unwrap().get_mut(&pane_id) {
        session.pair.master.resize(PtySize { rows, cols, .. }).ok();
    }
}
```

#### Persistence

Reuse the same JSON format and file locations (`~/Library/Application Support/Manor/projects.json` on macOS, XDG equivalent on Linux). The `ManorCore` models translate directly to Rust structs with `serde`:

```rust
#[derive(Serialize, Deserialize)]
struct ProjectModel {
    id: String,
    name: String,
    path: String,
    worktrees: Vec<WorktreeModel>,
}

#[derive(Serialize, Deserialize)]
struct WorktreeModel {
    id: String,
    name: String,
    path: String,
    branch: String,
    tabs: Vec<TabModel>,
}

#[derive(Serialize, Deserialize)]
struct TabModel {
    id: String,
    title: String,
    pane_root: PaneNode,
}

#[derive(Serialize, Deserialize)]
enum PaneNode {
    Leaf { pane_id: String },
    Split { direction: SplitDirection, ratio: f64, first: Box<PaneNode>, second: Box<PaneNode> },
}
```

#### Git operations

Replace `Process("/usr/bin/git", ...)` calls with `git2` crate (libgit2 bindings) for worktree listing, branch info, and status. Falls back to CLI for operations `git2` doesn't cover well (e.g., `git worktree add`).

#### Port scanning

Move from Network.framework stub to Rust's `std::net::TcpListener` / `netstat2` crate for cross-platform port discovery.

### Keybindings

Tauri v2 supports global shortcuts. Map the current bindings:

| Shortcut       | Action              | Implementation                         |
|---------------|---------------------|----------------------------------------|
| Cmd+T         | New Tab             | Tauri global shortcut → invoke          |
| Cmd+D         | Split Horizontal    | Tauri global shortcut → invoke          |
| Cmd+Shift+D   | Split Vertical      | Tauri global shortcut → invoke          |
| Cmd+W         | Close Pane          | Tauri global shortcut → invoke          |
| Cmd+Shift+W   | Close Tab           | Tauri global shortcut → invoke          |
| Cmd+Shift+]   | Next Tab            | Tauri global shortcut → invoke          |
| Cmd+Shift+[   | Previous Tab        | Tauri global shortcut → invoke          |
| Cmd+\         | Toggle Sidebar      | Frontend state toggle                   |
| Cmd+Shift+O   | Open Project        | Tauri file dialog → invoke              |
| Cmd+,         | Project Settings    | Frontend modal                          |

### Theming

The current GhosttyTheme parsing reads Ghostty config files for colors. In the new architecture:

- Rust backend reads ghostty config and exposes theme as a Tauri command
- Frontend applies theme via CSS custom properties
- ghostty-web accepts theme options (`ITheme`) directly in its constructor

```typescript
const theme = await invoke<Theme>('get_theme');
const term = new Terminal({
  theme: {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    // ... palette colors
  }
});
```

### Shell integration

The current ZDOTDIR-based history injection and `MANOR_PANE_ID` env var approach works identically — the Rust PTY manager injects the same environment variables when spawning shells. The wrapper scripts in `~/Library/Application Support/Manor/zdotdir/` are platform-independent shell scripts and need no changes.

## Migration phases

### Phase 1: Scaffold Tauri project
- Initialize Tauri v2 project alongside existing Swift code
- Set up React + TypeScript frontend with Vite
- Integrate ghostty-web (npm package or WASM build)
- Prove out a single terminal pane: PTY in Rust ↔ ghostty-web in webview

### Phase 2: Core terminal features
- PTY manager with create/write/resize/close
- Multi-pane layout with splits (recursive `PaneNode` rendering)
- Tab bar with create/close/reorder
- Keybinding system

### Phase 3: Project & sidebar
- Port `ProjectModel` / `WorktreeModel` to Rust (serde)
- Persistence (read/write `projects.json`)
- Sidebar UI: project list, worktree expansion, port section
- Git worktree operations

### Phase 4: Polish & parity
- Theming (read ghostty config, CSS custom properties)
- Shell integration (ZDOTDIR, HISTFILE, per-pane history)
- Session persistence (CWD tracking, restore on relaunch)
- Window chrome (draggable regions, traffic light positioning)
- Project settings dialog

### Phase 5: Cross-platform & stretch goals
- Test and fix Linux support
- GitHub PR integration
- Port scanner implementation
- Command palette (Cmd+K)

## Consequences

### Benefits
- **Cross-platform** — Linux and Windows support from a single codebase
- **Familiar stack** — TypeScript/React frontend matches contributor expertise; Rust backend is well-documented and has strong ecosystem
- **Simpler terminal integration** — `term.write()` / `term.onData()` replaces C FFI, Metal layers, `NSView` lifecycle management, and `NSViewRepresentable` pinning
- **Better UI tooling** — CSS for layout/theming, React DevTools for debugging, hot reload during development
- **Community leverage** — Tauri and ghostty-web are actively maintained; reduces custom infrastructure

### Risks & tradeoffs
- **ghostty-web maturity** — the project is relatively new. Rendering fidelity, performance, and edge cases (ligatures, OSC sequences, sixel graphics) may not match native GhosttyLib yet
- **Canvas rendering vs Metal** — WASM + canvas will be slower than native Metal rendering. For a terminal this is likely imperceptible, but should be validated with large scrollback and fast output (e.g., `cat` a large file)
- **Webview overhead** — Tauri's webview adds memory overhead compared to native AppKit. Each window is a full webview process
- **Tauri v2 stability** — Tauri v2 is newer; some APIs (multi-window, child webviews) may have rough edges
- **Migration effort** — this is a full rewrite, not an incremental migration. The current SwiftUI migration (in progress) would be abandoned
- **macOS-native feel** — web-based UI won't perfectly match macOS conventions (vibrancy, native context menus, system font rendering). Tauri provides some native integration but it's not 1:1

### What we keep
- **Domain model** — `ProjectModel → WorktreeModel → TabModel → PaneNode` hierarchy is unchanged
- **Persistence format** — same JSON schema, same file locations
- **Shell integration** — same ZDOTDIR wrapper, same env vars
- **Keybindings** — same shortcuts, same behavior
- **Architecture patterns** — reactive state, manager separation, binary tree pane layout

### What we lose
- **Native Metal rendering** — replaced by WASM canvas (acceptable tradeoff for cross-platform)
- **AppKit window management** — replaced by Tauri window APIs
- **In-progress SwiftUI migration work** — this ADR supersedes ADR-swiftui-migration if accepted
