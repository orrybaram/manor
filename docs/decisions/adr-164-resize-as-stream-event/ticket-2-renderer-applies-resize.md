---
title: Apply the resize in the renderer at its stream position
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Apply the resize in the renderer at its stream position

Route the new event to the terminal and apply it behind xterm's write queue, so
the grid changes at the position the daemon marked rather than whenever the
message happens to arrive.

## Files to touch

- `electron/ipc/pty.ts`, `electron/preload.ts`, `src/electron.d.ts` — forward
  the `resized` event to the renderer as `pty.onResize(paneId, cb)`, following
  the shape of `onCwd` / `onAgentStatus`.
- `src/hooks/useTerminalStream.ts` — subscribe, and apply as
  `term.write("", () => term.resize(cols, rows))`. While output is still queued
  (before `openRestored`), the resize must queue with it in order — a snapshot
  already carries its own size, so a resize that predates the snapshot is
  dropped and one after it is applied in sequence.

## Notes

`term.write("", cb)` is the same mechanism `Session.resizeMirror` uses. Do not
call `term.resize` directly from the event handler.
