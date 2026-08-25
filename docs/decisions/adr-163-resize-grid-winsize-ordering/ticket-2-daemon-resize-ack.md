---
title: The daemon answers a resize only once the ioctl has landed
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# The daemon answers a resize only once the ioctl has landed

`pty:resize` resolved as soon as a resize frame had been written to the pty
subprocess's stdin, which says nothing about when the winsize changed. Make the
acknowledgement mean what the caller needs it to mean, and carry the stream
position that separates old-size output from new-size output.

- New `Resized` (`0x17`) subprocess→daemon frame, sent after `ptyProcess.resize`.
  Flush the batched output first: the boundary is only a boundary if no
  pre-resize byte can follow it on the wire.
- `Session.resize` returns a promise resolving on that frame with the current
  `outputSeq`, with a timeout so a dead subprocess cannot strand the caller.
  Resize the headless mirror at the same boundary, behind its write queue.
- Carry the position out through `resized` / `TerminalHostClient.resize` /
  `PtyBackend.resize` / `pty:resize`, and bump `TERMINAL_HOST_PROTOCOL` to 2.
  Absent means "no boundary", which is what a protocol-1 daemon already did.

## Files to touch
- `electron/terminal-host/pty-subprocess-ipc.ts` — the `RESIZED` message type.
- `electron/terminal-host/pty-subprocess.ts` — flush, resize, ack.
- `electron/terminal-host/session.ts` — pending resizes, the boundary, mirror.
- `electron/terminal-host/terminal-host.ts`, `index.ts`, `types.ts`,
  `client.ts` — thread the position out; protocol 2.
- `electron/backend/types.ts`, `electron/backend/local-pty.ts`,
  `electron/ipc/pty.ts`, `src/electron.d.ts` — same, up to the renderer.
