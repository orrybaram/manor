/**
 * Main-process owner of all webview recording state.
 *
 * A recording is a `fs.WriteStream` fed by webm chunks the renderer produces
 * from a `MediaRecorder` (see ADR-158). This module holds nothing Electron-
 * specific on purpose: screenshot capture is injected as a `capture` callback,
 * so the whole lifecycle — timers, streams, keyframes — is unit-testable in a
 * plain Node process.
 *
 * The lifecycle rule that matters: every exit path must clear both timers and
 * end the stream. A leaked `setInterval` keeps calling `capturePage()` on a
 * webview that may already be destroyed, and a leaked stream orphans a
 * truncated file.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordingsDir } from "./paths";

// ── Tunables ──

const DEFAULT_MAX_DURATION_SEC = 120;
const MIN_MAX_DURATION_SEC = 1;
const MAX_MAX_DURATION_SEC = 600;

const DEFAULT_KEYFRAME_INTERVAL_SEC = 2;
const MIN_KEYFRAME_INTERVAL_SEC = 0.01;
const MAX_KEYFRAME_INTERVAL_SEC = 600;

/**
 * Hard cap on collected keyframes. Base64 PNGs of a full pane are large; an
 * unbounded interval over a 10-minute recording would balloon main's heap.
 */
const MAX_KEYFRAMES = 8;

// ── Types ──

interface Recording {
  recordingId: string;
  paneId: string;
  /** Absolute path of the webm file being written. */
  path: string;
  stream: fs.WriteStream;
  startedAt: number;
  bytes: number;
  /** Base64-encoded PNGs sampled while the recording runs. */
  keyframes: string[];
  autoStopTimer: ReturnType<typeof setTimeout>;
  keyframeTimer: ReturnType<typeof setInterval>;
  /** Set the moment `stop()` takes ownership, so late async work bails out. */
  stopping: boolean;
}

export interface StartRecordingOptions {
  paneId: string;
  /** Output path. Relative paths resolve against the process cwd. */
  path?: string;
  /** Auto-stop after this many seconds. Default 120, clamped to [1, 600]. */
  maxDurationSec?: number;
  /** Keyframe sampling interval in seconds. Default 2. */
  keyframeIntervalSec?: number;
  /** Returns a base64-encoded PNG of the pane. Injected so tests need no webContents. */
  capture: () => Promise<string>;
}

export interface StartRecordingResult {
  recordingId: string;
  /** Absolute path the recording is being written to. */
  path: string;
}

export interface StopRecordingResult {
  recordingId: string;
  paneId: string;
  /** Absolute path of the finalized webm file. */
  path: string;
  durationMs: number;
  bytes: number;
  /** Base64-encoded PNGs sampled during the recording. */
  keyframes: string[];
}

export interface ActiveRecording {
  recordingId: string;
  paneId: string;
  path: string;
  elapsedMs: number;
}

export interface AutoStopEvent {
  recordingId: string;
  paneId: string;
}

/**
 * Fired when a recording's `maxDurationSec` timer trips. The manager cannot
 * reach the renderer, so a listener is responsible for telling it to stop its
 * `MediaRecorder`. Listeners are awaited before the stream is finalized, giving
 * the renderer a chance to flush its final chunk.
 */
