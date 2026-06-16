---
title: Redirect poisoned HISTFILE and source .zlogout in generated scripts
status: in-progress
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Redirect poisoned HISTFILE and source .zlogout in generated scripts

macOS `/etc/zshrc` sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` unconditionally,
*before* Manor's `.zshrc` block runs. Because Manor overrides `ZDOTDIR` to its own
dir, `HISTFILE` is poisoned to `<Manor zdotdir>/.zsh_history` and ADR-144's
honor-only `:=` fallback is a no-op. Replace it with a guard that redirects when
`HISTFILE` is empty OR lives inside `$ZDOTDIR`, while honoring a genuinely custom
user path. Also generate a `.zlogout` so the user's real `~/.zlogout` runs.

## Implementation

In `electron/shell.ts`, inside `setupZdotdir()`:

1. In the generated `.zshrc` body, replace the current line:

   ```zsh
   : "${HISTFILE:=${REAL_ZDOTDIR:-$HOME}/.zsh_history}"
   ```

   with:

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

   Keep this block in its current position — AFTER the `source` of the user's real
   `.zshrc` and BEFORE the `HISTSIZE`/`SAVEHIST` floors and `setopt SHARE_HISTORY`
   (all retained verbatim). Mind the existing TS template-literal escaping in this
   file: `${...}` that must reach the shell verbatim is written `\${...}` in the
   source, and `$ZDOTDIR` / `$HISTFILE` are fine as-is. Match the escaping style
   already used for the neighboring `${HISTFILE:=${REAL_ZDOTDIR:-$HOME}/...}` and
   `${HOST}`/`${PWD}` lines.

2. Add a `.zlogout` entry to the `files` array (same source-the-real-one pattern
   as `.zshenv`/`.zprofile`/`.zlogin`):

   ```ts
   [
     ".zlogout",
     `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zlogout" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zlogout"\n`,
   ],
   ```

## Tests — `electron/__tests__/shell.test.ts`

Update the "shared history" describe block:
- Replace the `: "${HISTFILE:=` assertion (currently in the
  "provides a :=-fallback" test) with assertions for the new guard:
  - contains `if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"/* ]]; then`
  - contains `HISTFILE="${REAL_ZDOTDIR:-$HOME}/.zsh_history"`
- Keep and keep-passing: no Manor `shell-history` path; no `MANOR_HISTFILE`;
  `setopt SHARE_HISTORY` present; `HISTSIZE`/`SAVEHIST` floors present.
- Update the ordering test ("places the HISTFILE fallback after sourcing …") to
  assert `zshrc.indexOf("source") < zshrc.indexOf("HISTFILE=")` (the new redirect
  uses `HISTFILE=` assignment, not `HISTFILE:=`).
- Add a test asserting a `.zlogout` file is generated and sources
  `${REAL_ZDOTDIR:-$HOME}/.zlogout` (read it from the temp `zdotdir`, mirroring
  how `generatedZshrc()` reads `.zshrc`).

## Files to touch
- `electron/shell.ts` — HISTFILE redirect guard + `.zlogout` generation in `setupZdotdir()`.
- `electron/__tests__/shell.test.ts` — update history assertions, add `.zlogout` test.
