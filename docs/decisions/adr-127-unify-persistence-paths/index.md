---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-127: Centralize persistence paths and document the `~/.manor` vs data-dir split

## Context

Two high-priority issues in `docs/ARCHITECTURE-ISSUES.md` (#4 and #5) track the same underlying mess: Manor's filesystem layout has no single source of truth.

**#4 — `manorDataDir()` duplicated across 7 files.** Each of the following defines an identical copy of the helper that resolves the platform-aware data directory:

- `electron/persistence.ts:30` (private)
- `electron/task-persistence.ts:6` (private)
- `electron/preferences.ts:5` (private)
- `electron/keybindings.ts:5` (private)
- `electron/window.ts:14` (exported, but nothing imports it)
- `electron/linear.ts:52` (private)
- `electron/shell.ts:5` (private)

Any change (new platform, reorganization, debugging override) has to be made in 7 places.

**#5 — Two persistence roots with no documented contract.** Manor writes to two root directories:

| Path | Used for | Readers |
|---|---|---|
| `manorDataDir()` (`~/Library/Application Support/Manor/` on macOS) | projects, tasks, prefs, keybindings, theme, window state, linear token, shell history/zdotdir | Electron main only |
| `~/.manor/` (hardcoded) | daemon socket/pid/token, hook port, hook script, webview-server port, portless-proxy port, scrollback sessions, layout, worktrees | daemon, agent hooks (shell scripts), MCP webview server (standalone node), git (worktrees) |

The `~/.manor/` files need a stable well-known path because they're read by processes that aren't Electron main — shell hook scripts, a detached daemon, an out-of-process MCP server, and `git worktree`. That's a defensible reason, but it's documented nowhere, so a reader trying to understand why `window-bounds.json` lives in one place and `layout.json` lives in another has to reverse-engineer the rule from usage sites.

Audit of the current `~/.manor/` usages confirms each file has an external reader:

- `~/.manor/daemon/{sock,pid,token}` — daemon is a detached child process
- `~/.manor/hook-port` + `~/.manor/hooks/notify.sh` — invoked by Claude Code's hook system via shell
- `~/.manor/webview-server-port` — read by the standalone MCP webview server (spawned by Claude Code, not Manor)
- `~/.manor/portless-proxy-port` — documented in ADR-054 as consumed by external tools
- `~/.manor/sessions/` — daemon's scrollback persistence (note: distinct from `manorDataDir()/sessions`, which is zsh history — confusing but intentional)
- `~/.manor/layout.json` — daemon's layout persistence
- `~/.manor/worktrees/` — default base for git worktrees; user-facing path, visible in shell and IDEs

Everything in `~/.manor/` has a legitimate external-boundary reason to be there. The audit found no files that are "accidentally" outside `manorDataDir()` — the issue is purely that the split isn't documented and the data-dir helper is duplicated.

## Decision

Introduce a single `electron/paths.ts` module that owns all filesystem-path knowledge for the Electron side. It exports:

1. **Root resolvers**
   - `manorDataDir(): string` — platform-aware data dir (replaces the 7 duplicates)
   - `manorHomeDir(): string` — `~/.manor` (the external-boundary root)

2. **Named file/directory getters grouped by root.** Each getter is a named export so call sites read like `persistenceFile()` instead of `path.join(manorDataDir(), "projects.json")`. Getters cover every currently-hardcoded path:
   - Data dir: `projectsFile()`, `tasksFile()`, `preferencesFile()`, `keybindingsFile()`, `windowBoundsFile()`, `zoomLevelFile()`, `linearTokenFile()`, `shellSessionsDir()`, `shellZdotdir()`
   - Home dir: `daemonDir()`, `daemonSocketFile()`, `daemonPidFile()`, `daemonTokenFile()`, `hookPortFile()`, `hookScriptPath()`, `hooksDir()`, `webviewServerPortFile()`, `portlessProxyPortFile()`, `scrollbackSessionsDir()`, `layoutFile()`, `worktreesDir()`

3. **A short module-level doc comment** stating the rule: *anything in `manorHomeDir()` must have an external reader (daemon, shell hook, MCP server, git); anything else goes in `manorDataDir()`*.

Three migrations follow:

- **Delete the 7 duplicate `manorDataDir()` definitions.** Replace with imports from `paths.ts`.
- **Replace every hardcoded `~/.manor` path** (12+ call sites across `agent-hooks.ts`, `webview-server.ts`, `portless.ts`, `mcp-webview-server.ts`, `terminal-host/*`, `ipc/processes.ts`, `persistence.ts` worktrees base) with the corresponding named getter.
- **Add a "Filesystem layout" section to `docs/ARCHITECTURE.md`** that tables out both roots, names each file, and states the rule for deciding which root to use. Cross-link from `paths.ts`.

Two paths that look wrong but stay put:
- `~/.manor/worktrees/` — user-facing, referenced by `git worktree`, visible in IDEs. Moving it is a breaking change.
- `manorDataDir()/sessions` (zsh history) vs `~/.manor/sessions` (scrollback) — confusingly named, different purposes, different readers. Renaming is scoped out; documented instead.

The MCP webview server (`mcp-webview-server.ts`) is a standalone process spawned by Claude Code. It can still import from `paths.ts` because the build emits a flat output and the module has no Electron dependencies — this constraint is noted in the module doc so future additions don't accidentally import `electron`.

## Consequences

**Better:**
- One place to change platform mapping, override for tests, or debug.
- Every path has a name; call sites read as intent ("the hook port file") rather than string concatenation.
- The `manorHomeDir()` vs `manorDataDir()` rule is enforceable by reading `paths.ts` — if you need a new path, you pick a root and the comment tells you which.
- Documentation closes the audit loop: the next reader doesn't have to re-derive the split.

**Worse / risks:**
- `paths.ts` must stay Electron-free so the daemon and MCP server can import it. A future contributor adding an `app.getPath()` call from Electron would silently break the daemon. Mitigated by a doc comment and the existing build surfacing the error at daemon startup.
- Adds an import to files that currently have no cross-file dependency for paths. Low cost; the imports are one line each.
- No behavior change — if the migration accidentally changes a path string, user data appears to "disappear." Mitigation: migration tickets include a grep-based sanity check that every string literal replaced resolves to the same absolute path as before.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
