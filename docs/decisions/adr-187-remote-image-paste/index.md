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

# ADR-187: Paste clipboard images into agents on remote hosts

## Context

Pasting an image into Claude Code works in a local pane but does nothing in a
pane on a remote host (ADR-178).

Manor does not handle image paste itself. Ctrl+V reaches the PTY as `\x16`
(`useTerminalHotkeys` only intercepts app keybindings), and Claude Code
answers it by reading the clipboard of the machine it runs on (xclip /
wl-paste / osascript / PowerShell). On a remote host that is the ssh box,
which has no clipboard, so there is no image. Dragging a file in or pasting a
path does not help either: the path names a file on this machine that does
not exist on the box.

Claude Code does attach an image when the pasted text is a path to an image
file that exists. So the fix is for Manor to move the image to the box and
paste its path there.

Getting bytes onto the box is the missing piece. The terminal-host daemon can
`exec` and `readFile` but cannot write files. Putting base64 into an `exec`
argument hits Linux's 128 KiB per-argument limit (`MAX_ARG_STRLEN`), which
means about 96 KB of image. Most screenshots are bigger than that.

## Decision

### 1. A `writeFile` control request on the daemon

- `electron/terminal-host/types.ts`: add
  `{ type: "writeFile"; path: string; base64: string }`, answered with
  `{ type: "fileWritten" }`. Add it to `ResponseMap` and `REPLY_TYPES`.
- `electron/terminal-host/index.ts`: decode the base64, refuse more than
  `MAX_WRITE_FILE_BYTES` (20 MiB decoded), `mkdir -p` the parent, then write
  a temp file in the same directory and `rename` it over the target so a
  reader never sees a partial file. Errors are answered with
  `{ type: "error", message: "writeFile failed: …" }`, like `readFile`.
- `electron/terminal-host/control-queue.ts`: add `writeFile` to
  `UNSERIALIZED_REQUEST_TYPES`, so a large upload does not hold up the
  socket's queue. `rpc-channel.ts`'s `ConcurrentRequest` widens to match.
- `electron/terminal-host/client.ts`: `writeFile(path, data: Buffer)` via
  `rpc.callConcurrent`, with a 60s timeout.

**No `TERMINAL_HOST_PROTOCOL` bump.** A bump marks every running daemon as
stale (ADR-185 §B), and replacing a remote daemon ends its sessions. Adding a
request is backward compatible: an old daemon answers
`unknown request type: writeFile`, and the caller falls back (§2).

### 2. `Exec.writeFile` and `ShellBackend.writeFile`

- `Exec` (`electron/backend/exec.ts`) gains `writeFile(path, data: Buffer)`.
  - `localExec`: `fs.mkdir(dirname, { recursive: true })` + `fs.writeFile`.
  - `createRemoteExec`: `client.writeFile`. If the daemon answers
    `unknown request type`, fall back to chunked `exec`: `mkdir -p` and
    truncate, then append 64 KiB base64 chunks with
    `sh -c 'printf %s "$1" | base64 -d >> "$2"' sh <chunk> <tmp>`, and finish
    with `mv <tmp> <path>`. Remember the fallback per client so later pastes
    skip the failing request.
- `ShellBackend` (`electron/backend/types.ts`) gains
  `writeFile(path, data: Buffer)`; `ExecShellBackend` passes it to its
  `Exec`.

### 3. Main process: `terminal:pasteClipboardImage(paneId)`

A new handler in `electron/ipc/misc.ts`, next to the clipboard handlers,
returns one of:

- `{ kind: "local" }`: the pane's session belongs to the local host
  (`backendRegistry.sessions.ownerOf(paneId)` is undefined or
  `LOCAL_HOST_ID`). Do nothing; the agent reads the clipboard itself.
- `{ kind: "none" }`: `clipboard.readImage()` is empty.
- `{ kind: "uploaded"; path }`: the image was encoded with `toPNG()` and
  written with the pane's host's `shell.writeFile` to
  `<homeDir>/.manor/pasted-images/<yyyymmdd-hhmmss>-<8 hex>.png`.
- `{ kind: "error"; message }`: the upload failed, for example because the
  host is away (`HostUnavailableError`).

After a successful upload, a fire-and-forget
`find <dir> -type f -mtime +7 -delete` through the host's `shell.exec` keeps
the directory from growing. Its failures are ignored.

Exposed in `electron/preload.ts` as
`electronAPI.terminal.pasteClipboardImage(paneId)` and typed in
`src/electron.d.ts`.

### 4. Renderer: intercept paste on remote panes only

A new `src/lib/remote-image-paste.ts` exports
`pasteClipboardImage(term, paneId, fallback)`. It calls the IPC:

- `uploaded` → `term.paste(path + " ")`. xterm wraps it in bracketed paste
  when the app enabled it, which is how Claude Code recognizes a pasted path.
- `local` / `none` → `fallback()`.
- `error` → an error toast ("Couldn't paste image to <host>: …") via
  `useToastStore`, and no fallback.

It is triggered from three places, and only when
`useRemotePaneStore` reports a host for the pane:

1. **Ctrl+V** (all platforms; the key Claude Code binds to image paste): in
   `useTerminalHotkeys`, swallow the keydown and call the helper. The
   fallback writes `\x16` so behavior without an image is unchanged.
2. **The DOM `paste` event** (Cmd+V on macOS, Ctrl+Shift+V, the Edit menu):
   a capture-phase listener on the terminal container. If `clipboardData`
   has an `image/*` item and no `text/plain`, `preventDefault()` and call
   the helper; otherwise let xterm handle it.
3. **The pane context menu's Paste** (`TerminalPane.tsx`): try the helper
   first; its fallback is the existing `readText` + paste.

## Consequences

- Image paste works on remote hosts and looks the same to Claude Code (and
  to any agent that accepts an image path) as a local paste.
- Local panes do not change at all. The IPC answers `local` before it
  touches the clipboard.
- The daemon's wire protocol grows by one request without a version bump.
  That depends on the daemon answering unknown requests with an error, which
  it already does. Any future request that is not backward compatible still
  needs a bump.
- Until a remote daemon restarts on a build with `writeFile`, uploads use the
  chunked `exec` fallback: about 25 round trips for a 2 MB screenshot. It is
  slower but correct.
- Ctrl+V on a remote pane now waits for one IPC round trip, and also a
  clipboard read, before `\x16` reaches the PTY. This is a local call, far
  shorter than the ssh latency the keystroke already pays.
- Pasted images build up in `~/.manor/pasted-images` on the box. The 7-day
  sweep bounds this. A pasted path the agent has not yet read could be swept
  if it sits for more than a week, which is acceptable.
- `writeFile` is a general file-write primitive on a daemon that already runs
  arbitrary `exec`, so it adds no new capability to the trust boundary.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
