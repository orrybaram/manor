import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startRecording,
  stopRecording,
  stopAll,
  activeRecordingIds,
  handleRecordingCommand,
} from "../webview-recorder";

// ── Stubs ──

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeBlob {
  constructor(private readonly bytes: number[]) {}
  get size(): number {
    return this.bytes.length;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new Uint8Array(this.bytes).buffer);
  }
}

/** Minimal MediaRecorder: records what it was constructed with, fires on demand. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set(["video/webm;codecs=vp9", "video/webm"]);
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }

  state: "inactive" | "recording" = "inactive";
  timeslice: number | undefined;
  ondataavailable: ((event: { data: FakeBlob }) => void) | null = null;
  private stopListeners: (() => void)[] = [];

  constructor(
    readonly stream: FakeStream,
    readonly options: { mimeType: string },
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    // Real recorders emit a final chunk immediately before `stop`.
    this.emit([4, 5, 6]);
    for (const listener of [...this.stopListeners]) listener();
  }

  emit(bytes: number[]): void {
    this.ondataavailable?.({ data: new FakeBlob(bytes) });
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "stop") this.stopListeners.push(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== "stop") return;
    this.stopListeners = this.stopListeners.filter((l) => l !== listener);
  }
}

const getUserMedia = vi.fn<(constraints: unknown) => Promise<FakeStream>>();
const sendRecordingChunk = vi.fn();
const notifyRecordingStopped = vi.fn(() => Promise.resolve());

function lastRecorder(): FakeMediaRecorder {
  const recorder =
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
  if (!recorder) throw new Error("no MediaRecorder was constructed");
  return recorder;
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = new Set([
    "video/webm;codecs=vp9",
    "video/webm",
  ]);
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(() => Promise.resolve(new FakeStream()));
  sendRecordingChunk.mockReset();
  notifyRecordingStopped.mockReset();
  notifyRecordingStopped.mockImplementation(() => Promise.resolve());

  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("window", {
    ...globalThis.window,
    electronAPI: { webview: { sendRecordingChunk, notifyRecordingStopped } },
  });
});

afterEach(async () => {
  await stopAll();
  vi.unstubAllGlobals();
});

describe("startRecording", () => {
  it("requests the pane's media source and streams in one-second chunks", async () => {
    await startRecording("rec-1", "source-abc");

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0] as {
      audio: boolean;
      video: {
        mandatory: { chromeMediaSource: string; chromeMediaSourceId: string };
      };
    };
    expect(constraints.audio).toBe(false);
    expect(constraints.video.mandatory.chromeMediaSource).toBe("tab");
    expect(constraints.video.mandatory.chromeMediaSourceId).toBe("source-abc");

    const recorder = lastRecorder();
    expect(recorder.options.mimeType).toBe("video/webm;codecs=vp9");
    expect(recorder.timeslice).toBe(1000);
    expect(recorder.state).toBe("recording");
    expect(activeRecordingIds()).toEqual(["rec-1"]);
  });

  it("falls back to plain webm when vp9 is unsupported", async () => {
    FakeMediaRecorder.supported = new Set(["video/webm"]);
    await startRecording("rec-1", "source-abc");
    expect(lastRecorder().options.mimeType).toBe("video/webm");
  });

  it("forwards each chunk to main tagged with its recording id", async () => {
    await startRecording("rec-1", "source-abc");
    lastRecorder().emit([1, 2, 3]);
    await vi.waitFor(() => expect(sendRecordingChunk).toHaveBeenCalled());

    const [recordingId, buffer] = sendRecordingChunk.mock.calls[0];
    expect(recordingId).toBe("rec-1");
    expect([...new Uint8Array(buffer as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("ignores empty chunks", async () => {
    await startRecording("rec-1", "source-abc");
    lastRecorder().emit([]);
    await Promise.resolve();
    expect(sendRecordingChunk).not.toHaveBeenCalled();
  });

  it("stops the stream's tracks when the recorder cannot be constructed", async () => {
    const stream = new FakeStream();
    getUserMedia.mockResolvedValueOnce(stream);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported = () => true;
        constructor() {
          throw new Error("unsupported");
        }
      },
    );

    await expect(startRecording("rec-1", "source-abc")).rejects.toThrow(
      "unsupported",
    );
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(activeRecordingIds()).toEqual([]);
  });
});

describe("stopRecording", () => {
  it("flushes the trailing chunk, stops every track, then notifies main", async () => {
    await startRecording("rec-1", "source-abc");
    const stream = lastRecorder().stream;

    await stopRecording("rec-1");

    // The chunk emitted alongside `stop` must reach main before the notify.
    expect(sendRecordingChunk).toHaveBeenCalledWith(
      "rec-1",
      expect.anything(),
    );
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(notifyRecordingStopped).toHaveBeenCalledWith("rec-1");
    expect(
      sendRecordingChunk.mock.invocationCallOrder[0] <
        notifyRecordingStopped.mock.invocationCallOrder[0],
    ).toBe(true);
    expect(activeRecordingIds()).toEqual([]);
  });

  it("confirms unknown ids so main does not wait out its timeout", async () => {
    await stopRecording("never-started");
    expect(notifyRecordingStopped).toHaveBeenCalledWith("never-started");
  });

  it("stopAll stops every active recording", async () => {
    await startRecording("rec-1", "source-a");
    await startRecording("rec-2", "source-b");
    expect(activeRecordingIds()).toHaveLength(2);

    await stopAll();

    expect(activeRecordingIds()).toEqual([]);
    expect(notifyRecordingStopped).toHaveBeenCalledWith("rec-1");
    expect(notifyRecordingStopped).toHaveBeenCalledWith("rec-2");
  });
});

describe("handleRecordingCommand", () => {
  it("starts on a start command", async () => {
    await handleRecordingCommand({
      cmd: "start",
      recordingId: "rec-1",
      mediaSourceId: "source-abc",
    });
    expect(activeRecordingIds()).toEqual(["rec-1"]);
  });

  it("reports a failed capture to main instead of leaving it hanging", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("Permission denied"));

    await handleRecordingCommand({
      cmd: "start",
      recordingId: "rec-1",
      mediaSourceId: "source-abc",
    });

    expect(activeRecordingIds()).toEqual([]);
    expect(notifyRecordingStopped).toHaveBeenCalledWith(
      "rec-1",
      "Permission denied",
    );
  });

  it("stops on a stop command", async () => {
    await startRecording("rec-1", "source-abc");
    await handleRecordingCommand({ cmd: "stop", recordingId: "rec-1" });
    expect(activeRecordingIds()).toEqual([]);
    expect(notifyRecordingStopped).toHaveBeenCalledWith("rec-1");
  });
});
