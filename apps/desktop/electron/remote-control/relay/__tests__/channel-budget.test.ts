/**
 * Byte budget for PTY output the desktop sends over the relay for a pane the
 * viewer isn't showing (#733, Stage 0 of the output-channel plan).
 *
 * The phone and web app share the renderer's stream hook, so a viewer keeps
 * its `pty.output` subscription for a hidden pane and every byte of a flood
 * in it crosses the relay: JSON-encoded by the bridge, Noise-sealed and
 * batched by the channel. That is the most expensive place hidden output is
 * paid for, so it gets its own budget.
 *
 * Real `BridgeServer`, real `WsBridgeServer` hello gate, real `RelayChannel`
 * with a real Noise handshake against an in-test initiator; only the
 * connector is replaced, by a `sendPayload` that counts. No sockets, no
 * timers: each flood frame is past the channel's flush threshold, so it is
 * sealed and handed over synchronously.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SecureChannel,
  createInitiator,
  generateRelayIdentity,
  packBatches,
} from "@manor/protocol/relay-crypto";
import type { HostDeps } from "../../../ipc/types";
import { addRendererBroadcastSink } from "../../../renderer-broadcast";
import { DESKTOP_TABLE } from "../../../bridge/handlers";
import { BridgeServer } from "../../../bridge/server";
import { WsBridgeServer } from "../../../bridge/transports/ws";
import { RelayChannel } from "../channel";

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

describe("relay channel byte budget", () => {
  let server: BridgeServer<HostDeps>;
  let ws: WsBridgeServer;
  let channel: RelayChannel;
  /** Bytes the channel handed the connector for this viewer. */
  let sentBytes: number;

  beforeEach(() => {
    const deps = { getRendererWindows: () => [] } as unknown as HostDeps;
    server = new BridgeServer(deps, {
      table: { ...DESKTOP_TABLE, handlers: {} },
      events: addRendererBroadcastSink,
    });
    ws = new WsBridgeServer(server, {});
    sentBytes = 0;

    // The viewer: a Noise initiator against the desktop's relay key.
    const identity = generateRelayIdentity();
    let message2: Uint8Array | null = null;
    channel = new RelayChannel(1, {
      staticKey: identity.x25519,
      sendPayload: (payload, urgent) => {
        if (urgent) message2 = payload;
        else sentBytes += payload.length;
      },
      sendClose: () => {},
      // As the relay gate does, minus the device check: a paired phone.
      onReady: (ready) =>
        ws.attach(ready, () => ({
          ok: true,
          caller: { callerClass: "device", deviceId: "phone", deviceLabel: "Phone" },
        })),
    });
    const initiator = createInitiator(identity.x25519.pub);
    channel.receive(initiator.writeMessage1());
    const viewer = new SecureChannel(initiator.readMessage2(message2!), "viewer");
    const say = (frame: unknown): void => {
      for (const batch of packBatches(viewer.sealFrame(JSON.stringify(frame)))) {
        channel.receive(batch);
      }
    };

    // Hello, then the phone subscribes to a pane it shows and to one it
    // doesn't, as the shared stream hook leaves them today. Stage 2 changes
    // the second subscription to the light one a hidden pane will hold.
    say({ type: "hello", token: "device-token" });
    say({ kind: "subscribe", ns: "pty", event: "output", key: "shown" });
    say({ kind: "subscribe", ns: "pty", event: "output", key: "hidden" });
  });

  afterEach(() => {
    channel.close(1000, "done");
    ws.dispose();
    server.dispose();
  });

  /** Flood the hidden pane; bytes sent to the relay for it. */
  function floodHiddenPane(): number {
    sentBytes = 0;
    for (let seq = 1; seq <= FLOOD_CHUNKS; seq++) {
      server.handleStreamEvent({
        type: "data",
        sessionId: "hidden",
        data: FLOOD_CHUNK,
        seq,
      });
    }
    return sentBytes;
  }

  // Observed: 12,998,425 relay payload bytes for a 10,013,544-byte flood in a
  // pane the viewer isn't showing, 1.298× — the bridge's JSON (×1.30 for this
  // escape-dense line) plus Noise seal and batch overhead (the hello reply,
  // flushed with the first frame, is in it too: ~100 B). Ceiling 14.3 MB is
  // ~10% headroom. Over it means a phone pays more per byte of hidden output:
  // a fatter frame encoding, more seal or batch overhead, or a frame sent twice.
  it("sends the relay at most 14.3 MB for a 10 MB flood in a pane the viewer doesn't show", () => {
    const bytes = floodHiddenPane();
    expect(bytes).toBeGreaterThan(FLOOD_BYTES);
    expect(bytes).toBeLessThanOrEqual(14_300_000);
  });

  // Target for Stage 2, hidden panes stop receiving: the viewer's hidden
  // pane gets its titles and terminal queries, not its output, so ≤ 4 KB
  // crosses the relay for the whole flood. Fails today at ~13 MB; when
  // Stage 2 lands (and the subscription above is the one a hidden pane
  // really holds) this passes and becomes a plain `it`.
  it.fails("target: sends the relay at most 4 KB for a pane the viewer doesn't show, after hidden-pane unsubscribe", () => {
    expect(floodHiddenPane()).toBeLessThanOrEqual(4 * 1024);
  });
});
