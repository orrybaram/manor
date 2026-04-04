<p align="center">
  <!-- Replace with actual app icon -->
  <img src=".github/assets/icon.png" alt="Manor" width="128" height="128" />
</p>

<h1 align="center">Manor</h1>

<p align="center">
  <strong>A terminal built for how developers actually work.</strong><br />
  Projects. Panes. Git. Integrations. All in one place.
</p>

<p align="center">
  <span><img src="https://img.shields.io/github/package-json/v/orrybaram/manor
" alt="Version" /></span>
  
</p>

<br />

<!-- Replace with actual GIF/screenshot of the app -->
<p align="center">
  <img src=".github/assets/hero.gif" alt="Manor — terminal walkthrough" width="800" />
</p>

<br />

---

## Why Manor?

Most terminals stop at tabs and themes. Manor goes further — it understands your **projects**, watches your **branches**, surfaces your **PRs and issues**, and shows you when **AI agents** are running. It's a terminal that knows what you're working on.

<br />

## Highlights

<table>
<tr>
<td width="50%">

### Projects & Workspaces

Organize repos into projects. Manage git worktrees as workspaces. Switch context in a keystroke with `Cmd+K`.

</td>
<td width="50%">

<!-- Replace with actual GIF -->
<img src=".github/assets/demo-projects.gif" alt="Projects and workspaces demo" width="400" />

</td>
</tr>
<tr>
<td width="50%">

<!-- Replace with actual GIF -->
<img src=".github/assets/demo-splits.gif" alt="Pane splitting demo" width="400" />

</td>
<td width="50%">

### Splits & Tabs

Split horizontally or vertically. Navigate panes and tabs with keyboard shortcuts. Layouts persist across restarts.

</td>
</tr>
<tr>
<td width="50%">

### GitHub & Linear

PR status badges appear next to branches. Browse your Linear issues and jump straight into the right project.

</td>
<td width="50%">

<!-- Replace with actual GIF -->
<img src=".github/assets/demo-integrations.gif" alt="Integrations demo" width="400" />

</td>
</tr>
<tr>
<td width="50%">

<!-- Replace with actual GIF -->
<img src=".github/assets/demo-agents.gif" alt="AI agent detection demo" width="400" />

</td>
<td width="50%">

### AI Agent Awareness

See when Claude Code or other agents are active in a terminal — no more wondering which tab is running what.

</td>
</tr>
</table>

<br />

## Features

- **Terminal emulation** — Powered by xterm.js with WebGL rendering, search, image support, and clipboard integration
- **Tabs and pane splitting** — Split horizontally (`Cmd+D`) or vertically (`Cmd+Shift+D`), navigate with keyboard shortcuts
- **Projects and workspaces** — Organize repositories into projects, manage git worktrees as workspaces
- **Session persistence** — Terminal sessions survive app restarts via a background daemon process
- **GitHub integration** — View PR status badges next to branches
- **Linear integration** — Browse assigned issues and match them to projects
- **Built-in browser** — Preview dev servers in a side pane with full navigation, zoom, and an element picker that captures HTML, styles, and accessibility info — point at anything and feed it straight to your AI agent
- **Named previews** — Dev servers automatically get stable URLs like `myapp.localhost` instead of `localhost:3000` — zero config, powered by [portless](https://github.com/vercel-labs/portless)
- **Port scanner** — Detect running services across your workspaces
- **Branch and diff watching** — Track git branch changes and uncommitted line counts
- **AI agent detection** — Visual indicators when Claude Code or other agents are active in a terminal
- **Theming** — Built-in themes with Ghostty config import support
- **Command palette** — Quick access to projects, workspaces, and actions via `Cmd+K`

<br />

---

## Getting Started

### Prerequisites

- **Node.js** (LTS recommended)
- **pnpm** — package manager

Native dependencies (`node-pty`, `electron`) are rebuilt automatically during install.

### From source

```bash
git clone https://github.com/orrybaram/manor.git
cd manor
pnpm install
pnpm dev
```

### Building a distributable

```bash
pnpm package
```

The output will be in the `dist/` directory.

<br />

## Keyboard Shortcuts

All shortcuts are customizable via **Settings > Keybindings**.

### Tabs

| Shortcut          | Action                  |
| ----------------- | ----------------------- |
| `Cmd+T`           | New tab                 |
| `Cmd+Shift+W`     | Close tab               |
| `Cmd+Shift+]`     | Next tab                |
| `Cmd+Shift+[`     | Previous tab            |
| `Cmd+1` – `Cmd+9` | Switch to tab by number |
| `Cmd+Shift+T`     | Reopen closed pane      |

### Panes

| Shortcut      | Action             |
| ------------- | ------------------ |
| `Cmd+D`       | Split horizontally |
| `Cmd+Shift+D` | Split vertically   |
| `Cmd+W`       | Close pane         |
| `Cmd+]`       | Next pane          |
| `Cmd+[`       | Previous pane      |

### Panels

| Shortcut          | Action               |
| ----------------- | -------------------- |
| `Cmd+\`           | Toggle sidebar       |
| `Alt+Cmd+\`       | Split panel right    |
| `Shift+Alt+Cmd+\` | Split panel down     |
| `Alt+Cmd+]`       | Focus next panel     |
| `Alt+Cmd+[`       | Focus previous panel |

### App

| Shortcut      | Action             |
| ------------- | ------------------ |
| `Cmd+K`       | Command palette    |
| `Cmd+,`       | Settings           |
| `Cmd+N`       | New task           |
| `Cmd+Shift+N` | New workspace      |
| `Cmd+Shift+B` | New browser window |
| `Shift+Cmd+.` | Copy branch name   |

### Zoom

| Shortcut | Action     |
| -------- | ---------- |
| `Cmd+0`  | Reset zoom |
| `Cmd+=`  | Zoom in    |
| `Cmd+-`  | Zoom out   |

### Browser Pane

| Shortcut              | Action              |
| --------------------- | ------------------- |
| `Cmd+R`               | Reload page         |
| `Cmd+L`               | Focus URL bar       |
| `Escape` (double-tap) | Return focus to app |

### Diff Pane

| Shortcut    | Action             |
| ----------- | ------------------ |
| `Cmd+F`     | Open search        |
| `Enter`     | Next search result |
| `Escape`    | Close search       |
| `Cmd+Enter` | Submit commit      |

## Inspirations

- [superset](https://github.com/superset-sh/superset)
- [supacode](https://github.com/supabitapp/supacode)
- [react-grab](https://github.com/aidenybai/react-grab)
- [libghostty](https://github.com/ghostty-org/ghostty)
- [xterm](https://github.com/xtermjs/xterm.js)
- [t3code](https://github.com/pingdotgg/t3code)
- [agent-deck](https://github.com/asheshgoplani/agent-deck)
