---
title: Sanitize REAL_ZDOTDIR against nested launches
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Sanitize REAL_ZDOTDIR against nested launches

When the Manor app process itself inherits `ZDOTDIR=<Manor zdotdir>` (e.g. `npm
run dev` launched from inside a Manor pane), both PTY spawn sites compute
`REAL_ZDOTDIR = process.env.ZDOTDIR || process.env.HOME` and end up with Manor's
own dir. The generated `.zshrc` then sources `${REAL_ZDOTDIR}/.zshrc` = itself,
so oh-my-zsh / theme / aliases never load and history falls back into the Manor
dir.

Fix: introduce a single sanitized resolver and use it at both spawn sites. If the
inherited `ZDOTDIR` is Manor's own zdotdir, treat it as absent and fall back to
`HOME`.

## Implementation

1. In `electron/shell.ts`, add a static method to `ShellManager`:

   ```ts
   static realZdotdir(): string {
     const inherited = process.env.ZDOTDIR;
     // If the app inherited OUR own zdotdir (Manor launched from a Manor pane),
     // it is not a real user ZDOTDIR — fall back to HOME so the generated scripts
     // source the user's real dotfiles instead of recursively sourcing themselves.
     if (inherited && inherited !== this.zdotdirPath()) return inherited;
     return process.env.HOME ?? "";
   }
   ```

   `zdotdirPath()` already exists on `ShellManager` and returns `shellZdotdir()`.

2. Replace the inline `REAL_ZDOTDIR` computation at both call sites with
   `ShellManager.realZdotdir()`:
   - `electron/pty.ts:30` — currently
     `REAL_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || ""`. `ShellManager`
     is already imported in this file.
   - `electron/terminal-host/session.ts:234` — same expression inside the
     `buildShellEnv(...)` overrides object. `ShellManager` is already imported.

3. Add a unit test (extend `electron/__tests__/shell.test.ts` or add a focused
   `describe`) covering `ShellManager.realZdotdir()`:
   - returns `HOME` when `process.env.ZDOTDIR` is unset
   - returns `HOME` when `process.env.ZDOTDIR` equals `ShellManager.zdotdirPath()`
     (the nested-launch poison case)
   - returns the inherited value when `process.env.ZDOTDIR` is a real, different
     dir
   Save/restore `process.env.ZDOTDIR` and `process.env.HOME` around the test.
   Note the existing test file mocks `../paths` so `shellZdotdir()` returns a
   fixed temp `zdotdir` path — assert against that same value.

## Files to touch
- `electron/shell.ts` — add `static realZdotdir()` to `ShellManager`.
- `electron/pty.ts` — use `ShellManager.realZdotdir()` for the `REAL_ZDOTDIR` env var.
- `electron/terminal-host/session.ts` — use `ShellManager.realZdotdir()` for the `REAL_ZDOTDIR` env var.
- `electron/__tests__/shell.test.ts` — unit tests for `realZdotdir()`.
