---
title: Recording manager (main-process state, file streams, keyframes)
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Recording manager

Create `electron/recording-manager.ts` — the main-process owner of all recording state. This
ticket is pure state + file I/O with no IPC and no HTTP wiring; those land in tickets 2 and 3.
Keeping it standalone is deliberate: this module holds the lifecycle logic most likely to leak
file handles, so it must be unit-testable without Electron.

## Behaviour

Export a `RecordingManager` class holding a `Map<string, Recording>` keyed by an opaque
`recordingId` (use `crypto.randomUUID()`).

```ts
interface Recording {
  recordingId: string;
  paneId: string;
  path: string;              // absolute
  stream: fs.WriteStream;
  startedAt: number;
  bytes: number;
  keyframes: string[];       // base64 PNG
  autoStopTimer: ReturnType<typeof setTimeout>;
  keyframeTimer: ReturnType<typeof setInterval>;
}
```

Methods:

- `start(opts: { paneId, path?, maxDurationSec?, keyframeIntervalSec?, capture: () => Promise<string> })`
  — resolves the output path, creates parent dirs, opens the `WriteStream`, arms both timers,
  returns `{ recordingId, path }`. `capture` is injected (returns a base64 PNG) so tests need no
  `webContents`. Throws if `paneId` already has an active recording — one recording per pane.
- `appendChunk(recordingId, chunk: Buffer)` — writes to the stream, accumulates `bytes`. Silently
  ignores unknown ids (a chunk can arrive after stop).
- `stop(recordingId)` — clears both timers, ends the stream, **awaits the `finish` event**, returns
  `{ path, durationMs, bytes, keyframes }`. Returns `null` for an unknown id.
- `stopForPane(paneId)` — used by teardown paths in ticket 2.
- `stopAll()` — app-quit path.
- `list()` — active recordings with `recordingId`, `paneId`, `path`, `elapsedMs`.
- `onAutoStop(cb)` — register a callback fired when the `maxDurationSec` timer trips, so ticket 2
  can tell the renderer to stop its `MediaRecorder`. The manager cannot reach the renderer itself.

## Rules

- `maxDurationSec` default 120, clamped to `[1, 600]`.
- `keyframeIntervalSec` default 2. Stop collecting at 8 frames — capped so a long recording cannot
  balloon main's heap with base64 PNGs. A `capture` rejection is swallowed (skip that frame); a
  failed screenshot must never kill an in-flight recording.
- Default path when `path` is omitted: `path.join(manorDataDir(), "recordings", recordingId + ".webm")`.
  Use `manorDataDir()` from `electron/paths.ts`.
- When `path` is given: resolve to absolute, append `.webm` if `path.extname()` is empty, `mkdirSync`
  the parent with `recursive: true`. Mirror `saveScreenshotToDisk` in
  `electron/mcp/tools-webview.ts:16`.
- Every timer must be cleared on every exit path. A leaked `setInterval` keeps calling `capturePage`
  on a destroyed webview.

## Files to touch

- `electron/recording-manager.ts` — new. The class described above.
- `electron/paths.ts` — add `recordingsDir()` next to the existing path helpers, following their
  exact shape.
- `electron/__tests__/recording-manager.test.ts` — new. Vitest. Cover: start writes a file; append
  accumulates bytes; stop resolves after the stream flushes and returns collected keyframes;
  auto-stop fires the callback and finalizes; a second `start` for the same paneId throws; a
  rejecting `capture` does not abort the recording; `stopAll` closes every stream. Write to a
  `fs.mkdtempSync` temp dir, not the real data dir.