export type AutoStopListener = (event: AutoStopEvent) => void | Promise<void>;

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveSeconds(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/**
 * Resolve the output path and create its parent directory. Mirrors
 * `saveScreenshotToDisk` in `electron/mcp/tools-webview.ts`: relative paths
 * resolve against the process cwd, a `.webm` extension is appended when the
 * given path has none, and parent directories are created as needed.
 */
function resolveOutputPath(
  recordingId: string,
  savePath: string | undefined,
): string {
  let resolved = savePath
    ? path.resolve(savePath)
    : path.join(recordingsDir(), `${recordingId}.webm`);
  if (path.extname(resolved) === "") {
    resolved += ".webm";
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

// ── Manager ──

export class RecordingManager {
  private recordings = new Map<string, Recording>();
  private autoStopListeners = new Set<AutoStopListener>();

  /**
   * Open a recording for a pane: resolve the path, open the stream, arm the
   * auto-stop and keyframe timers. Throws if the pane already has an active
   * recording — one recording per pane.
   */
  start(opts: StartRecordingOptions): StartRecordingResult {
    const existing = this.findByPane(opts.paneId);
    if (existing) {
      throw new Error(
        `Pane ${opts.paneId} already has an active recording (${existing.recordingId}).`,
      );
    }

    const recordingId = crypto.randomUUID();
    const outputPath = resolveOutputPath(recordingId, opts.path);

    const maxDurationSec = resolveSeconds(
      opts.maxDurationSec,
      DEFAULT_MAX_DURATION_SEC,
      MIN_MAX_DURATION_SEC,
      MAX_MAX_DURATION_SEC,
    );
    const keyframeIntervalSec = resolveSeconds(
      opts.keyframeIntervalSec,
      DEFAULT_KEYFRAME_INTERVAL_SEC,
      MIN_KEYFRAME_INTERVAL_SEC,
      MAX_KEYFRAME_INTERVAL_SEC,
    );

    const stream = fs.createWriteStream(outputPath);
    // Without a listener a stream 'error' is an unhandled event and takes main
    // down. A failed write should only fail its own recording.
    stream.on("error", (err) => {
      console.error(`[recording] write error for ${recordingId}:`, err);
    });

    const recording: Recording = {
      recordingId,
      paneId: opts.paneId,
      path: outputPath,
      stream,
      startedAt: Date.now(),
      bytes: 0,
      keyframes: [],
      autoStopTimer: setTimeout(() => {
        void this.handleAutoStop(recordingId);
      }, maxDurationSec * 1000),
      keyframeTimer: setInterval(() => {
        void this.captureKeyframe(recordingId, opts.capture);
      }, keyframeIntervalSec * 1000),
      stopping: false,
    };

    this.recordings.set(recordingId, recording);
    return { recordingId, path: outputPath };
  }

  /**
   * Append a webm chunk. Unknown ids are ignored silently: the renderer's
   * `MediaRecorder` can emit a final chunk after main has already stopped.
   */
  appendChunk(recordingId: string, chunk: Buffer): void {
    const recording = this.recordings.get(recordingId);
    if (!recording || recording.stopping) return;
    recording.bytes += chunk.length;
    recording.stream.write(chunk);
  }

  /**
   * Finalize a recording: clear both timers, end the stream, wait for it to
   * flush, and return the result. Returns null for an unknown id.
   */
  async stop(recordingId: string): Promise<StopRecordingResult | null> {
    const recording = this.recordings.get(recordingId);
    if (!recording) return null;

    // Drop it from the map before any await so a concurrent stop (auto-stop
    // racing an explicit stop) cannot finalize the same stream twice.
    this.recordings.delete(recordingId);
    recording.stopping = true;
    clearTimeout(recording.autoStopTimer);
    clearInterval(recording.keyframeTimer);

    await endStream(recording.stream);

    return {
      recordingId: recording.recordingId,
      paneId: recording.paneId,
      path: recording.path,
      durationMs: Date.now() - recording.startedAt,
      bytes: recording.bytes,
      keyframes: recording.keyframes,
    };
  }

  /** Stop the recording for a pane, if any. Used by pane teardown paths. */
  async stopForPane(paneId: string): Promise<StopRecordingResult | null> {
    const recording = this.findByPane(paneId);
    if (!recording) return null;
    return this.stop(recording.recordingId);
  }

  /** Stop every active recording. Used on app quit. */
  async stopAll(): Promise<StopRecordingResult[]> {
    const ids = [...this.recordings.keys()];
    const results = await Promise.all(ids.map((id) => this.stop(id)));
    return results.filter((r): r is StopRecordingResult => r !== null);
  }

  /** Active recordings, with elapsed time. */
  list(): ActiveRecording[] {
    const now = Date.now();
    return [...this.recordings.values()].map((recording) => ({
      recordingId: recording.recordingId,
      paneId: recording.paneId,
      path: recording.path,
      elapsedMs: now - recording.startedAt,
    }));
  }

  /** Register an auto-stop listener. Returns a disposer. */
  onAutoStop(listener: AutoStopListener): () => void {
    this.autoStopListeners.add(listener);
    return () => {
      this.autoStopListeners.delete(listener);
    };
  }

  // ── Internals ──

  private findByPane(paneId: string): Recording | undefined {
    for (const recording of this.recordings.values()) {
      if (recording.paneId === paneId) return recording;
    }
    return undefined;
  }

  /**
   * The `maxDurationSec` timer tripped. Notify listeners first — that is how
   * the renderer learns to stop its `MediaRecorder` and flush a last chunk —
   * then finalize. A listener that throws must not leave the stream open.
   */
  private async handleAutoStop(recordingId: string): Promise<void> {
    const recording = this.recordings.get(recordingId);
    if (!recording || recording.stopping) return;

    // The keyframe loop is pointless from here on; the recording is ending.
    clearInterval(recording.keyframeTimer);

    const event: AutoStopEvent = {
      recordingId,
      paneId: recording.paneId,
    };
    await Promise.allSettled(
      [...this.autoStopListeners].map(async (listener) => listener(event)),
    );

    await this.stop(recordingId);
  }

  /**
   * Sample one keyframe. A capture failure is swallowed — a screenshot that
   * fails (pane navigating, webview offscreen) must never kill an in-flight
   * recording.
   */
  private async captureKeyframe(
    recordingId: string,
    capture: () => Promise<string>,
  ): Promise<void> {
    const recording = this.recordings.get(recordingId);
    if (!recording || recording.stopping) return;
    if (recording.keyframes.length >= MAX_KEYFRAMES) {
      clearInterval(recording.keyframeTimer);
      return;
    }

    let frame: string;
    try {
      frame = await capture();
    } catch {
      return; // skip this frame
    }

    // The recording may have been stopped while the capture was in flight.
    const current = this.recordings.get(recordingId);
    if (!current || current.stopping) return;
    if (current.keyframes.length >= MAX_KEYFRAMES) return;
    current.keyframes.push(frame);
    if (current.keyframes.length >= MAX_KEYFRAMES) {
      clearInterval(current.keyframeTimer);
    }
  }
}

/**
 * End a write stream and wait for it to flush. Resolves on `error` too — a
 * broken stream never emits `finish`, and a teardown path must not hang.
 */
function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("finish", done);
    stream.once("error", done);
    stream.end();
  });
}

/**
 * Shared instance for the main process. Tests construct their own.
 */
export const recordingManager = new RecordingManager();
