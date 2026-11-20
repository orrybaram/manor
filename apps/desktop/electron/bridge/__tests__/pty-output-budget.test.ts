/**
 * Byte budget for PTY output that main sends to a renderer about a pane it
 * isn't showing (#733, Stage 0 of the output-channel plan).
 *
 * Since #676 a renderer keeps its `pty.output` subscription for a hidden
 * pane and holds what arrives (Held output), so main still forwards every
 * byte of a flood to it. This pins that cost on `BridgeServer`, the one place
 * every renderer's output passes, with a connection that only counts.
 *
 * Bytes here are the UTF-8 bytes of the output each `pty.output` frame
 * carries: what crosses IPC as the frame's string, before any transport's
 * own encoding. That keeps this budget about *whether* bytes are delivered;
 * how they are encoded is the stream-socket budget's job
 * (`terminal-host/__tests__/output-budget.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { HostDeps } from "../../ipc/types";
import { addRendererBroadcastSink } from "../../renderer-broadcast";
import { DESKTOP_TABLE } from "../handlers";
import { BridgeServer } from "../server";
import type { BridgeConnection, EventFrame } from "../types";

/** The overload benchmark's flood line (`tests/e2e/overload-perf.spec.ts`). */
const FLOOD_LINE =
  "\x1b[32m✓\x1b[0m \x1b[1mtool_result\x1b[0m src/components/SomethingLong.tsx:123 \x1b[33mwarning\x1b[0m lorem ipsum zqflood\r\n";
/** One helper batch: as many flood lines as fit in 64 KiB (65,448 bytes). */
const FLOOD_CHUNK = FLOOD_LINE.repeat(
  Math.floor((64 * 1024) / Buffer.byteLength(FLOOD_LINE)),
);
const CHUNK_BYTES = Buffer.byteLength(FLOOD_CHUNK);
/** A 10 MB flood: 153 batches, 10,013,544 bytes. */
const FLOOD_CHUNKS = Math.ceil(10_000_000 / CHUNK_BYTES);
const FLOOD_BYTES = CHUNK_BYTES * FLOOD_CHUNKS;

/** A connection that counts the output bytes it is sent, per pane. */
function countingConnection(id: string) {
  const outputBytes = new Map<string, number>();
  let frames = 0;
  const connection: BridgeConnection = {
    id,
    callerClass: "local",
    deviceId: null,
    deviceLabel: null,
    send: (frame) => {
      if (frame.kind !== "event") return;
      const event = frame as EventFrame;
      if (event.ns !== "pty" || event.event !== "output") return;
      frames++;
      const [data] = event.args as [string, number];
      const key = event.key ?? "";
      outputBytes.set(key, (outputBytes.get(key) ?? 0) + Buffer.byteLength(data));
    },
  };
  return {
    connection,
    bytesFor: (paneId: string) => outputBytes.get(paneId) ?? 0,
    frames: () => frames,
  };
}

describe("pty output byte budget (bridge)", () => {
  let server: BridgeServer<HostDeps>;

  beforeEach(() => {
    const deps = { getRendererWindows: () => [] } as unknown as HostDeps;
    server = new BridgeServer(deps, {
      table: { ...DESKTOP_TABLE, handlers: {} },
      events: addRendererBroadcastSink,
    });
  });

  afterEach(() => {
    server.dispose();
  });

  /**
   * A window with two panes, one shown and one in a background tab, the way
   * the renderer leaves them today: subscribed to both. Then the background
   * pane floods.
   */
  function floodHiddenPane() {
    const window = countingConnection("window");
    server.accept(window.connection);
    server.subscribe(window.connection, "pty", "output", "shown");
    // Stage 2 changes this line: a hidden pane holds only a light
    // subscription (facts, titles, queries), not `pty.output`.
    server.subscribe(window.connection, "pty", "output", "hidden");

    for (let seq = 1; seq <= FLOOD_CHUNKS; seq++) {
      server.handleStreamEvent({
        type: "data",
        sessionId: "hidden",
        data: FLOOD_CHUNK,
        seq,
      });
    }
    return window;
  }

  // Observed: 10,013,544 bytes in 153 frames for a 10,013,544-byte flood —
  // every byte of the hidden pane's output reaches the renderer. Ceiling
  // 11 MB is ~10% headroom. Over it means main sends a hidden pane *more*
  // than its output: a frame delivered twice, or a second subscription path.
  it("delivers at most 11 MB to a hidden pane's subscriber during a 10 MB flood", () => {
    const window = floodHiddenPane();
    expect(window.bytesFor("hidden")).toBeGreaterThan(0);
    expect(window.bytesFor("hidden")).toBeLessThanOrEqual(11_000_000);
    expect(window.bytesFor("shown")).toBe(0);
  });

  // Target for Stage 2, hidden panes stop receiving: a pane not shown gets
  // its titles and terminal queries, never its output — ≤ 4 KB for the whole
  // flood. Fails today at ~10 MB; when Stage 2 lands (and the subscription
  // in `floodHiddenPane` is the one a hidden pane really holds) this passes
  // and becomes a plain `it`.
  it.fails("target: delivers at most 4 KB to a hidden pane's subscriber after hidden-pane unsubscribe", () => {
    const window = floodHiddenPane();
    expect(window.bytesFor("hidden")).toBeLessThanOrEqual(4 * 1024);
  });

  it("floods the stated amount", () => {
    // The budgets above are only as meaningful as the flood is big.
    expect(FLOOD_BYTES).toBe(10_013_544);
    expect(floodHiddenPane().frames()).toBe(FLOOD_CHUNKS);
  });
});
