/**
 * Renderer half of webview video recording (ADR-158).
 *
 * Main owns the file and the lifecycle (see `electron/recording-manager.ts`);
 * this module owns the `MediaRecorder`, because only a renderer can call
 * `getUserMedia`. Main drives it over the "webview:recording-command" channel
 * and receives webm chunks back over "webview:recording-chunk".
 *
 * Plain TS on purpose — no React, no store — so the whole thing is unit-
 * testable with a stubbed `navigator.mediaDevices`, the same way
 * `src/lib/app-commands.ts` stays testable by avoiding component state.
 */

/** Payload of the main→renderer "webview:recording-command" channel. */
export interface RecordingCommand {
  cmd: "start" | "stop";
  recordingId: string;
  /** Chromium media source id of the pane's webview. Required for "start". */
  mediaSourceId?: string;
}

/**
 * Emit a chunk every second rather than one blob at the end: main streams each
 * chunk straight to disk, so a single trailing blob would defeat the point and
 * would lose everything if the app died mid-recording.
 */
const CHUNK_INTERVAL_MS = 1000;

/**
 * How long to wait for the recorder's `stop` event before giving up on the
 * trailing chunk. Main has its own (longer) timeout; this one only exists so a
 * wedged recorder cannot hang renderer-side teardown forever.
 */
const STOP_TIMEOUT_MS = 2000;

const PREFERRED_MIME_TYPES = ["video/webm;codecs=vp9", "video/webm"];

interface ActiveRecording {
  recorder: MediaRecorder;
  stream: MediaStream;
  /** In-flight chunk forwards, so `stopRecording` can await the last one. */
  pending: Set<Promise<void>>;
}

const active = new Map<string, ActiveRecording>();

/** First mime type this Chromium build can actually record. */
function pickMimeType(): string {
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return PREFERRED_MIME_TYPES[PREFERRED_MIME_TYPES.length - 1];
}

function stopTracks(stream: MediaStream): void {
  // Leaving tracks live keeps the capture running (and the OS recording
  // indicator lit) long after the recorder itself is inactive.
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track belonging to a destroyed webview may already be dead.
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ship one blob to main. Chunks are fire-and-forget (`ipcRenderer.send`) —
 * a round-trip per second per recording buys nothing.
 */
async function forwardChunk(recordingId: string, blob: Blob): Promise<void> {
  if (!blob || blob.size === 0) return;
  const buffer = await blob.arrayBuffer();
  window.electronAPI.webview.sendRecordingChunk(recordingId, buffer);
}

/**
 * Capture the pane identified by `mediaSourceId` and start streaming chunks to
 * main. Throws if the capture cannot be started; the caller reports that to
 * main so it can tear down the (empty) file.
 */
export async function startRecording(
  recordingId: string,
  mediaSourceId: string,
): Promise<void> {
  if (active.has(recordingId)) return;

  // `chromeMediaSource`/`chromeMediaSourceId` are non-standard Chromium
  // constraints that `MediaStreamConstraints` does not model, hence the cast.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: mediaSourceId,
      },
    },
  } as unknown as MediaStreamConstraints);

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
  } catch (err) {
    // The stream is live even though the recorder never was.
    stopTracks(stream);
    throw err;
  }

  const entry: ActiveRecording = { recorder, stream, pending: new Set() };
  recorder.ondataavailable = (event: BlobEvent) => {
    const forward = forwardChunk(recordingId, event.data)
      .catch((err: unknown) => {
        console.error(`[recording] failed to forward chunk:`, err);
      })
      .finally(() => {
        entry.pending.delete(forward);
      });
    entry.pending.add(forward);
  };

  active.set(recordingId, entry);
  recorder.start(CHUNK_INTERVAL_MS);
}

/** Resolve when the recorder emits `stop`, or after `STOP_TIMEOUT_MS`. */
function awaitRecorderStop(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recorder.removeEventListener("stop", done);
      resolve();
    };
    const timer = setTimeout(done, STOP_TIMEOUT_MS);
    recorder.addEventListener("stop", done);
  });
}

/**
 * Stop a recording and tell main it has flushed.
 *
 * Order matters: `stop()` triggers one last `dataavailable` before the `stop`
 * event, so the tracks stay live and the notification waits until that chunk
 * has actually been sent. Notifying first would let main finalize the file
 * without the recording's tail.
 */
export async function stopRecording(recordingId: string): Promise<void> {
  const entry = active.get(recordingId);
  if (!entry) {
    // Nothing to flush (a start that failed, or a duplicate stop). Confirm
    // anyway so main can finalize now instead of waiting out its timeout.
    await window.electronAPI.webview.notifyRecordingStopped(recordingId);
    return;
  }
  active.delete(recordingId);

  const stopped = awaitRecorderStop(entry.recorder);
  if (entry.recorder.state !== "inactive") {
    try {
      entry.recorder.stop();
    } catch (err) {
      console.error(`[recording] failed to stop recorder:`, err);
    }
  }
  await stopped;
  await Promise.allSettled([...entry.pending]);

  stopTracks(entry.stream);
  await window.electronAPI.webview.notifyRecordingStopped(recordingId);
}

/** Stop every active recording. Used on teardown. */
export async function stopAll(): Promise<void> {
  await Promise.allSettled([...active.keys()].map((id) => stopRecording(id)));
}

/** Ids of the recordings this renderer is currently capturing. */
export function activeRecordingIds(): string[] {
  return [...active.keys()];
}

/**
 * Entry point for the "webview:recording-command" subscription in `App.tsx`.
 * A start that fails is reported as an immediate stop so main does not sit on
 * an empty file waiting for chunks that will never arrive.
 */
export async function handleRecordingCommand(
  command: RecordingCommand,
): Promise<void> {
  if (command.cmd === "start") {
    if (!command.mediaSourceId) {
      await window.electronAPI.webview.notifyRecordingStopped(
        command.recordingId,
        "Missing mediaSourceId",
      );
      return;
    }
    try {
      await startRecording(command.recordingId, command.mediaSourceId);
    } catch (err) {
      await window.electronAPI.webview.notifyRecordingStopped(
        command.recordingId,
        errorMessage(err),
      );
    }
    return;
  }

  if (command.cmd === "stop") {
    await stopRecording(command.recordingId);
  }
}
