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

# ADR-145: Harden the ZDOTDIR shim (global history that actually reaches `~/.zsh_history`)

## Context

ADR-143 introduced a `ZDOTDIR` shim: Manor points `ZDOTDIR` at a private dir
(`<dataDir>/zdotdir`) holding generated `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`
that each source the user's real dotfile, then inject Manor's additions (OSC 7
CWD reporting, shared history). This is the standard non-invasive
shell-integration trick — it adds behavior without editing the user's dotfiles.

ADR-144 then changed the history block from *override* to *honor-with-fallback*:
`: "${HISTFILE:=${REAL_ZDOTDIR:-$HOME}/.zsh_history}"` — the intent being to
write to the user's **real, global** `~/.zsh_history` so `ctrl+r` flows in and
out of Manor.

**ADR-144's fix does not work on macOS.** Investigation (v0.5.12) found Manor
panes still writing history to `<dataDir>/zdotdir/.zsh_history` — a Manor-private
file with today's commands (`claude --dangerously-skip-permissions`, `npm run
dev`, `git co development; git-up; git-purge`) — while the real `~/.zsh_history`
(15,700+ lines) only ever sees the launching terminal. The isolation ADR-144
meant to kill simply relocated from `<dataDir>/shell-history` to
`<dataDir>/zdotdir/.zsh_history`.

### Root cause: `/etc/zshrc` pins `HISTFILE` to `$ZDOTDIR` before our `.zshrc` runs

macOS ships `/etc/zshrc` with an **unconditional** assignment (line 16):

```zsh
HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
```

zsh's interactive-login startup order is:

| Step | File | Effect |
|------|------|--------|
| 2 | `$ZDOTDIR/.zshenv` → real `.zshenv` | (custom HISTFILE here is later clobbered) |
| 4 | `$ZDOTDIR/.zprofile` → real `.zprofile` | (clobbered too) |
| 5 | **`/etc/zshrc`** | `HISTFILE = $ZDOTDIR/.zsh_history` — and our ZDOTDIR override points it at the Manor dir |
| 6 | `$ZDOTDIR/.zshrc` → real `.zshrc` (oh-my-zsh), then Manor's history block | |

By step 6, `HISTFILE` is already set to the Manor dir. oh-my-zsh's
`[ -z "$HISTFILE" ] && HISTFILE="$HOME/.zsh_history"` is conditional → no-op.
Manor's `: "${HISTFILE:=…}"` is also conditional → no-op. So Manor honors a value
that `/etc/zshrc` poisoned via our own `ZDOTDIR` override. ADR-144 reasoned about
only two `HISTFILE` states ("user set it" / "unset → fallback") and missed the
third, which is the **default on macOS**: set by the system to `$ZDOTDIR/...`.

Reproduced directly: even with `REAL_ZDOTDIR=$HOME` and oh-my-zsh loading
correctly, `HISTFILE` resolves to `<Manor zdotdir>/.zsh_history`.

### Second root cause: `REAL_ZDOTDIR` poisoning under nested launch

Both spawn sites compute `REAL_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME`
(`electron/pty.ts:30`, `electron/terminal-host/session.ts:234`). The `:-$HOME`
fallback in the generated scripts guards against `ZDOTDIR` being *unset* — but
not against it being set to **Manor's own dir**. When the Manor app process
itself inherits `ZDOTDIR=<Manor zdotdir>` (e.g. `npm run dev` launched from a
Manor pane — the standard dev workflow), `REAL_ZDOTDIR` resolves to the Manor
dir. Then the generated `.zshrc` sources `${REAL_ZDOTDIR}/.zshrc` = **its own
file**, so oh-my-zsh / theme / aliases / functions never load at all in those
panes, and the HISTFILE fallback writes into the Manor dir. This is a broader
breakage than history alone.

### General principle

Every `${ZDOTDIR:-$HOME}/X` reference anywhere in the startup chain — system,
framework, or user — silently retargets from `$HOME` to Manor's private dir.
`HISTFILE` is the first casualty; `.zcompdump` is another (Manor keeps a separate
completion dump). We fix the two that affect correctness and accept the rest.

## Decision

Three targeted changes; do **not** globally reset `ZDOTDIR` (that would break OSC
7 CWD tracking in nested `exec zsh` subshells, which rely on the Manor ZDOTDIR
persisting).

### 1. Redirect `HISTFILE` when it points inside `$ZDOTDIR` (`electron/shell.ts`)

Replace the honor-only `:=` fallback with a guard that distinguishes the three
states by the time Manor's block runs (after sourcing the real `.zshrc`):

```zsh
# /etc/zshrc on macOS sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history before this
# block runs, and our ZDOTDIR override poisons it to Manor's private dir. Reclaim
# the global file when HISTFILE is empty or lives inside our ZDOTDIR; honor any
# genuinely custom path the user set in their real .zshrc (it won't be under our
# dir — they don't know it exists).
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"/* ]]; then
  HISTFILE="${REAL_ZDOTDIR:-$HOME}/.zsh_history"
