# Manor

A modern terminal application for macOS, built with Electron, React, and TypeScript.

Manor combines a full-featured terminal emulator with developer-focused tools like GitHub and Linear integration, port scanning, branch tracking, and AI agent awareness — all in a native-feeling desktop app.

## Features

- **Terminal emulation** — Powered by xterm.js with WebGL rendering, search, image support, and clipboard integration
- **Tabs and pane splitting** — Split horizontally (`Cmd+D`) or vertically (`Cmd+Shift+D`), navigate with keyboard shortcuts
- **Projects and workspaces** — Organize repositories into projects, manage git worktrees as workspaces
- **Session persistence** — Terminal sessions survive app restarts via a background daemon process
- **GitHub integration** — View PR status badges next to branches
- **Linear integration** — Browse assigned issues and match them to projects
- **Port scanner** — Detect running services across your workspaces
- **Branch and diff watching** — Track git branch changes and uncommitted line counts
- **AI agent detection** — Visual indicators when Claude Code or other agents are active in a terminal
- **Theming** — Built-in themes with Ghostty config import support
- **Command palette** — Quick access to projects, workspaces, and actions via `Cmd+K`
- **Auto-updates** — Publishes to GitHub Releases with automatic update checks

## Prerequisites

- **Node.js** (LTS recommended)
- **pnpm** — package manager

Native dependencies (`node-pty`, `electron`) are rebuilt automatically during install.

## Installation

### From source

```bash
# Clone the repository
git clone https://github.com/orrybaram/manor.git
cd manor

# Install dependencies
pnpm install

# Start the development server
pnpm dev
```

### Building a distributable

```bash
# Build and package as DMG/ZIP for macOS
pnpm package
```

The output will be in the `dist/` directory.

## Scripts

| Command             | Description                                       |
| ------------------- | ------------------------------------------------- |
| `pnpm dev`          | Start the app in development mode with hot reload |
| `pnpm build`        | Build the renderer (frontend only)                |
| `pnpm package`      | Build and package as a macOS distributable        |
| `pnpm test`         | Run tests                                         |
| `pnpm test:watch`   | Run tests in watch mode                           |
| `pnpm lint`         | Run ESLint                                        |
| `pnpm lint:fix`     | Run ESLint with auto-fix                          |
| `pnpm format`       | Format code with Prettier                         |
| `pnpm format:check` | Check formatting without writing                  |

## Keyboard Shortcuts

| Shortcut                    | Action                           |
| --------------------------- | -------------------------------- |
| `Cmd+T`                     | New tab                          |
| `Cmd+W`                     | Close pane                       |
| `Cmd+Shift+W`               | Close tab                        |
| `Cmd+D`                     | Split pane horizontally          |
| `Cmd+Shift+D`               | Split pane vertically            |
| `Cmd+[` / `Cmd+]`           | Navigate tabs or panes           |
| `Cmd+1–9`                   | Switch to tab by number          |
| `Cmd+K`                     | Command palette                  |
| `Cmd+,`                     | Settings                         |
| `Cmd+\`                     | Toggle sidebar                   |
| `Cmd+0` / `Cmd++` / `Cmd+-` | Reset / increase / decrease zoom |

## Data Directories

- **App data:** `~/Library/Application Support/Manor/`
- **Sessions:** `~/.manor/sessions/`
- **Daemon socket:** `~/.manor/terminal-host.sock`

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Tech Stack

- **Electron 35** — Desktop shell
- **React 19** + **TypeScript** — UI
- **Vite 7** — Build tooling
- **xterm.js 6** — Terminal emulation
- **Zustand** — State management
- **React Query** — Async data fetching
- **node-pty** — Pseudo-terminal management
- **electron-builder** — Packaging and distribution

## Inspirations

- [superset](https://github.com/superset-sh/superset)
- [supacode](https://github.com/supabitapp/supacode)
- [react-grab](https://github.com/aidenybai/react-grab)
- [libghostty](https://github.com/ghostty-org/ghostty)
- [xterm](https://github.com/xtermjs/xterm.js)
- [t3code](https://github.com/pingdotgg/t3code)
- [agent-deck](https://github.com/asheshgoplani/agent-deck)
