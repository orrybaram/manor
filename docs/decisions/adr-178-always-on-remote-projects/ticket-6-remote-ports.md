---
title: Linux port scanning and port forwarding for remote projects
status: done
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

## Implementation notes

- **Platform:** `PortsHost.platform()` — local answers from `process.platform`,
  remote runs `uname -s` once per Exec (cached; retried after a failure). macOS
  runs the exact same `/usr/sbin/lsof` commands as before. Linux runs `ss -ltnpH`
  (local address found by shape, not column index; one entry per port, first
  pid wins, like lsof), keeps only pids whose `ps -o pid=,uid=` uid is ours
  (as root `ss` shows everyone's processes), and reads cwds with
  `readlink /proc/<pid>/cwd`. If `ss` is missing (`ENOENT`/127, or the remote
  daemon's null-code spawn failure) the backend switches to `lsof` on PATH for
  good. Other platforms use `lsof` on PATH. Kill already went through Exec.
- **Forward cache:** `electron/remote-forwards.ts` (`RemoteForwards`), keyed by
  (hostId, remotePort), follows `registry.onStatusChange`: any non-`connected`
  status disposes the host's forwards but remembers them and their local port;
  `connected` recreates them, asking the provider for the old local port
  (`forwardPort(port, { preferredLocalPort })`, used only when free);
  unregistering forgets them; a replaced provider gets fresh forwards.
- **URL rewrite rule:** `ports:resolveUrl(url, hostId)` rewrites only
  `http(s)://localhost|127.0.0.1|[::1]:<port>` where `<port>` is in that
  host's latest scan (so a loopback URL the remote scan does not report is left
  alone — it may be a server on this machine). A portless `*.localhost` URL of
  such a port is kept, but its forward is made so the route has a target.
  Callers: port badge / palette (the port's `hostId`), and the browser pane when
  its workspace is on a remote host (typed URL, `navigate`, and the tab's
  initial URL — e.g. an agent's `new-tab`).
- **Portless:** remote ports get their hostname as before; the route points at
  the forward's local port and exists only once the port has been forwarded.
- **Public URL:** `canCopyPublicUrl` is set on a port only when its host's
  provider has `previewUrl` (ssh has none, so the menu item stays hidden).

