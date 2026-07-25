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

## Notes

- `GET /recordings` must be registered **before** the `/webview/:id/*` regex match at line 284,
  matching how `/webviews` is placed.
- The stop round-trip needs a longer timeout than `requestRenderer`'s 5s default — flushing a large
  trailing chunk can take a moment. Pass ~15s, as the pick-element route does with its 35s.

## Files to touch

- `electron/webview-server.ts` — three routes; import the manager exported by
  `electron/ipc/webview.ts`.
- `electron/__tests__/webview-server.test.ts` — extend. The screenshot tests at line 200 show the
  established mocking approach. Cover: start returns a `recordingId`; start on an unknown pane
  `404`s; a renderer failure on start rolls back and leaves no recording in `list()`; stop returns
  the path and keyframes; stop with an unknown `recordingId` `404`s; `GET /recordings` lists actives.
