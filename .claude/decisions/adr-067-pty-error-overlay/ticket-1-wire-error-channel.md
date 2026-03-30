---
title: Wire PTY error channel from preload to renderer
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Wire PTY error channel from preload to renderer

The `pty-error-${paneId}` IPC channel is already sent by main.ts but never consumed. Wire it through.

## Files to touch

- `electron/preload.ts` — Add `onError` to the `pty` object, same pattern as `onOutput`/`onExit`
- `src/vite-env.d.ts` — Add `onError` type to the `electronAPI.pty` interface (if typed here)
- `src/hooks/useTerminalStream.ts` — Subscribe to `onError`, invoke a callback with the error message
- `src/hooks/useTerminalLifecycle.ts` — Accept errors from both `create()` returning `{ ok: false }` and runtime error events from the stream. Expose error state.
- `src/components/TerminalPane.tsx` — Render an error overlay when error state is set. Show the error message, a note about macOS shell permissions, and a button to open System Preferences > Privacy & Security > Full Disk Access (or Developer Tools).
- `src/components/TerminalPane.module.css` — Styles for the error overlay (centered, semi-transparent background over the terminal area).
