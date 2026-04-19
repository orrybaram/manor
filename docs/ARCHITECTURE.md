# Manor — Architecture

> High-level map of the Manor codebase. Describes modules, invariants, and cross-cutting concerns. Revisit a few times a year — do not keep synchronized with code. Details of how modules work live inline in source or in ADRs under `docs/decisions/`.

## What Manor is

Manor is a macOS-first Electron desktop app for developers working with git worktrees and AI coding agents. It wraps terminals (xterm.js + node-pty) in a tabbed, split-pane workspace and layers on top: agent status detection, per-workspace git diff/branch watching, GitHub/Linear issue linking, a built-in browser pane for local dev servers, port scanning, and session persistence that survives app restarts.

Each **project** is a git repository on disk. Each **workspace** inside a project is a git worktree (or the main checkout). Each workspace contains a tree of **panes** — terminal, browser, or diff viewer — laid out in splits and tabs.

## Process architecture

Manor runs up to four concurrent process types. The main Electron process is not where PTY sessions live; they live in a separate long-running daemon so they survive app restarts.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron App (one per user)                                          │
│                                                                      │
│  ┌─────────────────┐        ┌────────────────────┐                   │
│  │ Renderer        │◄──────►│ Preload            │                   │
│  │ (React, Zustand)│  IPC   │ (contextBridge)    │                   │
│  └────────┬────────┘        └─────────┬──────────┘                   │
│           │                           │                              │
│           │                  ┌────────▼──────────┐                   │
│           │                  │ Main Process      │                   │
│           │                  │ (app-lifecycle)   │                   │
│           │                  └─┬──────┬──────────┘                   │
│           │                    │      │                              │
│           │         Unix socket│      │ stdio                        │
│           │                    │      │                              │
└───────────┼────────────────────┼──────┼──────────────────────────────┘
            │                    │      │
            │                    ▼      ▼
            │         ┌──────────────┐  ┌──────────────────────┐
            │         │ Terminal Host│  │ MCP Webview Server   │
            │         │ Daemon       │  │ (stdio, for Claude)  │
            │         │ (Node, long- │  └──────────────────────┘
            │         │  lived)      │
            │         └──────┬───────┘
            │                │ fork
 webview ◄──┤                ▼
 HTTP       │         ┌──────────────┐
 server  ◄──┘         │ PTY Subproc  │ (one per pane)
                      │ (node-pty)   │
                      └──────────────┘
