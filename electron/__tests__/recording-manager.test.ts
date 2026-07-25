import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RecordingManager } from "../recording-manager";

/**
 * Shape of the injected keyframe capture. A bare `vi.fn()` infers as
 * `Mock<Procedure | Constructable>`, which does not satisfy this signature, so
 * every capture mock is instantiated with this type explicitly.
 */
type CaptureFn = () => Promise<string>;

/** Poll until `predicate` holds, or fail the test on timeout. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("RecordingManager", () => {
  let tmpDir: string;
  let manager: RecordingManager;
  let capture: Mock<CaptureFn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-recording-test-"));
    manager = new RecordingManager();
    capture = vi.fn<CaptureFn>(async () => "AAAA");
  });

  afterEach(async () => {
    await manager.stopAll();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function out(name: string): string {
    return path.join(tmpDir, name);
  }

  describe("start()", () => {
    it("opens a stream at an absolute path and reports it", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      expect(recordingId).toMatch(/[0-9a-f-]{36}/);
      expect(path.isAbsolute(outPath)).toBe(true);
      expect(outPath).toBe(out("clip.webm"));

      manager.appendChunk(recordingId, Buffer.from("hello"));
      await manager.stop(recordingId);

      expect(fs.readFileSync(outPath, "utf8")).toBe("hello");
    });

    it("appends .webm when the given path has no extension", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip"),
        capture,
      });

      expect(outPath).toBe(out("clip.webm"));
      await manager.stop(recordingId);
      expect(fs.existsSync(outPath)).toBe(true);
    });

    it("creates missing parent directories", async () => {
      const nested = path.join(tmpDir, "a", "b", "c", "clip.webm");
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: nested,
        capture,
      });

      expect(fs.existsSync(path.dirname(nested))).toBe(true);
      await manager.stop(recordingId);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it("defaults to <manorDataDir>/recordings/<recordingId>.webm", async () => {
      vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        capture,
      });

      expect(outPath).toContain(path.join("Manor", "recordings"));
      expect(outPath.startsWith(tmpDir)).toBe(true);
      expect(path.basename(outPath)).toBe(`${recordingId}.webm`);

      await manager.stop(recordingId);
    });

    it("throws when the pane already has an active recording", async () => {
      manager.start({ paneId: "pane-1", path: out("a.webm"), capture });

      expect(() =>
        manager.start({ paneId: "pane-1", path: out("b.webm"), capture }),
      ).toThrow(/already has an active recording/);

      // A different pane is fine.
      expect(() =>
        manager.start({ paneId: "pane-2", path: out("b.webm"), capture }),
      ).not.toThrow();
    });

    it("clamps maxDurationSec to [1, 600] with a default of 120", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const delays = (): number[] =>
        setTimeoutSpy.mock.calls.map((call) => call[1] as number);

      manager.start({ paneId: "pane-default", path: out("d.webm"), capture });
      expect(delays()).toContain(120_000);

      manager.start({
        paneId: "pane-huge",
        path: out("h.webm"),
        maxDurationSec: 10_000,
        capture,
      });
      expect(delays()).toContain(600_000);

      manager.start({
        paneId: "pane-tiny",
        path: out("t.webm"),
        maxDurationSec: 0,
        capture,
      });
      expect(delays()).toContain(1_000);
    });
  });

  describe("appendChunk()", () => {
    it("accumulates bytes across chunks", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      manager.appendChunk(recordingId, Buffer.from("abc"));
      manager.appendChunk(recordingId, Buffer.from("defgh"));

      const result = await manager.stop(recordingId);
      expect(result?.bytes).toBe(8);
      expect(fs.readFileSync(outPath, "utf8")).toBe("abcdefgh");
    });

    it("silently ignores unknown ids", async () => {
      expect(() =>
        manager.appendChunk("nope", Buffer.from("late chunk")),
      ).not.toThrow();
    });

    it("silently ignores a chunk that arrives after stop", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });
      manager.appendChunk(recordingId, Buffer.from("abc"));
      await manager.stop(recordingId);

      manager.appendChunk(recordingId, Buffer.from("late"));
      expect(fs.readFileSync(outPath, "utf8")).toBe("abc");
    });

    it("returns true while the stream is keeping up", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      expect(manager.appendChunk(recordingId, Buffer.from("abc"))).toBe(true);
    });

    it("returns true for ids it drops, so a caller never waits on them", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });
      await manager.stop(recordingId);

      expect(manager.appendChunk(recordingId, Buffer.from("late"))).toBe(true);
      expect(manager.appendChunk("nope", Buffer.from("late"))).toBe(true);
    });

    it("signals backpressure past the high-water mark and clears it on drain", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      // Well past the 64 KiB high-water mark of an fs write stream, so the
      // stream buffers rather than accepting it outright.
      const big = Buffer.alloc(1024 * 1024, 0x61);
      expect(manager.appendChunk(recordingId, big)).toBe(false);

      await manager.waitForDrain(recordingId);

      // Drained: the stream takes writes without buffering again.
      expect(manager.appendChunk(recordingId, Buffer.from("tail"))).toBe(true);

      const result = await manager.stop(recordingId);
      expect(result?.bytes).toBe(big.length + 4);
      expect(fs.statSync(outPath).size).toBe(big.length + 4);
    });

    it("waitForDrain resolves immediately for unknown and stopped ids", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });
      await manager.stop(recordingId);

      // Would hang forever if it waited on a stream that will never drain.
      await manager.waitForDrain(recordingId);
      await manager.waitForDrain("nope");
    });
  });

  describe("stop()", () => {
    it("resolves only after the stream has flushed to disk", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });
      // Enough data that the write cannot complete synchronously.
      const chunk = Buffer.alloc(512 * 1024, 1);
      manager.appendChunk(recordingId, chunk);
      manager.appendChunk(recordingId, chunk);

      const result = await manager.stop(recordingId);

      expect(result).not.toBeNull();
      expect(fs.statSync(outPath).size).toBe(chunk.length * 2);
      expect(result?.bytes).toBe(chunk.length * 2);
      expect(result?.durationMs).toBeGreaterThanOrEqual(0);
      expect(result?.paneId).toBe("pane-1");
      expect(result?.path).toBe(outPath);
    });

    it("returns the keyframes collected while recording", async () => {
      let frame = 0;
      const capturing = vi.fn<CaptureFn>(async () => `frame-${frame++}`);
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        keyframeIntervalSec: 0.01,
        capture: capturing,
      });

      await waitFor(() => capturing.mock.calls.length >= 3, "3 captures");
      const result = await manager.stop(recordingId);

      expect(result?.keyframes.length).toBeGreaterThanOrEqual(3);
      expect(result?.keyframes[0]).toBe("frame-0");
    });

    it("caps keyframes at 8 and stops capturing afterwards", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        keyframeIntervalSec: 0.01,
        capture,
      });

      await waitFor(() => capture.mock.calls.length >= 8, "8 captures");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const callsAfterCap = capture.mock.calls.length;

      const result = await manager.stop(recordingId);
      expect(result?.keyframes).toHaveLength(8);
      // The interval was cleared once the cap was hit — no runaway capturing.
      expect(callsAfterCap).toBeLessThanOrEqual(9);
    });

    it("clears the keyframe timer so capture is never called after stop", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        keyframeIntervalSec: 0.01,
        capture,
      });

      await waitFor(() => capture.mock.calls.length >= 2, "2 captures");
      await manager.stop(recordingId);
      const callsAtStop = capture.mock.calls.length;

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(capture.mock.calls.length).toBe(callsAtStop);
    });

    it("returns null for an unknown id", async () => {
      await expect(manager.stop("not-a-recording")).resolves.toBeNull();
    });

    it("returns null on a second stop of the same recording", async () => {
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      expect(await manager.stop(recordingId)).not.toBeNull();
      expect(await manager.stop(recordingId)).toBeNull();
    });

    it("frees the pane for a new recording", async () => {
      const first = manager.start({
        paneId: "pane-1",
        path: out("a.webm"),
        capture,
      });
      await manager.stop(first.recordingId);

      expect(() =>
        manager.start({ paneId: "pane-1", path: out("b.webm"), capture }),
      ).not.toThrow();
    });
  });

  describe("keyframe failures", () => {
    it("swallows a rejecting capture and keeps recording", async () => {
      const failing = vi.fn<CaptureFn>(async () => {
        throw new Error("webview destroyed");
      });
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        keyframeIntervalSec: 0.01,
        capture: failing,
      });

      await waitFor(() => failing.mock.calls.length >= 3, "3 failed captures");

      // The recording is still live and still accepting chunks.
      expect(manager.list().map((r) => r.recordingId)).toContain(recordingId);
      manager.appendChunk(recordingId, Buffer.from("still-here"));

      const result = await manager.stop(recordingId);
      expect(result?.keyframes).toEqual([]);
      expect(result?.bytes).toBe("still-here".length);
      expect(fs.readFileSync(outPath, "utf8")).toBe("still-here");
    });

    it("keeps frames captured before a failure starts", async () => {
      let calls = 0;
      const flaky = vi.fn<CaptureFn>(async () => {
        calls += 1;
        if (calls > 1) throw new Error("nope");
        return "frame-0";
      });
      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        keyframeIntervalSec: 0.01,
        capture: flaky,
      });

      await waitFor(() => calls >= 3, "3 captures");
      const result = await manager.stop(recordingId);
      expect(result?.keyframes).toEqual(["frame-0"]);
    });
  });

  describe("auto-stop", () => {
    it("fires the listener and finalizes the recording", async () => {
      const events: Array<{ recordingId: string; paneId: string }> = [];
      manager.onAutoStop((event) => {
        events.push(event);
      });

      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        maxDurationSec: 0.001, // clamped up to the 1s floor
        capture,
      });
      manager.appendChunk(recordingId, Buffer.from("abc"));

      await waitFor(() => events.length === 1, "auto-stop event", 3000);
      expect(events[0]).toEqual({ recordingId, paneId: "pane-1" });

      await waitFor(() => manager.list().length === 0, "recording finalized");
      expect(fs.readFileSync(outPath, "utf8")).toBe("abc");
      // Finalized: an explicit stop afterwards is a no-op.
      expect(await manager.stop(recordingId)).toBeNull();
    });

    it("lets a listener flush a final chunk before the stream closes", async () => {
      manager.onAutoStop(async (event) => {
        // Stand-in for round-tripping "stop your MediaRecorder" to the renderer.
        await new Promise((resolve) => setTimeout(resolve, 10));
        manager.appendChunk(event.recordingId, Buffer.from("tail"));
      });

      const started = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        maxDurationSec: 1,
        capture,
      });
      manager.appendChunk(started.recordingId, Buffer.from("head-"));

      await waitFor(() => manager.list().length === 0, "auto-stop", 3000);
      expect(fs.readFileSync(started.path, "utf8")).toBe("head-tail");
    });

    it("finalizes even when a listener throws", async () => {
      manager.onAutoStop(() => {
        throw new Error("listener blew up");
      });

      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        maxDurationSec: 1,
        capture,
      });
      manager.appendChunk(recordingId, Buffer.from("abc"));

      await waitFor(() => manager.list().length === 0, "auto-stop", 3000);
      expect(fs.readFileSync(outPath, "utf8")).toBe("abc");
    });

    it("does not fire after an explicit stop", async () => {
      const events: string[] = [];
      manager.onAutoStop((event) => {
        events.push(event.recordingId);
      });

      const { recordingId } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        maxDurationSec: 1,
        capture,
      });
      await manager.stop(recordingId);

      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(events).toEqual([]);
    });

    it("onAutoStop returns a disposer", async () => {
      const listener = vi.fn();
      const dispose = manager.onAutoStop(listener);
      dispose();

      manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        maxDurationSec: 1,
        capture,
      });

      await waitFor(() => manager.list().length === 0, "auto-stop", 3000);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("stopForPane()", () => {
    it("stops the recording belonging to a pane", async () => {
      const a = manager.start({
        paneId: "pane-a",
        path: out("a.webm"),
        capture,
      });
      const b = manager.start({
        paneId: "pane-b",
        path: out("b.webm"),
        capture,
      });
      manager.appendChunk(a.recordingId, Buffer.from("aaa"));

      const result = await manager.stopForPane("pane-a");
      expect(result?.recordingId).toBe(a.recordingId);
      expect(fs.readFileSync(a.path, "utf8")).toBe("aaa");
      expect(manager.list().map((r) => r.recordingId)).toEqual([b.recordingId]);
    });

    it("returns null when the pane has no recording", async () => {
      await expect(manager.stopForPane("pane-none")).resolves.toBeNull();
    });
  });

  describe("stopAll()", () => {
    it("closes every stream and empties the registry", async () => {
      const a = manager.start({
        paneId: "pane-a",
        path: out("a.webm"),
        keyframeIntervalSec: 0.01,
        capture,
      });
      const b = manager.start({
        paneId: "pane-b",
        path: out("b.webm"),
        keyframeIntervalSec: 0.01,
        capture,
      });
      manager.appendChunk(a.recordingId, Buffer.from("aaa"));
      manager.appendChunk(b.recordingId, Buffer.from("bbbb"));

      const results = await manager.stopAll();

      expect(results).toHaveLength(2);
      expect(manager.list()).toEqual([]);
      expect(fs.readFileSync(a.path, "utf8")).toBe("aaa");
      expect(fs.readFileSync(b.path, "utf8")).toBe("bbbb");
      expect(results.map((r) => r.bytes).sort()).toEqual([3, 4]);

      // Both keyframe timers were cleared.
      const callsAtStop = capture.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(capture.mock.calls.length).toBe(callsAtStop);
    });

    it("is a no-op when nothing is recording", async () => {
      await expect(manager.stopAll()).resolves.toEqual([]);
    });
  });

  describe("list()", () => {
    it("reports active recordings with elapsed time", async () => {
      const { recordingId, path: outPath } = manager.start({
        paneId: "pane-1",
        path: out("clip.webm"),
        capture,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const [entry] = manager.list();

      expect(entry.recordingId).toBe(recordingId);
      expect(entry.paneId).toBe("pane-1");
      expect(entry.path).toBe(outPath);
      expect(entry.elapsedMs).toBeGreaterThan(0);
    });

    it("is empty before anything starts", () => {
      expect(manager.list()).toEqual([]);
    });
  });
});
