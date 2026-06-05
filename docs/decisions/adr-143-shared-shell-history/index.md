---
type: adr
status: accepted
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

# ADR-143: Share one zsh history across all panes

## Context

Manor spawns each terminal pane through a zsh shimmed via `ZDOTDIR`
(`electron/shell.ts`). The generated `.zshrc` sources the user's real `.zshrc`,
then overrides `HISTFILE` to a Manor-owned file so that Manor's history stays
isolated from the user's everyday shell.

That `HISTFILE` was **per pane**: `ShellManager.historyFileFor(paneId)` resolved
to `<dataDir>/sessions/{paneId}.history`, one file per pane. ADR-127 recorded
this layout as intentional (its filesystem table lists *"`manorDataDir()/sessions`
(zsh history) … one per pane"*).

The per-pane design has a sharp downside the user hit in practice: **history is
lost the moment a pane goes away.** Close a window, switch projects, or open a
fresh pane and `ctrl+r` reverse-search starts empty — every quick command typed
in a previous pane lives in a `{paneId}.history` file that no other pane reads.
History was being fragmented across throwaway files keyed by an ephemeral id.

Notably this only ever affected **zsh**. The shim is zsh-only; bash and fish
ignore `ZDOTDIR`/`MANOR_HISTFILE` and fall back to their native, already-shared
history files (`~/.bash_history`, `fish_history`). So the fragmentation was a
problem Manor *introduced* for zsh, not an inherent terminal limitation. There
is precedent in the app for the opposite default: ADR-061 made browser history
*"global, shared across all browser tabs automatically."*

## Decision

Point every pane's zsh `HISTFILE` at a **single shared file** and let zsh keep
the panes in sync live.

- **One file for all panes.** Replace `historyFileFor(paneId)` with
  `ShellManager.sharedHistoryFile()` → `<dataDir>/shell-history` (new
  `shellHistoryFile()` getter in `paths.ts`). Every pane, window, and project
  shares it.
- **The generated `.zshrc` owns `HISTFILE` directly; it is *not* injected per
  session.** `setupZdotdir` embeds the absolute shared path into the `.zshrc`
  (single-quoted — the data dir contains a space). The earlier cut set
  `HISTFILE=$MANOR_HISTFILE` from an env var injected by the terminal daemon,
  which broke in practice: the daemon is a **detached process that survives app
  restarts**, so after this change shipped it kept injecting the *old per-pane*
  path while the main process had already regenerated a new `.zshrc`. The env
  var won, and history stayed per-pane. Because the history path is a constant,
  it never needed per-session injection. Owning it in the `.zshrc` — regenerated
  by the frequently-restarted main process on every launch — makes the feature
  immune to daemon vintage. `MANOR_HISTFILE` is removed from `session.ts` and
  `pty.ts`.
- **`setopt SHARE_HISTORY`.** zsh re-reads the file before each prompt, so a
  command typed in any pane appears live in every other open pane — not just in
  panes opened later. This is the mechanism that makes "all sessions" literal.
- **Floor `HISTSIZE`/`SAVEHIST` at 100000, don't clobber.**
  `(( HISTSIZE < 100000 )) && HISTSIZE=100000` (same for `SAVEHIST`). The user's
  real `.zshrc` is sourced first; we only raise the buffer if it's too small to
  make shared recall useful, and never shrink a power user who set it larger.
- **Minimum config.** The Manor block is exactly: set `HISTFILE`, floor the two
  sizes, `SHARE_HISTORY`. No dedup or whitespace options — those are personal
  preferences that belong in the user's own `.zshrc`, and the destructive
  `HIST_IGNORE_ALL_DUPS` interacts badly with `SHARE_HISTORY`.
- **zsh only.** No bash/fish shims. The bug was zsh-specific; bash/fish already
  have working shared history natively. Documented as a known limitation.
- **No migration; start clean.** Old `<dataDir>/sessions/{paneId}.history` files
  are left where they are (harmless) but no longer read. The shared file refills
  with genuinely-recent commands within a day of use; a one-time merge of stale
  per-pane fragments would add noise, not signal.
- **Remove the now-dead per-pane plumbing.** `shellSessionsDir()`,
  `ShellManager.sessionsDir()`, and the `sessions/` `mkdir` in `setupZdotdir`
  have no remaining reader and are deleted. (This is distinct from
  `~/.manor/sessions`, the scrollback dir, which is untouched.)

This **supersedes ADR-127's** "one [zsh history file] per pane" note.

## Consequences

**Better:**
- `ctrl+r` recalls commands across every pane, window, and project — the history
  survives closing a window or switching projects.
- Concurrent panes stay in sync live: type in one, recall in another immediately.
- Manor history stays isolated from the user's system `~/.zsh_history`, as before.
- One file instead of an unbounded pile of `{paneId}.history` fragments; the
  dead `shellSessionsDir` path is gone.

**Worse / risks:**
- **Up-arrow is no longer per-pane.** `SHARE_HISTORY` interleaves history by
  global timestamp, so up-arrow in a pane may surface a command typed in a
  different pane. This is the accepted trade for live cross-pane recall; users
  who want per-pane up-arrow would need `INC_APPEND_HISTORY` without
  `SHARE_HISTORY` instead.
- **zsh only.** bash/fish users get their native shared history, not the
  isolated Manor file — an intentional inconsistency, not worth shims.
- **Pre-upgrade per-pane history is not carried over.** Accepted; it refills fast.
- Many panes now write one file concurrently; zsh's own history locking handles
  this and `SHARE_HISTORY` is designed for exactly this case.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