```

**Renderer** — React 19 UI. Runs per app window. Owns layout, store, xterm.js terminals, and all user interaction. Never talks to the filesystem, git, or PTYs directly — only via `window.electronAPI`.

**Preload** (`electron/preload.ts`) — The only bridge between renderer and main. Whitelists IPC channels and exposes a typed `window.electronAPI` object via `contextBridge`. Renderer types for it live in `src/electron.d.ts`.

**Main process** (`electron/main.ts` → `electron/app-lifecycle.ts`) — Window lifecycle, auto-updater, menu, and all `ipcMain` handlers. Owns the singleton managers (projects, tasks, themes, prefs, keybindings, GitHub, Linear, branch/diff watchers, port scanner, agent-hook HTTP server, prewarm manager). Does NOT run PTYs — it speaks to the terminal-host daemon over a Unix socket.

**Terminal Host Daemon** (`electron/terminal-host/`) — Separate Node process spawned from main via `ELECTRON_RUN_AS_NODE=1`. Intentionally outlives the app: on app quit, main does not kill the daemon, so terminals survive restarts. Exposes two Unix-socket channels (control + stream). Forks one **PTY subprocess** per session. Detects agent activity (Claude, Codex, OpenCode) via title + output pattern matching. Serializes scrollback so restored sessions repaint on reconnect.

**MCP Webview Server** (`electron/mcp-webview-server.ts`) — Standalone Node process speaking MCP over stdio. Used by connected AI agents (e.g. Claude Code via `~/.manor/webview-server-port`) to inspect and interact with the in-app browser pane. `asarUnpack`ed from the bundle so it can spawn outside the ASAR.

## Codemap

```
manor/
├── electron/                 main, preload, daemon, managers
│   ├── main.ts               thin entry (PATH setup, dev title, calls initApp)
│   ├── app-lifecycle.ts      wires managers, IPC, window events, auto-update
│   ├── preload.ts            contextBridge surface
│   ├── window.ts             bounds/zoom persistence, display safety
│   ├── persistence.ts        ProjectManager — projects, workspaces, worktrees
│   ├── task-persistence.ts   TaskManager — agent tasks across panes
│   ├── preferences.ts        PreferencesManager
│   ├── keybindings.ts        KeybindingsManager
│   ├── theme.ts              ThemeManager (Ghostty-compatible palettes)
│   ├── github.ts             GitHubManager — wraps `gh` CLI
│   ├── linear.ts             LinearManager — GraphQL client
│   ├── branch-watcher.ts     polls .git/HEAD per workspace
│   ├── diff-watcher.ts       runs `git diff` against default branch
│   ├── portless.ts + ports.ts  port scanner + named preview URLs
│   ├── agent-hooks.ts        localhost HTTP server for agent shell hooks
│   ├── agent-connectors.ts   writes MCP config into agent tool configs
│   ├── notifications.ts      dock badge, system notifications
│   ├── prewarm-manager.ts    pre-spawns a PTY for faster pane creation
│   ├── updater.ts            electron-updater wrapper
│   ├── webview-server.ts     in-app HTTP server backing the MCP webview tools
│   ├── webview-cli-script.ts installable CLI bridge for external agents
│   ├── picker-script.ts      JS injected into webviews for element picking
│   ├── mcp-webview-server.ts standalone MCP server (external process)
│   ├── sourcemap-symbolication.ts  resolves renderer stack traces in prod
│   ├── ipc-validate.ts       shared assert helpers for IPC args
│   ├── ipc/                  thin handler files, grouped by domain
│   │   ├── pty.ts            pty:create/write/resize/close/reset/detach
│   │   ├── projects.ts       projects:* and worktree ops
│   │   ├── branches-diffs.ts branches:*, diffs:*, git:stage/unstage/commit/push
│   │   ├── integrations.ts   github:* and linear:*
│   │   ├── tasks.ts          tasks:* CRUD + reconciliation
│   │   ├── processes.ts      process listing and cleanup
│   │   ├── webview.ts        webview zoom, picker, find-in-page
│   │   ├── layout.ts         layout:save / layout:load
│   │   ├── ports.ts          port scanner controls
│   │   ├── theme.ts          theme selection
│   │   └── misc.ts           dialog, shell, clipboard, prefs, keybindings, updater
│   ├── backend/              pluggable backend abstraction (local only today)
│   │   ├── types.ts          PtyBackend / GitBackend / ShellBackend / PortsBackend
│   │   ├── local-backend.ts  composes the local implementations
│   │   ├── local-pty.ts      delegates to TerminalHostClient
│   │   ├── local-git.ts      shells out to `git`
│   │   ├── local-ports.ts    portless integration
│   │   └── local-shell.ts    zdotdir + env handoff
│   └── terminal-host/        long-lived daemon
│       ├── index.ts          daemon entry (sockets, auth token, supervision)
│       ├── client.ts         main-process client (TerminalHostClient)
│       ├── terminal-host.ts  daemon core — session registry
│       ├── session.ts        single session state, agent detection hooks
│       ├── pty-subprocess.ts node-pty child that owns the actual PTY
│       ├── pty-subprocess-ipc.ts  message framing between daemon ↔ subprocess
│       ├── agent-detector.ts Claude/Codex/OpenCode pattern detection
│       ├── output-pattern-matcher.ts  regex matchers for status states
│       ├── title-detector.ts pulls agent state from terminal title
│       ├── scrollback.ts     xterm-serialize wrapper for session snapshots
│       ├── layout-persistence.ts  durable pane/tab layout store
│       └── xterm-env-polyfill.ts  headless xterm setup
│
├── src/                      React renderer
│   ├── main.tsx              entry — wraps App in QueryClientProvider
│   ├── App.tsx               top-level: modals, global keys, store wiring
│   ├── electron.d.ts         types for window.electronAPI
│   ├── webview.d.ts          webview element typings
│   ├── agent-defaults.ts     default agent command strings
│   ├── project-colors.ts     project color palette
│   ├── store/                Zustand stores
│   │   ├── app-store.ts          active workspace, panes, tabs, panels (largest)
│   │   ├── project-store.ts      projects list, setup state, custom commands
│   │   ├── task-store.ts         task list + filters
│   │   ├── theme-store.ts        selection + preview
│   │   ├── preferences-store.ts  UI layout prefs
│   │   ├── keybindings-store.ts  custom bindings overlay
│   │   ├── toast-store.ts        toast queue
│   │   ├── browser-history-store.ts   per-pane URL history
│   │   ├── drag-overlay-store.ts      drag visual state
│   │   ├── pane-tree.ts          pane-tree mutation helpers (pure)
│   │   ├── panel-tree.ts         top-level panel split tree
│   │   └── workspace-actions.ts  composite workspace actions
│   ├── components/
│   │   ├── ui/               design system (Button, Input, Switch, Toast, …)
│   │   ├── panels/           SplitPanelLayout, LeafPanel
│   │   ├── workspace-panes/  TerminalPane, BrowserPane, DiffPane, SplitLayout
│   │   ├── sidebar/          project + workspace list, PR popover, dialogs
│   │   ├── tabbar/           tabs, breadcrumbs
│   │   ├── command-palette/  Cmd-K palette, GitHub/Linear issue views
│   │   ├── settings/         settings modal — theme, integrations, keybindings
│   │   ├── statusbar/        status bar, feedback modal, about modal
│   │   └── ports/            port list, badges, groupings
│   ├── hooks/                useTerminalLifecycle, useDiffWatcher, useBranchWatcher,
│   │                         useWorkspaceDrag, useAutoUpdate, useListKeyboardNav, …
│   ├── terminal/             xterm.js addon wiring, paint helpers
│   ├── lib/                  keybindings parser, browser-pane registry, styles
│   └── utils/                small shared helpers
│
├── scripts/                  release, daemon test harnesses, dev-name patcher
├── build/                    electron-builder resources (icon, entitlements)
├── public/                   static assets served by Vite
├── docs/decisions/           ADRs (125 entries, source of truth for rationale)
├── .claude/                  skills, agents, and rules (ADR workflow)
├── vite.config.ts            six build targets (see "Build")
├── package.json              `build` field = electron-builder config
└── .cortex.yaml              doc indexing config
```

## Codemap notes

- **IPC handlers are thin**. Each `electron/ipc/*.ts` file registers `ipcMain.handle` channels and delegates to a manager or backend. New IPC surface goes in a matching file or a new one. `electron/ipc/index.ts` is the single registration point called from `app-lifecycle.ts`.
- **The backend abstraction exists for a future remote mode**. `electron/backend/types.ts` defines `PtyBackend`, `GitBackend`, etc. Today only the local implementation exists, so IPC handlers call it directly. New code touching shell, git, or ports should route through the backend, not re-implement.
- **`app-store.ts` is very large (~86 KB)** because it owns the entire pane/tab/panel tree plus closed-pane snapshots. Pane-tree mutations are factored into `pane-tree.ts` / `panel-tree.ts` as pure functions; the store is the mutable adapter.
- **The preload is the public API**. If a renderer needs new capability, add a handler in `electron/ipc/`, then expose it through `preload.ts`, then type it in `src/electron.d.ts`. Renderer code never imports from `electron/`.

## Data flow: two representative paths

### Creating a terminal pane and watching an agent status change

1. User presses `Cmd+T`. Renderer inserts a new pane node into `useAppStore` (via `pane-tree.ts`).
2. `TerminalPane` mounts, opens an xterm instance, calls `window.electronAPI.pty.create(paneId, cwd, cols, rows)`.
3. Preload forwards to main (`pty:create`), which calls `LocalPtyBackend.createOrAttach`, which calls `TerminalHostClient.createOrAttach` over the daemon's control socket.
4. The **daemon** allocates a session, forks a **PTY subprocess** running the user's shell (plus any configured agent command), and streams `data` events back over the stream socket.
5. Main receives stream events and forwards them on per-pane channels (`pty-data-${paneId}`, `pty-agent-status-${paneId}`, `pty-exit-${paneId}`). Renderer subscribes in `useTerminalStream` / `useDebouncedAgentStatus`.
6. When the agent detector flips a session from `idle` → `working`, the daemon emits an `agentStatus` event. Main updates the `TaskManager` (cleaned-up title → task name) and broadcasts to the renderer. `useAppStore` re-renders the tab's agent dot.

### Linking a Linear issue to a workspace

1. User opens Cmd-K, selects "Linear", picks an issue, clicks Link.
2. Renderer calls `window.electronAPI.linear.linkIssueToWorkspace(projectId, wsPath, issue)`.
3. Preload → main (`linear:linkIssueToWorkspace`) → `ProjectManager.linkIssueToWorkspace`.
4. `ProjectManager` mutates the in-memory project, calls `saveState()` which writes `projects.json` in `manorDataDir()`, and returns the updated project.
5. Renderer merges the returned project into `useProjectStore`; React Query caches involving that workspace are invalidated. Sidebar re-renders with the linked issue badge.

## State & persistence

Manor has no database. All persistence is JSON files on disk.

**Platform-aware data dir** (`manorDataDir()`):
- macOS: `~/Library/Application Support/Manor/`
- Other: `~/.local/share/Manor/`

Files under the data dir:
- `projects.json` — projects, workspaces, linked issues, setup scripts, custom commands (`ProjectManager`)
- `tasks.json` — agent tasks across panes (`TaskManager`)
- `preferences.json` — app prefs (`PreferencesManager`)
- `keybindings.json` — custom bindings overrides (`KeybindingsManager`)
- `theme.json` — selected theme (`ThemeManager`)
- `window-bounds.json`, `zoom-level.json` — window state

**Fixed `~/.manor/` dir** (used for resources that must have a stable path for external tools to discover):
- `daemon/terminal-host.sock`, `daemon/terminal-host.token` — daemon connection
- `hook-port` — port of the agent-hook HTTP server
- `webview-server-port` — port of the webview HTTP server (read by MCP)
- `hooks/notify.sh` — generated agent notify shell hook
- `worktrees/<slug>/` — default location when creating a new worktree

**Renderer-local (`localStorage`)**: sidebar width, collapsed project state, transient UI flags from `preferences-store.ts` — anything cheap to lose.

### Filesystem layout

Manor writes to two root directories. The split is intentional and enforced by `electron/paths.ts`, which is the single source of truth for every path the app touches.

**`manorDataDir()`** — `~/Library/Application Support/Manor/` on macOS, `~/.local/share/Manor/` on Linux. Everything here is Electron-main-only state:

| File | Purpose |
|---|---|
| `projects.json` | Project + workspace registry |
| `tasks.json` | Task persistence |
| `preferences.json` | App preferences |
| `keybindings.json` | User keybinding overrides |
| `window-bounds.json` | Window position/size |
| `zoom-level.json` | Renderer zoom factor |
| `linear-token.enc` | Encrypted Linear API key |
| `sessions/` | Zsh history files (one per pane) |
| `zdotdir/` | Zsh dotfiles shim for history tracking |

**`manorHomeDir()`** — `~/.manor/`. A stable, well-known path for anything an *external* process needs to find:

| Path | Consumer |
|---|---|
| `daemon/terminal-host.{sock,pid,token}` | Detached daemon process |
| `hook-port`, `hooks/notify.sh` | Shell-level agent hooks (Claude Code, etc.) |
| `webview-server-port` | Standalone MCP webview server |
| `portless-proxy-port` | External tools discovering the portless proxy |
| `sessions/` | Daemon's terminal scrollback (distinct from data-dir `sessions/`) |
| `layout.json` | Daemon's layout persistence |
| `worktrees/` | Default base for `git worktree` — user-facing, visible in IDEs |

**Rule for adding a new path:** if a file is read only by Electron main, put it under `manorDataDir()`. If anything outside Electron main needs to find it (another process, a shell script, git, the user's file manager), put it under `manorHomeDir()`.

**Naming collision worth knowing:** both roots have a `sessions/` directory. They hold different things — zsh history (data-dir) vs terminal scrollback (home-dir) — and serve different readers. Renaming is scoped out; noted here for anyone chasing a path through the code.

## Build & packaging

**Vite** (`vite.config.ts`) runs the renderer plus five Electron-side builds via `vite-plugin-electron`:

| Target | Entry | Output | Externals |
|---|---|---|---|
| Renderer | `src/main.tsx` (via `index.html`) | `dist/` | — |
| Main | `electron/main.ts` | `dist-electron/main.js` | node-pty, tree-kill |
| Preload | `electron/preload.ts` | `dist-electron/preload.js` | — |
| Daemon | `electron/terminal-host/index.ts` | `dist-electron/terminal-host-index.js` | node-pty, tree-kill, @xterm/headless, @xterm/addon-serialize |
| PTY subprocess | `electron/terminal-host/pty-subprocess.ts` | `dist-electron/pty-subprocess.js` | node-pty, tree-kill |
| MCP webview server | `electron/mcp-webview-server.ts` | `dist-electron/mcp-webview-server.js` | @modelcontextprotocol/sdk |

All Electron-side outputs are CommonJS. Native modules stay external and are rebuilt for Electron via the `postinstall: electron-rebuild` step.

**electron-builder** config lives inline in `package.json` under `build`. macOS targets only (`dmg`, `zip`), hardened runtime + notarization, entitlements in `build/entitlements.mac.plist`. `dist-electron/mcp-webview-server.js` is `asarUnpack`ed so it can be spawned as a child process. `pnpm release` (see `scripts/release.mjs`) drives signing, notarization, and GitHub Release upload consumed by `electron-updater`.

## External integrations

- **GitHub** — Uses the `gh` CLI as a subprocess. Auth is whatever `gh` is logged into; Manor never touches tokens directly.
- **Linear** — Direct GraphQL API with a user-supplied API key stored in the data dir.
- **Ghostty themes** — Reads the user's Ghostty config to mirror terminal colors (no runtime dependency).
- **portless** (`portless` npm package) — Provides the named preview hostnames (e.g. `myapp.localhost`).
- **MCP (Model Context Protocol)** — `@modelcontextprotocol/sdk` powers the standalone webview MCP server, installed into connected agents (Claude Code, Codex, etc.) via `agent-connectors.ts` writing to each agent's config file.
- **Agent shell hooks** — `agent-hooks.ts` runs a localhost HTTP server; a generated shell script (`~/.manor/hooks/notify.sh`) is invoked by Claude Code to report status transitions.

## Cross-cutting concerns

### Security boundaries
- Renderer has `contextIsolation: true` and talks to main only through the allowlist in `preload.ts`. No `nodeIntegration`.
- External URL opening is restricted to an explicit protocol list (`https:`, `http:`, `mailto:`, `x-apple.systempreferences:`). See `electron/ipc/misc.ts`.
- The terminal-host daemon authenticates clients with a token stored at `~/.manor/daemon/terminal-host.token`.
- The webview and MCP HTTP servers bind to localhost only.

### Agent detection invariants
- **Agent status is derived, never set**. Renderer and task system read agent state from the daemon, which reads it from the PTY. There is no "set status" path. New states must come from detection, not UI.
- The daemon, not main, is the source of truth for session liveness. Stale task reconciliation (`tasks:reconcileStale`) exists to rebuild renderer view after a daemon-only restart.

### Testing
- **Vitest** (`vitest.config.ts`). Co-located `*.test.ts` in `electron/` and `src/store/__tests__/`. Daemon integration and e2e tests live in `electron/terminal-host/` and are heavier.
- Helper harnesses under `scripts/` (`test-daemon-e2e.mjs`, `test-full-lifecycle.mjs`) exercise full daemon/session flows outside the test runner.
- There is no end-to-end UI test framework (no Playwright/WDIO). UI correctness is manual.

### Decision records
All non-trivial changes flow through the ADR workflow (see `.claude/rules/adr-workflow.md` and `.claude/skills/adr-workflow/`). Rationale and historical context live in `docs/decisions/adr-<NNN>-<slug>/` — prefer reading the ADR over inferring intent from diffs.

## Architectural invariants

Invariants are stated as absences — what the codebase deliberately does *not* do.

- **The main process does not own PTYs.** All PTY state lives in the daemon so it can outlive the app window. Anything that looks like "spawn a PTY from main" is wrong.
- **The daemon is not killed on app quit.** It is the persistence layer for sessions. Only explicit user action (`pnpm kill`, settings UI) kills it.
- **The renderer does no filesystem, git, or network I/O directly.** All side effects go through `window.electronAPI`. No `fs`, no `fetch` to external services from React code.
- **IPC handler files are thin.** They validate, forward to a manager, and return. Business logic lives in managers under `electron/`.
- **There is no database.** Adding one is a cross-cutting change that touches every manager; prefer extending the JSON files unless an ADR argues otherwise.
- **Agent state is derived, not set.** Nothing outside the daemon tells a session what its status is.
- **Projects vs workspaces**: projects are directories, workspaces are git worktrees. A workspace's path can exist independently of the project (a worktree can be anywhere on disk); the project is the logical parent, not the filesystem parent.

## Where to look next

- A new feature that shows data in the UI: start in `src/components/`, add store state in `src/store/`, route through `window.electronAPI` → `electron/ipc/*`.
- A new external integration: add a manager under `electron/`, expose via a new `electron/ipc/*.ts` file, register in `electron/ipc/index.ts`.
- A new terminal capability: decide whether it belongs in `electron/terminal-host/` (daemon-side, affects all sessions) or in the renderer xterm wrapper (`src/terminal/`, `src/components/workspace-panes/TerminalPane.tsx`).
- A behavior you don't understand: grep `docs/decisions/` first.

## Known issues & inconsistencies

See [`ARCHITECTURE-ISSUES.md`](./ARCHITECTURE-ISSUES.md) for the audit log.
