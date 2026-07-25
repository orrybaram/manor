---
title: HTTP routes for record start/stop/list
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Webview server recording routes

Expose the `RecordingManager` over the local control server so the out-of-process MCP server can
reach it. Follow the existing route style in `electron/webview-server.ts` exactly — the
`/webview/:id/*` dispatch block starts at line 283 and the screenshot route at line 302 is the
closest model.

## Routes

**`POST /webview/:id/record/start`**

Body: `{ path?, maxDurationSec?, keyframeIntervalSec? }`.

1. `wc.getMediaSourceId()` for the resolved webContents.
2. `manager.start({ paneId, path, maxDurationSec, keyframeIntervalSec, capture: () => wc.capturePage().then(i => i.toPNG().toString("base64")) })`.
3. `requestRenderer("start-recording", { recordingId, mediaSourceId })` — see
   `electron/renderer-bridge.ts:103`.
4. If the renderer round-trip fails, **roll back**: `manager.stop(recordingId)` and delete the
   empty file, then return the renderer's error. A registered recording with no `MediaRecorder`
   behind it would sit there collecting keyframes and never produce video.

Respond `200 { recordingId, path, warning? }`. Set `warning` when the target pane is not currently
visible — Chromium throttles hidden contents and the capture may stall (see the ADR's risks).

**`POST /webview/:id/record/stop`**

Body: `{ recordingId? }`. With no `recordingId`, stop the pane's active recording. Ask the renderer
to stop first and await it, so the trailing chunk lands before the stream is ended, then
`manager.stop()`. Respond `200 { path, durationMs, bytes, keyframes }`. Unknown id → `404`.

**`GET /recordings`**

Top-level, next to `GET /webviews` (line 267) — it is not scoped to one pane. Respond
`200 [{ recordingId, paneId, path, elapsedMs }]`.

## Also: make auto-stopped recordings retrievable

Ticket 1 surfaced a hole in the design. When the `maxDurationSec` timer trips, the manager
finalizes the recording and drops it from its map. A later `stop_recording(recordingId)` then
returns `null` — so an agent that starts a recording, waits, and comes back past the timeout never
learns the output path and never receives the keyframes. That is the exact case the auto-stop cap
exists to handle, and it currently loses the result.

Fix it in `electron/recording-manager.ts`: keep a bounded `Map<recordingId, StopRecordingResult>`
of recently-finished recordings (cap ~16, evict oldest). `stop()` consults it before returning
`null`, so stopping an already-auto-stopped recording returns its real result instead of a miss.

The stop route should distinguish the two cases in its response: a live recording it just stopped
versus a finished one it is replaying. Return `{ ..., alreadyStopped: true }` for the latter so
ticket 4's tool text can say so plainly rather than implying the agent's stop call ended it.

Add tests for both: auto-stop then `stop()` returns the result; an id evicted from the cache still
returns `null`.

## Notes

- `GET /recordings` must be registered **before** the `/webview/:id/*` regex match at line 284,
  matching how `/webviews` is placed.
- The stop round-trip needs a longer timeout than `requestRenderer`'s 5s default — flushing a large
  trailing chunk can take a moment. Pass ~15s, as the pick-element route does with its 35s.

## Files to touch

- `electron/webview-server.ts` — three routes; import the manager exported by
  `electron/ipc/webview.ts`.
- `electron/recording-manager.ts` — the bounded finished-recordings cache described above.
- `electron/__tests__/recording-manager.test.ts` — extend for the cache behaviour.
- `electron/__tests__/webview-server.test.ts` — extend. The screenshot tests at line 200 show the
  established mocking approach. Cover: start returns a `recordingId`; start on an unknown pane
  `404`s; a renderer failure on start rolls back and leaves no recording in `list()`; stop returns
  the path and keyframes; stop with an unknown `recordingId` `404`s; `GET /recordings` lists actives.
