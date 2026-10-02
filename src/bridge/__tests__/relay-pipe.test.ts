/**
 * The relay pipe under the real transport and client (ADR-206 D2, D3),
 * against a fake relay socket with the real Noise responder behind it.
 *
 * What `ws.test.ts` proves for the plain WebSocket — the hello, the outbox,
 * replay after a reconnect — is the same code here; these tests check it
 * still holds when every frame is ciphertext, and add what only the relay
 * has: the handshake, the reachability codes, and which failures forget the
 * pairing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createBridge } from "../client";
import {
  HANDSHAKE_TIMEOUT_MS,
  KEY_MISMATCH_THRESHOLD,
  relayJoinUrl,
  relayPipe,
} from "../transports/relay-pipe";
import { createWsTransport, type WsTransportOptions } from "../transports/ws";
import type { ElectronAPI } from "../../electron";
import {
  CLOSE_IDLE,
  HEARTBEAT_INTERVAL_MS,
  MAX_RELAY_PAYLOAD_BYTES,
} from "../../lib/relay-crypto/protocol";
import { desktopKey, FakeRelaySocket, type Frame } from "./fake-relay";

function last(frames: Frame[]): Frame {
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error("no frame of that kind was sent");
  return frame;
}

describe("the relay pipe", () => {
  let options: Required<
    Pick<WsTransportOptions, "onUnauthorized" | "onStatus" | "onHello">
  >;

  function bridge(extra: Partial<WsTransportOptions> = {}): {
    api: ElectronAPI;
    retryNow: () => void;
  } {
    const transport = createWsTransport({
      token: "full-token",
      pipe: relayPipe({
        url: "wss://relay.test/join/room",
        serverKey: FakeRelaySocket.key.pub,
      }),
      ...options,
      ...extra,
    });
    return {
      api: createBridge(transport),
      retryNow: () => transport.retryNow(),
    };
  }

  function connected(): { api: ElectronAPI; socket: FakeRelaySocket } {
    const { api } = bridge();
    void api.projects.getAll().catch(() => {});
    const socket = FakeRelaySocket.last;
    socket.handshake();
    return { api, socket };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeRelaySocket.instances = [];
    FakeRelaySocket.key = desktopKey();
    vi.stubGlobal("WebSocket", FakeRelaySocket);
    options = {
      onUnauthorized: vi.fn(),
      onStatus: vi.fn(),
      onHello: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("derives the join URL from the page's origin", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "relay.example" });
    expect(relayJoinUrl("abc_-")).toBe("wss://relay.example/join/abc_-");
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:8787" });
    expect(relayJoinUrl("r")).toBe("ws://localhost:8787/join/r");
  });

  describe("handshake", () => {
    it("asks for binary and sends Noise message 1 on open, nothing else", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeRelaySocket.last;
      expect(socket.url).toBe("wss://relay.test/join/room");
      expect(socket.binaryType).toBe("arraybuffer");
      socket.accept();
      expect(socket.sent).toHaveLength(1);
      // NK message 1 with an empty payload: e (32) + tag (16).
      expect(socket.sent[0].length).toBe(48);
    });

    it("says hello as the first transport message, then flushes calls", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeRelaySocket.last;
      socket.accept();
      socket.respond();
      expect(socket.frames).toEqual([{ type: "hello", token: "full-token" }]);
      expect(socket.of("invoke")).toHaveLength(0);
      socket.deliver({ type: "hello", ok: true, v: 1, rendererId: "r-1" });
      expect(socket.of("invoke")).toHaveLength(1);
      expect(options.onStatus).toHaveBeenLastCalledWith("connected");
    });

    it("hands the host's appVersion to onHello", () => {
      connected();
      expect(options.onHello).toHaveBeenCalledWith({
        rendererId: "r-1",
        appVersion: null,
      });
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      FakeRelaySocket.last.handshake({ appVersion: "9.9.9" });
      expect(options.onHello).toHaveBeenLastCalledWith({
        rendererId: "r-1",
        appVersion: "9.9.9",
      });
    });

    it("reconnects, without forgetting anything, on a message 2 that does not authenticate", async () => {
      const onKeyMismatch = vi.fn();
      const { api } = bridge({ onKeyMismatch });
      const call = api.projects.getAll();
      const socket = FakeRelaySocket.last;
      socket.accept();
      // Well-formed but not from this desktop's key: far more likely stale
      // bytes for a previous viewer on this channel than an impostor.
      socket.deliverRaw(new Uint8Array(48).fill(7));
      await expect(call).rejects.toThrow();
      expect(socket.closedWith).not.toBeNull();
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      expect(onKeyMismatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    /** One dial answered with a bad message 2, then the backoff waited out. */
    function badHandshake(): void {
      const socket = FakeRelaySocket.last;
      socket.accept();
      socket.deliverRaw(new Uint8Array(48).fill(7));
      vi.advanceTimersByTime(30_000);
    }

    it(`asks to re-pair after ${KEY_MISMATCH_THRESHOLD} bad message 2s in a row, and stops`, () => {
      const onKeyMismatch = vi.fn();
      const { api } = bridge({ onKeyMismatch });
      void api.projects.getAll().catch(() => {});
      for (let i = 0; i < KEY_MISMATCH_THRESHOLD; i++) badHandshake();
      expect(onKeyMismatch).toHaveBeenCalledOnce();
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      const dials = FakeRelaySocket.instances.length;
      vi.advanceTimersByTime(120_000);
      expect(FakeRelaySocket.instances).toHaveLength(dials);
    });

    it("starts the count again after a good handshake", () => {
      const onKeyMismatch = vi.fn();
      const { api } = bridge({ onKeyMismatch });
      void api.projects.getAll().catch(() => {});
      for (let i = 0; i < KEY_MISMATCH_THRESHOLD - 1; i++) badHandshake();
      FakeRelaySocket.last.handshake();
      FakeRelaySocket.last.drop(1006);
      vi.advanceTimersByTime(1_000);
      for (let i = 0; i < KEY_MISMATCH_THRESHOLD - 1; i++) badHandshake();
      expect(onKeyMismatch).not.toHaveBeenCalled();
    });

    it("without onKeyMismatch, reports unreachable and keeps dialling", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      for (let i = 0; i < KEY_MISMATCH_THRESHOLD - 1; i++) badHandshake();
      const dials = FakeRelaySocket.instances.length;
      badHandshake();
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      expect(FakeRelaySocket.instances).toHaveLength(dials + 1);
    });

    it("reconnects, without forgetting anything, on a malformed message 2", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeRelaySocket.last;
      socket.accept();
      socket.deliverRaw(new Uint8Array(10));
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    it("gives up on a desktop that never answers, says so, and dials again", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeRelaySocket.last;
      socket.accept();
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
      expect(socket.closedWith).not.toBeNull();
      // An asleep desktop behind a half-open host socket: not reachable.
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
      expect(options.onUnauthorized).not.toHaveBeenCalled();
    });
  });

  describe("after the handshake", () => {
    it("round-trips an invoke as ciphertext", async () => {
      const { api, socket } = connected();
      const pending = api.projects.select(2);
      const frame = last(socket.of("invoke"));
      expect(frame).toMatchObject({
        ns: "projects",
        method: "select",
        args: [2],
      });
      socket.deliver({ id: frame.id, kind: "result", ok: true, result: "ok" });
      await expect(pending).resolves.toBe("ok");
      // Nothing on the wire is the plaintext.
      const wire = new TextDecoder().decode(
        socket.sent[socket.sent.length - 1],
      );
      expect(wire).not.toContain("projects");
    });

    it("delivers every frame of a coalesced batch, in order", () => {
      const { api, socket } = connected();
      const seen: unknown[] = [];
      api.pty.onOutput("pane-1", (data: string) => seen.push(data));
      // Two event frames in one relay message, as the desktop coalesces them.
      const before = socket.sent.length;
      socket.deliverBatch(
        ["a", "b"].map((data, seq) => ({
          kind: "event",
          ns: "pty",
          event: "output",
          key: "pane-1",
          args: [data, seq],
        })),
      );
      expect(socket.sent.length).toBe(before);
      expect(seen).toEqual(["a", "b"]);
    });

    it("splits a frame larger than one relay message across batches", () => {
      const { api, socket } = connected();
      const before = socket.sent.length;
      void api.pty
        .write("pane-1", "x".repeat(1024 * 1024 - 200))
        .catch(() => {});
      const sent = socket.sent.slice(before);
      expect(sent.length).toBeGreaterThan(1);
      for (const message of sent) {
        expect(message.length).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
      }
      expect(last(socket.of("invoke"))).toMatchObject({ method: "write" });
    });

    it("reconnects on a batch that fails to decrypt, without forgetting", () => {
      const { socket } = connected();
      socket.deliverRaw(Uint8Array.of(0, 0, 0, 20, ...new Uint8Array(20)));
      expect(socket.closedWith).not.toBeNull();
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    it("refuses a text message from the relay", () => {
      const { socket } = connected();
      socket.deliverText("{}");
      expect(socket.closedWith).not.toBeNull();
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    it("replays subscriptions over a fresh Noise session after a reconnect", () => {
      const { api, socket } = connected();
      api.pty.onOutput("pane-1", () => {});
      expect(socket.of("subscribe")).toHaveLength(1);
      socket.drop(1006);
      vi.advanceTimersByTime(1_000);
      const next = FakeRelaySocket.last;
      expect(next).not.toBe(socket);
      next.handshake();
      expect(next.frames[0]).toEqual({
        type: "hello",
        token: "full-token",
        previousId: "r-1",
      });
      expect(next.of("subscribe")).toEqual([
        { kind: "subscribe", ns: "pty", event: "output", key: "pane-1" },
      ]);
    });
  });

  describe("bridge close codes through the relay", () => {
    function rejected(): { api: ElectronAPI; socket: FakeRelaySocket } {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      const socket = FakeRelaySocket.last;
      socket.accept();
      socket.respond();
      expect(socket.frames).toEqual([{ type: "hello", token: "full-token" }]);
      return { api, socket };
    }

    it("treats a 4401 from the desktop as unauthorised", () => {
      rejected().socket.hostClose(4401);
      expect(options.onUnauthorized).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(60_000);
      expect(FakeRelaySocket.instances).toHaveLength(1);
    });

    it("reconnects on a desktop close the relay does not pass through", () => {
      rejected().socket.hostClose(4999);
      expect(options.onUnauthorized).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(FakeRelaySocket.instances.length).toBeGreaterThan(1);
    });
  });

  describe("heartbeat", () => {
    it("pings the room every interval while it answers", () => {
      const { socket } = connected();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.pings).toBe(1);
      socket.pong();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.pings).toBe(2);
      socket.pong();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.closedWith).toBeNull();
    });

    it("counts any data from the relay as an answer", () => {
      const { socket } = connected();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      socket.deliver({ kind: "event", ns: "x", event: "y", args: [] });
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.closedWith).toBeNull();
    });

    it("treats an interval with nothing back as unreachable, and redials", () => {
      const { socket } = connected();
      vi.advanceTimersByTime(2 * HEARTBEAT_INTERVAL_MS);
      expect(socket.closedWith).not.toBeNull();
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });
  });

  describe("reachability", () => {
    it("treats the room reaping this socket (4410) as unreachable", () => {
      connected().socket.drop(CLOSE_IDLE);
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");
    });

    it("treats 4404 as unreachable and retries with backoff", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      FakeRelaySocket.last.drop(4404);
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");

      vi.advanceTimersByTime(999);
      expect(FakeRelaySocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeRelaySocket.instances).toHaveLength(2);

      FakeRelaySocket.last.drop(4404);
      vi.advanceTimersByTime(1_999);
      expect(FakeRelaySocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(FakeRelaySocket.instances).toHaveLength(3);

      FakeRelaySocket.last.handshake();
      expect(options.onStatus).toHaveBeenLastCalledWith("connected");
      expect(options.onUnauthorized).not.toHaveBeenCalled();
    });

    it("treats 4429 the same way", () => {
      const { api } = bridge();
      void api.projects.getAll().catch(() => {});
      FakeRelaySocket.last.drop(4429);
      expect(options.onStatus).toHaveBeenLastCalledWith("unreachable");
      vi.advanceTimersByTime(1_000);
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    it("retryNow skips the backoff wait", () => {
      const { api, retryNow } = bridge();
      void api.projects.getAll().catch(() => {});
      FakeRelaySocket.last.drop(4404);
      retryNow();
      expect(FakeRelaySocket.instances).toHaveLength(2);
      // And does nothing while a dial is already in flight.
      retryNow();
      expect(FakeRelaySocket.instances).toHaveLength(2);
    });

    it("does not call an ordinary drop unreachable", () => {
      connected().socket.drop(1006);
      expect(options.onStatus).not.toHaveBeenCalledWith("unreachable");
    });
  });
});
