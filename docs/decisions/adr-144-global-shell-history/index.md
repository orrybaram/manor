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

# ADR-144: Normalize on the global shell history (in and out of Manor)

## Context

ADR-143 made every Manor zsh pane share **one history file** so `ctrl+r` recall
survives closing a window or switching projects. It fixed cross-pane sharing,
but it did so against a **Manor-owned, isolated** file
(`<dataDir>/shell-history`) — the generated `.zshrc` sources the user's real
`.zshrc` and then *overrides* `HISTFILE` to point at that Manor file.

ADR-143 listed that isolation as a benefit — *"Manor history stays isolated from
the user's system `~/.zsh_history`, as before."* — but that property was
**inherited from the original `ZDOTDIR` shim, not freshly argued**. ADR-143's
real decision was narrow (per-pane → one shared file); the Manor-vs-global wall
was treated as settled background.

In practice the wall is the problem the user actually hit. The Manor file is
created empty and never reconnects to the user's real history:

- Real `~/.zsh_history`: ~15,700 lines — everything typed in the launching
  ghostty terminal (`terraform-docs markdown table …`, etc.).
- Manor `<dataDir>/shell-history`: a handful of lines — only commands typed
  inside Manor since ADR-143 shipped.

So `ctrl+r` in any Manor pane searches the handful, never the 15k. Opening a new
terminal or exiting a Claude tab back to a shell shows none of the user's real
history. The isolation buys nothing the user wants and costs them their whole
back-history plus any drift between Manor and the terminal they launched it from.

This affects **zsh only** — the same scope as ADR-143. bash/fish ignore the
`ZDOTDIR` shim and already use their native, globally-shared history files
(`~/.bash_history`, `fish_history`), so they were never isolated in the first
place.

There is precedent in the app for global-by-default: ADR-061 made browser
history *"global, shared across all browser tabs automatically,"* and ADR-143
itself cited that approvingly as the direction Manor leans.

## Decision

Keep ADR-143's **cross-pane live sharing** (`SHARE_HISTORY`), but stop
redirecting `HISTFILE` to a Manor-owned file. Honor the user's **real, global
zsh history** so recall flows freely in and out of Manor.

In `electron/shell.ts`, the generated `.zshrc` Manor block changes from
*override* to *honor-with-fallback*:

- **Detect the real `HISTFILE` by not clobbering it.** The shim already sources
  the user's real `.zshrc` first; after that, `$HISTFILE` holds whatever their
  setup resolved (oh-my-zsh and most configs set `~/.zsh_history`). We stop
  overwriting it. This is the most robust "detection" — it uses the value the
  user's own shell produced, which Node cannot reliably know without spawning a
  shell.
- **Fall back only if unset.** `: "${HISTFILE:=${REAL_ZDOTDIR:-$HOME}/.zsh_history}"`
  sets `~/.zsh_history` *only* when the sourced `.zshrc` left `HISTFILE` empty
  (zsh has no default save file, so without this history would not persist).
- **Keep the floor and the sharing.** `(( HISTSIZE < 100000 )) && HISTSIZE=100000`
  (same for `SAVEHIST`) and `setopt SHARE_HISTORY` are retained verbatim.
  `SHARE_HISTORY` now syncs every pane **and** the launching terminal live,
  because they all point at the same real file.
- **Keep OSC 7 CWD reporting** (the `__manor_osc7_precmd` block) unchanged.

Remove the now-dead plumbing, consistent with ADR-143's own cleanup of dead
per-pane paths:

- `ShellManager.sharedHistoryFile()` and the `shellHistoryFile()` getter in
  `paths.ts` — their only runtime caller was the `HISTFILE` override we are
  deleting.
- The `singleQuote` helper / `histfile` embedding in `shell.ts` if no longer
  needed.
- The dead `sharedHistoryFile` stub in the terminal-host `ShellManager` mocks
  and the `shellHistoryFile` cases in `paths.test.ts`.
- Update `electron/__tests__/shell.test.ts` to assert the new block (no
  Manor-path `HISTFILE=`; presence of the `:=` fallback, the floors, and
  `SHARE_HISTORY`).

This **supersedes only the isolation property** of ADR-143
(*"Manor history stays isolated …"*). ADR-143's core decision — one shared
history with `SHARE_HISTORY` rather than per-pane files — remains in force and
is extended, not reverted. ADR-143 stays `accepted`.

### Alternatives considered

- **Seed/fork the Manor file once from real history.** On first launch, copy
  `~/.zsh_history` into the Manor file, then keep them separate. Backfills the
  15k lines once but **drifts immediately**: commands typed later in ghostty
  never reach Manor and vice versa, leaving a permanently partial picture.
  Rejected in favor of a single global source of truth that never drifts.
- **Node-side `HISTFILE` detection.** Have the main process read/guess the real
  path and inject it. Rejected: Node can't know what the user's `.zshrc`
  resolves `HISTFILE` to without spawning a shell; honoring the live value in
  the already-sourced shim is simpler and correct by construction.

### Future option (not in scope)

Extend explicit global sharing to **baseline shells** (bash/fish). They are
already global natively, so no shim is needed today; if Manor later wants to
enforce a specific shared file or `HISTSIZE` floor for them, that is a separate
follow-on.

## Consequences

**Better:**
- `ctrl+r` in any Manor pane recalls the user's entire real history immediately
  — no backfill, no migration.
- History is one continuous stream in and out of Manor: commands from the
  launching ghostty terminal appear in Manor panes and vice versa, live, via
  `SHARE_HISTORY`. No drift, ever.
- Less code: the Manor-owned history path and its getters are deleted.

**Worse / risks:**
- **Manor/agent commands now land in the user's real `~/.zsh_history`** — e.g.
  `claude --dangerously-skip-permissions`. This is the explicit trade for
  unified recall; it is the intended behavior, not a side effect.
- The old `<dataDir>/shell-history` file is orphaned (left on disk, no longer
  read), exactly as ADR-143 orphaned the per-pane files. No migration.
- Up-arrow remains globally interleaved by timestamp (unchanged from ADR-143,
  now spanning the launching terminal too).
- More writers on one real file (panes + launching terminal); zsh's history
  locking is designed for this and `SHARE_HISTORY` is the supported mechanism.
- zsh only; bash/fish unchanged (already global).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
