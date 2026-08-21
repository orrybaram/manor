---
title: Main process — carry seq to the renderer
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Main process — carry seq to the renderer

Thread the new field through the two places the renderer learns about output.

- Stream events: `pty-output-<paneId>` currently sends just the data string. Send
  the seq alongside it.
- Warm restore: `pty:create` returns `{ ok, snapshot, prewarmed }`. Add
  `snapshotSeq` from the snapshot the client returned.

The in-process PTY backend (`electron/pty.ts`) is a second source of the same
channel. Give it its own per-pane counter so the renderer sees one shape no
matter which backend is live.

## Files to touch
- `electron/app-lifecycle.ts` — `handleStreamEvent`'s `data` case sends the seq.
- `electron/ipc/pty.ts` — `pty:create` returns `snapshotSeq`.
- `electron/pty.ts` — per-pane counter for the in-process backend's output.
- `electron/preload.ts` — `onOutput` callback signature gains the seq.
- `src/electron.d.ts` — matching type for `onOutput` and the `pty:create` result.

## Notes
- Missing seq must stay meaningful: an app talking to an older daemon receives
  `undefined`, which ticket 5 treats as "apply everything" — today's behavior.