fi
```

- **`$ZDOTDIR/.zsh_history`** (the macOS default, poisoned by us) → redirect to
  the real global file.
- **Custom absolute path** set in the user's `.zshrc` (the only user file that
  survives `/etc/zshrc`, since it runs at step 6) → honored; it can't collide
  with the `$ZDOTDIR/*` test because users never point `HISTFILE` inside Manor's
  app-support dir.
- **Empty** → fallback (unchanged from ADR-144's intent).

`HISTSIZE`/`SAVEHIST` floors and `setopt SHARE_HISTORY` are retained verbatim.

### 2. Sanitize `REAL_ZDOTDIR` against nested launches (Node side)

Add `ShellManager.realZdotdir()` in `electron/shell.ts` (Electron-free, importable
by both the main process and the daemon):

```ts
static realZdotdir(): string {
  const inherited = process.env.ZDOTDIR;
  // If the app inherited OUR own zdotdir (e.g. Manor launched from a Manor pane),
  // it is not a real user ZDOTDIR — fall back to HOME so the generated scripts
  // source the user's real dotfiles instead of recursively sourcing themselves.
  if (inherited && inherited !== this.zdotdirPath()) return inherited;
  return process.env.HOME ?? "";
}
```

Use it at both spawn sites in place of `process.env.ZDOTDIR || process.env.HOME`:
`electron/pty.ts:30` and `electron/terminal-host/session.ts:234`.

### 3. Source the user's `~/.zlogout` (`electron/shell.ts`)

Manor generates `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin` but **no `.zlogout`**, so
zsh never runs the user's real `~/.zlogout` cleanup on pane exit. Add a generated
`.zlogout` matching the others:

```zsh
[[ -f "${REAL_ZDOTDIR:-$HOME}/.zlogout" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zlogout"
```

### Not in scope (accepted as-is)

- **`.zcompdump` duplication.** zsh's `compinit` writes
  `${ZDOTDIR:-$HOME}/.zcompdump-*`, so Manor keeps a separate completion dump.
  This is a regenerable cache; the only cost is one rebuild per zsh-version bump.
  Sharing it reliably would require reconstructing oh-my-zsh's host/version dump
  filename in our pre-source snippet — fragile, for no correctness gain. Left
  alone deliberately.
- **Globally resetting `ZDOTDIR`** to the real dir after Manor's block. Rejected:
  it would strip Manor's OSC 7 integration from nested interactive shells
  (`exec zsh`, subshells) that re-resolve `$ZDOTDIR`.

## Consequences

**Better:**
- `ctrl+r` and up-arrow in any Manor pane recall the user's entire real
  `~/.zsh_history` — and Manor commands flow back out to the launching terminal,
  live via `SHARE_HISTORY`. This is what ADR-144 promised and macOS silently
  defeated.
- Panes spawned by a Manor instance that was itself launched from a Manor pane
  (the `npm run dev` workflow) now load oh-my-zsh, the user's theme, aliases, and
  functions instead of recursively sourcing Manor's own stub `.zshrc`.
- `~/.zlogout` cleanup hooks run on pane exit.

**Worse / risks:**
- Manor/agent commands continue to land in the real `~/.zsh_history` (e.g.
  `claude --dangerously-skip-permissions`) — the explicit, intended trade from
  ADR-144, now actually realized.
- The `$ZDOTDIR/*` guard assumes a user's genuinely-custom `HISTFILE` never lives
  inside Manor's app-support dir. Safe by construction (that path is Manor's
  invention) but stated here.
- `.zcompdump` duplication persists (accepted above).
- Pre-existing stray files (`<dataDir>/zdotdir/.zsh_history`,
  `<dataDir>/shell-history`) are orphaned, consistent with ADR-143/144's
  no-migration stance. The lost commands are acceptable to the user.

This **supersedes the mechanism of ADR-144** (honor-only `HISTFILE`) while
preserving its decision (one shared, global history with `SHARE_HISTORY`).
ADR-144 stays `accepted`; this extends it. zsh only; bash/fish are unaffected
(already global, no shim).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
