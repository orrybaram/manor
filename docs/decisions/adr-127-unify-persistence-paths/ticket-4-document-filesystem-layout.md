---
title: Document the filesystem layout in ARCHITECTURE.md
status: done
priority: medium
assignee: haiku
blocked_by: [3]
---

# Document filesystem layout

Add a "Filesystem layout" section to `docs/ARCHITECTURE.md` that closes the audit loop: the next reader shouldn't have to re-derive why `~/Library/Application Support/Manor` and `~/.manor` both exist.

Blocked by ticket 3 so the final paths (post-refactor) match what's documented.

## What to add

A new section in `docs/ARCHITECTURE.md`, placed near the existing discussion of persistence (grep the file for "persistence" or "data dir" to find the right neighbor section). Use this content as the basis — adapt tone/voice to match surrounding sections:

---

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

---

## Files to touch
- `docs/ARCHITECTURE.md` — add the section above

## Also update

At the bottom of `docs/ARCHITECTURE-ISSUES.md`, mark issues #4 and #5 as `✅ Resolved — ADR-127` and update the summary table. Do not delete the issue bodies; leave them as historical context with the resolution note.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-127): Document the filesystem layout in ARCHITECTURE.md"

Do not push.
