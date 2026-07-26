---
title: Extract and test the main-side chunk queue
status: todo
priority: medium
assignee: sonnet
blocked_by: [3]
---

# Test coverage for the chunk backpressure queue

Raised by ticket 2. The backpressure machinery it added — `acceptChunk`, `drainChunkQueue`, and the
bounded-queue abort path — lives inline in `electron/ipc/webview.ts`, which has **no test harness at
all**. There is no sibling `electron/ipc/*.test.ts`, because testing that file means mocking
`ipcMain` and `webContents`.

So the one piece of this feature most likely to corrupt output under load is the one piece with zero
tests. A dropped or out-of-order chunk produces a webm that is silently unplayable — the failure is
invisible until a human tries to open the file.

## Approach

Extract the queue into its own module — `electron/recording-chunk-queue.ts` — that takes the
manager (or just `appendChunk` / `waitForDrain` as injected functions) and knows nothing about
`ipcMain`. `electron/ipc/webview.ts` then becomes a thin adapter: receive IPC message, hand to the
queue. This mirrors how ticket 1 kept `RecordingManager` free of Electron imports so it could be
tested directly.

## Cases to cover

- Chunks arriving faster than the stream drains are queued, not dropped.
- Queued chunks flush **in arrival order** after `drain` — order is the whole correctness property.
- Exceeding the bounded size (32 MiB as implemented) stops the recording with an error rather than
  growing without limit.
- A chunk arriving for an unknown or already-stopped `recordingId` is ignored, not queued forever.
- Teardown mid-drain does not hang or leak the pending queue.

## Files to touch
- `electron/recording-chunk-queue.ts` — new; the extracted queue.
- `electron/ipc/webview.ts` — delegate to it; no behaviour change.
- `electron/__tests__/recording-chunk-queue.test.ts` — new; the cases above.
