---
title: Renderer MediaRecorder + IPC chunk channel
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Renderer recorder and IPC wiring

Connect the `RecordingManager` from ticket 1 to an actual `MediaRecorder` running in the renderer.
This is the only part of the webview toolset that spans both processes — read
`electron/renderer-bridge.ts` before starting, since the main→renderer round-trip already has an
established shape (`requestRenderer`, `AppCommand`, `app-command-result`).

## Renderer side

Create `src/lib/webview-recorder.ts` — plain TS, no React, matching how `src/lib/app-commands.ts`
stays unit-testable by avoiding component state.

- `startRecording(recordingId: string, mediaSourceId: string): Promise<void>`

  ```ts
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: mediaSourceId },
    },
  } as unknown as MediaStreamConstraints);
  ```

  `chromeMediaSource` is a non-standard Chromium constraint that `MediaStreamConstraints` does not
  model — the cast is required. Do not try to widen the DOM types.

  Then `new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" })`. Check
  `MediaRecorder.isTypeSupported` and fall back to `"video/webm"` if VP9 is unavailable. Call
  `recorder.start(1000)` so chunks arrive every second rather than in one blob at the end.

  On `ondataavailable`: `await e.data.arrayBuffer()` then
  `window.manor.webview.sendRecordingChunk(recordingId, buffer)`.

- `stopRecording(recordingId)` — stop the recorder, stop every track on the stream (leaving tracks
  live keeps the capture running and the pane's recording indicator lit in the OS), await the
  recorder's `stop` event so the trailing chunk is delivered, then notify main.
- Keep a module-level `Map<recordingId, { recorder, stream }>`. Export `stopAll()` for teardown.

## Main side

In `electron/ipc/webview.ts`:

- Instantiate the `RecordingManager` alongside the existing `webviewRegistry` (line 30) and export
  it so ticket 3's HTTP routes can reach it.
- `ipcMain.on("webview:recording-chunk", (_e, recordingId: string, chunk: ArrayBuffer))` — validate
  `recordingId` with `assertString`, then `manager.appendChunk(recordingId, Buffer.from(chunk))`.
  Use `ipcMain.on`, not `handle`: chunks are fire-and-forget and a round-trip per second per
  recording is pointless overhead.
- **Backpressure.** `appendChunk` currently discards `stream.write()`'s `false` return, so a
  high-bitrate capture to a slow disk buffers inside the stream in main's memory — which
  contradicts the ADR's "never held in memory" claim. Change `appendChunk` in
  `electron/recording-manager.ts` to return the `write()` boolean, and have this IPC handler
  respect it: when it returns `false`, stop forwarding until the stream's `drain` event fires.
  Dropping chunks is not acceptable (the webm would be corrupt) — queue them, and if the queue
  exceeds a bounded size, stop the recording with an error rather than growing without limit.
- `ipcMain.handle("webview:recording-stopped", …)` — the renderer confirming its recorder flushed;
  resolves the main-side stop.
- Wire `manager.onAutoStop` to send the renderer a stop instruction, so a `maxDurationSec` trip
  actually tears down the `MediaRecorder` rather than just closing the file underneath it.
- Teardown: call `manager.stopForPane(paneId)` inside the existing `webview:unregister` handler
  (line 337). Call `manager.stopAll()` on app quit.

## Preload

Add to the `webview` object in `electron/preload.ts` (line 460), following the surrounding style:

- `sendRecordingChunk(recordingId, buffer)` → `ipcRenderer.send`
- `notifyRecordingStopped(recordingId)` → `ipcRenderer.invoke`
- `onRecordingCommand(callback)` → subscription for main-initiated start/stop, returning an
  unsubscribe function like every other listener in the file.

Update the corresponding renderer type declarations wherever `window.manor` is typed.

## Files to touch

- `src/lib/webview-recorder.ts` — new. `getUserMedia` + `MediaRecorder` + chunk forwarding.
- `electron/ipc/webview.ts` — manager instance, chunk/stopped handlers, auto-stop bridge,
  teardown in `webview:unregister`.
- `electron/preload.ts` — three new entries on the `webview` bridge object.
- `src/App.tsx` — subscribe `onRecordingCommand` to the recorder module so main can drive it.
- `src/lib/__tests__/webview-recorder.test.ts` — new. Stub `navigator.mediaDevices` and
  `MediaRecorder`; assert the constraint object contains the right `chromeMediaSourceId`, that
  chunks forward with the correct id, and that `stopRecording` stops every track.
