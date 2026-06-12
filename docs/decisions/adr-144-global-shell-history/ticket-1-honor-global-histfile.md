---
title: Honor the global HISTFILE instead of overriding to the Manor file
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Honor the global HISTFILE instead of overriding to the Manor file

Stop redirecting Manor zsh panes at the isolated `<dataDir>/shell-history` file.
Honor whatever `HISTFILE` the user's sourced `.zshrc` resolved (their real,
global history), falling back to `~/.zsh_history` only if unset. Keep
`SHARE_HISTORY` and the `HISTSIZE`/`SAVEHIST` floor so live cross-pane sharing
(now spanning the launching terminal too) is preserved. Then delete the now-dead
Manor-history plumbing.

See `docs/decisions/adr-144-global-shell-history/index.md` for full rationale.

## Required behavior

The generated `.zshrc` Manor block must:
- **Not** set `HISTFILE` to any Manor-owned path. No `HISTFILE='…/shell-history'`.
- Provide a fallback default only when unset, using a zsh assignment-default:
  `: "${HISTFILE:=${REAL_ZDOTDIR:-$HOME}/.zsh_history}"` — placed AFTER the line
  that sources the user's real `.zshrc`, so their value wins and we only fill a
  gap.
- Keep verbatim: `(( HISTSIZE < 100000 )) && HISTSIZE=100000`,
  `(( SAVEHIST < 100000 )) && SAVEHIST=100000`, and `setopt SHARE_HISTORY`.
- Keep the existing `__manor_osc7_precmd` OSC 7 block unchanged.

## Files to touch

- `electron/shell.ts` — Replace the `HISTFILE=${histfile}` override with the
  `:=` fallback above. Remove the `histfile`/`sharedHistoryFile()` machinery and
  the `shellHistoryFile` import; drop the `singleQuote` helper if it has no other
  user. Update the surrounding comments to describe global/shared-in-and-out
  behavior (replace the "One history file shared by every Manor pane" framing).
- `electron/paths.ts` — Remove the now-unused `shellHistoryFile()` export and its
  comment. Leave `shellZdotdir()` and everything else intact.
- `electron/__tests__/shell.test.ts` — Rewrite assertions: remove the
  `HISTFILE='${historyFile}'` expectation and the `shellHistoryFile` mock; assert
  the generated `.zshrc` (a) does NOT contain a Manor `shell-history` path in
  `HISTFILE`, (b) contains the `: "${HISTFILE:=` fallback, (c) still contains
  `setopt SHARE_HISTORY` and both floor lines, and (d) still places `source`
  before the history block. Keep the temp-dir `shellZdotdir` mock.
- `electron/__tests__/paths.test.ts` — Remove the `shellHistoryFile` test cases
  (the two `it("shellHistoryFile", …)` blocks and the reference in the
  smoke/coverage list around the bottom of the file).
- `electron/terminal-host/{session,terminal-host,client,e2e,daemon.integration}.test.ts`
  — Remove the dead `sharedHistoryFile: () => …` line from each `ShellManager`
  mock object (5 files). These are dead stubs; the method no longer exists.

## Verification

- `pnpm typecheck` and the build pass.
- The shell/paths/terminal-host test suites pass with the updated expectations.
