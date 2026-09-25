---
title: Linux port scanning and port forwarding for remote projects
status: todo
priority: medium
assignee: opus
blocked_by: [1]
---

# Linux port scanning and port forwarding for remote projects

Remote dev servers must show up in the ports list and open in the webview (ADR-178 §5).

1. **Scanner by platform:** `electron/backend/local-ports.ts` hardcodes
   `/usr/sbin/lsof`. Detect platform once per Exec (`uname -s`, cached). macOS keeps
   the lsof path. Linux: `ss -ltnpH` for listeners (parse port + pid from
   `users:(("node",pid=123,fd=19))`), `readlink /proc/<pid>/cwd` for cwd. Fall back to
   `lsof` on Linux if `ss` is missing. Keep the existing pid→workspace matching.
   `killPort` on remote must go through Exec (`kill <pid>`), not `process.kill`
   (`local-ports.ts:47`).
2. **Forwarding:** when the renderer opens a port that belongs to a remote project
   (webview navigate, port list "open"), main calls
   `registry.provider(hostId).forwardPort(port)` and substitutes the returned local
   port in the URL. Cache forwards per (host, port); dispose on host disconnect and
   recreate on reconnect. Portless routes for remote projects target the forwarded
   local port.
3. If the provider has `previewUrl`, expose "Copy public URL" in the port list.

Tests: `ss` output parsing (fixtures incl. IPv6 and multiple pids), platform selection,
forward cache lifecycle with a fake provider.

## Files to touch
- `electron/backend/local-ports.ts` — platform scanners, Exec-based kill.
- `electron/backend/local-ports.test.ts` — Linux fixtures.
- `electron/ports.ts`, `electron/ipc/ports.ts` — forwarding on open, portless targets.
- `electron/portless.ts` — accept forwarded ports for remote routes.
- `src/` port list component — "Copy public URL" when available.
