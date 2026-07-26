---
type: adr
status: proposed
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

# ADR-158: Webview video recording over MCP

## Context

Manor's MCP server exposes `screenshot_webview` (`electron/mcp/tools-webview.ts:308`), which
captures a single PNG of a browser pane via `webContents.capturePage()`
(`electron/webview-server.ts:304`). That covers "what does the page look like right now" but
nothing that unfolds over time: animations and transitions, a multi-step interaction repro, a
flaky loading state, a layout that only breaks mid-resize. An agent asked to verify any of those
today has to fire a burst of screenshots and hope it caught the moment.

The only capture path available outside the app is shelling out to `screencapture -v`. That
records the whole screen or a whole window, prompts for macOS Screen Recording permission, and
cannot target one pane out of a split layout. `ffmpeg` is not installed on the dev machine and
should not become a hard runtime dependency of Manor.

Chromium — already embedded in Electron — can record its own `webContents` with no native
dependency and no OS permission prompt, because it is capturing itself rather than the desktop.
That capability is currently unused: nothing in `electron/` or `src/` references
`getMediaSourceId`, `desktopCapturer`, or `MediaRecorder`.

## Decision

Add three MCP tools — `start_recording`, `stop_recording`, `list_recordings` — that record a
single webview pane to a `.webm` file on disk, built on Chromium's capture stack.

### Capture pipeline

`webContents.getMediaSourceId(requestWebContents)` on the pane's webContents returns a source
handle. The argument is required and is the renderer that will call `getUserMedia` — in Manor that
is the window hosting the pane, not necessarily the first window, since a pane can be popped out.
The renderer passes the handle to `getUserMedia` and pipes the stream into a `MediaRecorder`:

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: mediaSourceId },
  },
} as MediaStreamConstraints);
const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
```

MediaRecorder is a DOM API, so it must run in the renderer — this is the one place the recording
path diverges from the screenshot path, which lives entirely in main. The full flow:

```
MCP start_recording
  → POST /webview/:id/record/start          electron/webview-server.ts
  → wc.getMediaSourceId()                   main owns webviewRegistry (electron/ipc/webview.ts:30)
  → requestRenderer("start-recording", …)   electron/renderer-bridge.ts:103
  → renderer: getUserMedia → MediaRecorder  src/lib/webview-recorder.ts (new)
  → ondataavailable → ipcRenderer.send      chunk as ArrayBuffer
  → main: fs.WriteStream.write(chunk)       electron/recording-manager.ts (new)
```

Chunks stream straight to disk. The whole video is never held in memory in either process.

### Start/stop, not one blocking call

Recording length is driven by whatever the agent is waiting to observe, and MCP tool calls have
request timeouts. A single blocking `record_webview({ durationSec })` would cap usable recordings
at the timeout and block the agent for the duration. Instead the pair returns immediately:

| Tool | Args | Returns |
| --- | --- | --- |
| `start_recording` | `paneId?`, `path?`, `maxDurationSec?`, `keyframeIntervalSec?` | `recordingId`, output path |
| `stop_recording` | `recordingId?` | path, duration, bytes, **keyframe images** |
| `list_recordings` | — | active recordings with elapsed time |

`recordingId` is an opaque string minted by main. This is Manor's first MCP tool set with state
spanning calls; the MCP process stays stateless and passes the id back.

### Video is written to disk, never returned inline

MCP content blocks are text, image, or resource — there is no video type, and a model cannot watch
a video anyway. So `stop_recording` always reports a path rather than embedding the file, following
`saveScreenshotToDisk` (`electron/mcp/tools-webview.ts:16`): relative paths resolve against the MCP
process cwd, the extension is appended when missing, parent directories are created. Default output
is `<manorDataDir()>/recordings/<recordingId>.webm` when no `path` is given.

### Keyframes, so the agent can still see

A path alone tells the calling agent nothing about what was captured. While a recording runs, main
also ticks `wc.capturePage()` on a slow interval (default 2s, hard cap 8 frames) into an in-memory
buffer. `stop_recording` returns those frames as `image` content blocks alongside the path.

This deliberately avoids decoding the webm: sampling frames out of a VP9 container would require
ffmpeg, which is precisely the dependency being avoided. A parallel low-rate `capturePage()` loop
reuses machinery that already exists and already works. The video file is for the human; the
keyframes are for the agent.

### Lifecycle and safety

- `maxDurationSec` defaults to 120 and is clamped to 600. Main holds an auto-stop timer, so a
  recording the agent forgets about cannot run until the disk fills.
- Recordings are force-finalized on pane unregister (`webview:unregister`,
  `electron/ipc/webview.ts:337`), on renderer `destroyed`, and on app quit. A `WriteStream` left
  open by a renderer crash would otherwise orphan a truncated file.
- A recording indicator renders on the pane while capture is live. Screen capture that a user
  cannot see running is not acceptable, even when it is the user's own agent that started it.

### Explicitly out of scope

- **Audio.** `audio: false`. Capturing macOS system audio needs a loopback driver — a separate
  problem with its own install story.
- **mp4.** webm/VP9 only. Transcoding needs ffmpeg.

## Consequences

**Better**

- Per-pane recording with no native dependency, no bundled binary, and no OS permission prompt.
- Encoding is hardware-accelerated by Chromium, so recording does not stall the pane the way a
  `capturePage()` frame loop (~50ms/frame) would.
- The keyframe channel gives agents real visual evidence of a change over time, which is the actual
  motivating use case, without any video decoding.

**Harder**

- The webview subsystem gains its first long-lived stateful resource. Every teardown path — pane
  close, window close, renderer crash, app quit — now needs to finalize file streams. This is the
  main source of new bugs and the reason `recording-manager.ts` is a separate, unit-tested module
  rather than inline state in `webview-server.ts`.
- The recording path spans main *and* renderer, unlike every other webview tool. Debugging crosses
  a process boundary.

**Risks**

- `.webm` does not open in QuickTime. It plays in Chrome, VS Code, and IINA. Documented in the tool
  description so agents can tell the user.
- Chromium throttles rendering for hidden or fully occluded contents, so recording a
  non-visible pane can yield stalled or black frames. `start_recording` surfaces a warning rather
  than silently producing a dead file — but the check is approximate. Manor has no per-pane
  visibility signal in main, so the implementation falls back to `isFocused()` on the host window,
  which cannot tell whether the target pane is the visible one within a split or tabbed layout.
  If the warning proves too noisy or too quiet in practice, plumbing a real active-pane signal from
  the renderer is the fix.
- `chromeMediaSource: "tab"` is a non-standard Chromium constraint reached through a `mandatory`
  block that TypeScript's `MediaStreamConstraints` does not model; it needs a local cast. If a
  future Electron upgrade changes the constraint shape, this breaks at runtime, not compile time —
  hence a smoke test that asserts a stream is actually produced.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
