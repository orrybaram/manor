import {
  SELF,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_IDLE,
  CLOSE_LIMIT,
  CLOSE_NORMAL,
  CLOSE_NO_HOST,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_TOO_BIG,
  CLOSE_UNSUPPORTED_DATA,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MAX_CHANNELS,
  MAX_RELAY_PAYLOAD_BYTES,
  OP_CLOSE,
  OP_DATA,
  OP_OPEN,
} from "../../src/lib/relay-crypto/protocol";
import {
  authMessage,
  frame,
  freshIp,
  join,
  liveHost,
  newIdentity,
  openHost,
  upgrade,
} from "./helpers";

/** Matches `RELAY_DAILY_BYTES` in vitest.config.ts. */
const TEST_DAILY_BYTES = 65536;
/** Matches `RELAY_STALE_MS` in vitest.config.ts. */
const TEST_STALE_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function roomStub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromName(roomId));
}

describe("routing", () => {
  it("404s malformed room ids, unknown paths and /app", async () => {
    for (const path of [
      "/host/short",
      "/join/aaaaaaaaaaaaaaaaaaaaaaa", // 23 chars
      "/join/aaaaaaaaaaaaaaaaaaaa+a",
      "/host/aaaaaaaaaaaaaaaaaaaaaa/extra",
      "/",
      "/app/0.13.2/index.html",
      "/app",
    ]) {
      const res = await upgrade(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("426s a valid room path without a WebSocket upgrade", async () => {
    const { roomId } = newIdentity();
    const res = await fetchPlain(`/join/${roomId}`);
    expect(res.status).toBe(426);
  });

  it("rate-limits /join per client IP before the upgrade", async () => {
    const { roomId } = newIdentity();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await upgrade(`/join/${roomId}`, { "CF-Connecting-IP": ip });
      statuses.push(res.status);
      if (res.webSocket) {
        res.webSocket.accept();
        res.webSocket.close();
      }
    }
    expect(statuses).toContain(101);
    expect(statuses.at(-1)).toBe(429);
    // Another IP is unaffected.
    const other = await join(roomId);
    expect((await other.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });

  it("rate-limits /host per client IP, separately from /join", async () => {
    const { roomId } = newIdentity();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await upgrade(`/host/${roomId}`, { "CF-Connecting-IP": ip });
      statuses.push(res.status);
      if (res.webSocket) {
        res.webSocket.accept();
        res.webSocket.close();
      }
    }
    expect(statuses).toContain(101);
    expect(statuses.at(-1)).toBe(429);
    // The same IP may still join: the two routes count apart.
    const viewer = await join(roomId, ip);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });
});

function fetchPlain(path: string): Promise<Response> {
  return SELF.fetch("https://relay.test" + path);
}

describe("host auth", () => {
  it("accepts a signature from the key that owns the room", async () => {
    const { identity, roomId } = newIdentity();
    const { sock, challenge } = await openHost(roomId);
    expect(challenge.length).toBe(32);
    sock.send(authMessage(identity, roomId, challenge));
    expect(await sock.nextJson()).toEqual({ t: "ok" });
    expect(sock.isClosed()).toBe(false);
  });

  it("refuses a bad signature with 4401", async () => {
    const { identity, roomId } = newIdentity();
    const { sock, challenge } = await openHost(roomId);
    const wrong = challenge.slice();
    wrong[0] ^= 1;
    sock.send(authMessage(identity, roomId, wrong));
    expect((await sock.waitClosed()).code).toBe(CLOSE_AUTH_FAILED);
  });

  it("refuses a valid signature from a key that does not own the room", async () => {
    const { roomId } = newIdentity();
    const other = newIdentity();
    const { sock, challenge } = await openHost(roomId);
    // Signed over the right room and challenge, but pub hashes elsewhere.
    sock.send(authMessage(other.identity, roomId, challenge));
    expect((await sock.waitClosed()).code).toBe(CLOSE_AUTH_FAILED);
  });

  it("refuses malformed auth messages with 4401", async () => {
    const { roomId } = newIdentity();
    for (const bad of [
      "not json",
      JSON.stringify({ t: "auth" }),
      JSON.stringify({ t: "auth", pub: "!!", sig: "!!" }),
      new Uint8Array([1, 2, 3]),
    ]) {
      const { sock } = await openHost(roomId);
      sock.send(bad);
      expect((await sock.waitClosed()).code).toBe(CLOSE_AUTH_FAILED);
    }
  });

  it("closes a host that does not authenticate within 5 s (4408)", async () => {
    const { roomId } = newIdentity();
    const { sock } = await openHost(roomId);
    const closed = await sock.waitClosed(8000);
    expect(closed.code).toBe(CLOSE_AUTH_TIMEOUT);
  }, 10_000);

  it("keeps the challenge across hibernation", async () => {
    const { identity, roomId } = newIdentity();
    const { sock, challenge } = await openHost(roomId);
    await evictDurableObject(env.ROOM.get(env.ROOM.idFromName(roomId)));
    sock.send(authMessage(identity, roomId, challenge));
    expect(await sock.nextJson()).toEqual({ t: "ok" });
  });

  it("replaces the previous host (4409) and closes its viewers", async () => {
    const { identity, roomId } = newIdentity();
    const first = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await first.nextBytes()).toEqual(frame(OP_OPEN, 1));

    const second = await liveHost(identity, roomId);
    expect((await first.waitClosed()).code).toBe(CLOSE_REPLACED);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);

    const next = await join(roomId);
    expect(await second.nextBytes()).toEqual(frame(OP_OPEN, 2));
    next.send(new Uint8Array([9]));
    expect(await second.nextBytes()).toEqual(frame(OP_DATA, 2, [9]));
  });
});

describe("viewers", () => {
  it("refuses a join with no host (4404)", async () => {
    const { roomId } = newIdentity();
    const viewer = await join(roomId);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });

  it("refuses a join while the host has not authenticated (4404)", async () => {
    const { roomId } = newIdentity();
    await openHost(roomId);
    const viewer = await join(roomId);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });

  it("pipes open, data and close on two channels with bytes unchanged", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);

    const a = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    const b = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 2));

    const all = Array.from({ length: 256 }, (_, i) => i);
    a.send(Uint8Array.from(all));
    expect(await host.nextBytes()).toEqual(frame(OP_DATA, 1, all));
    b.send(new Uint8Array([0, 0xff, 0]));
    expect(await host.nextBytes()).toEqual(frame(OP_DATA, 2, [0, 0xff, 0]));

    host.send(frame(OP_DATA, 2, [7, 8, 9]));
    expect(await b.nextBytes()).toEqual(new Uint8Array([7, 8, 9]));
    host.send(frame(OP_DATA, 1, all.slice().reverse()));
    expect(await a.nextBytes()).toEqual(Uint8Array.from(all.reverse()));
    // An empty payload is still a message.
    host.send(frame(OP_DATA, 1));
    expect(await a.nextBytes()).toEqual(new Uint8Array(0));
    expect(await b.quiet()).toBe(true);

    // Viewer closes → host hears OP_CLOSE for its channel.
    a.close();
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));

    // Host closes a channel → that viewer is closed 1000.
    host.send(frame(OP_CLOSE, 2));
    expect((await b.waitClosed()).code).toBe(CLOSE_NORMAL);

    // Channels rotate: a freed number is not handed straight back out.
    await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 3));
  });

  it("never gives a departed viewer's channel to the next viewer", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const a = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    a.close();
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));

    const b = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 2));
    // A frame the host had in flight for A's channel goes nowhere near B.
    host.send(frame(OP_DATA, 1, [0xaa]));
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));
    expect(await b.quiet()).toBe(true);
  });

  it("keeps the channel rotation across eviction", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const a = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    a.close();
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));
    await evictDurableObject(roomStub(roomId));
    await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 2));
  });

  it("acknowledges every host message with its length", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    host.send(frame(OP_DATA, 1, [1, 2, 3, 4]));
    expect(await viewer.nextBytes()).toEqual(Uint8Array.of(1, 2, 3, 4));
    host.send(frame(OP_DATA, 77, [5]));
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 77));
    host.send(frame(OP_CLOSE, 1));
    await viewer.waitClosed();
    expect(host.acks).toEqual([7, 4, 3]);
  });

  it("answers data for an unknown channel with OP_CLOSE", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    host.send(frame(OP_DATA, 300, [1]));
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 300));
  });

  describe("host OP_CLOSE with a close code", () => {
    const be = (code: number) => [(code >> 8) & 0xff, code & 0xff];

    async function closedWith(payload?: number[]): Promise<number> {
      const { identity, roomId } = newIdentity();
      const host = await liveHost(identity, roomId);
      const viewer = await join(roomId);
      expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
      host.send(frame(OP_CLOSE, 1, payload));
      return (await viewer.waitClosed()).code;
    }

    it("passes 4401 through to the viewer", async () => {
      expect(await closedWith(be(4401))).toBe(4401);
    });

    it("passes 4403 through to the viewer", async () => {
      expect(await closedWith(be(4403))).toBe(4403);
    });

    it("closes 1000 for a code outside the allow-list", async () => {
      expect(await closedWith(be(4404))).toBe(CLOSE_NORMAL);
      expect(await closedWith(be(1001))).toBe(CLOSE_NORMAL);
    });

    it("closes 1000 for the bare 3-byte form", async () => {
      expect(await closedWith()).toBe(CLOSE_NORMAL);
    });

    it("drops a host whose OP_CLOSE has a bad length (1002)", async () => {
      for (const payload of [[0x11], [0x11, 0x91, 0]]) {
        const { identity, roomId } = newIdentity();
        const host = await liveHost(identity, roomId);
        const viewer = await join(roomId);
        expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
        host.send(frame(OP_CLOSE, 1, payload));
        expect((await host.waitClosed()).code).toBe(CLOSE_PROTOCOL_ERROR);
        expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
      }
    });
  });

  it(`caps a room at ${MAX_CHANNELS} viewers (4429)`, async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    for (let ch = 1; ch <= MAX_CHANNELS; ch++) {
      await join(roomId);
      expect(await host.nextBytes()).toEqual(frame(OP_OPEN, ch));
    }
    const extra = await join(roomId);
    expect((await extra.waitClosed()).code).toBe(CLOSE_LIMIT);
    expect(await host.quiet()).toBe(true);
  });

  it("closes a viewer that sends text (1003)", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    viewer.send("hello");
    expect((await viewer.waitClosed()).code).toBe(CLOSE_UNSUPPORTED_DATA);
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));
  });

  it("closes every viewer with 4404 when the host drops", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const a = await join(roomId);
    const b = await join(roomId);
    host.close();
    expect((await a.waitClosed()).code).toBe(CLOSE_NO_HOST);
    expect((await b.waitClosed()).code).toBe(CLOSE_NO_HOST);
    const late = await join(roomId);
    expect((await late.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });
});

describe("limits", () => {
  it("passes a 1 MiB message and closes a larger one with 1009", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));

    // Exactly at the cap is fine (the test budget is far smaller, but
    // the budget only refuses new joins).
    viewer.send(new Uint8Array(MAX_RELAY_PAYLOAD_BYTES));
    const forwarded = await host.nextBytes();
    expect(forwarded.length).toBe(MAX_RELAY_PAYLOAD_BYTES + 3);

    viewer.send(new Uint8Array(MAX_RELAY_PAYLOAD_BYTES + 1));
    expect((await viewer.waitClosed()).code).toBe(CLOSE_TOO_BIG);
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));
  });

  it("closes a host that sends an oversized message with 1009", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    const big = new Uint8Array(3 + MAX_RELAY_PAYLOAD_BYTES + 1);
    big.set(frame(OP_DATA, 1));
    host.send(big);
    expect((await host.waitClosed()).code).toBe(CLOSE_TOO_BIG);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
  });

  it("refuses new joins once the daily byte budget is spent (4429)", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));

    // Half up, half down: both directions count.
    viewer.send(new Uint8Array(TEST_DAILY_BYTES / 2));
    await host.nextBytes();
    host.send(
      new Uint8Array([
        OP_DATA,
        0,
        1,
        ...new Array(TEST_DAILY_BYTES / 2).fill(0),
      ]),
    );
    await viewer.nextBytes();

    const refused = await join(roomId);
    expect((await refused.waitClosed()).code).toBe(CLOSE_LIMIT);
    // The open viewer keeps working.
    viewer.send(new Uint8Array([1]));
    expect(await host.nextBytes()).toEqual(frame(OP_DATA, 1, [1]));
  });

  it("counts small bursts across hibernation", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    // Each burst is below the 64 KiB flush threshold; only the delayed
    // flush can have counted it before the room goes away.
    const burst = Math.ceil(TEST_DAILY_BYTES / 3) + 1;
    for (let i = 0; i < 3; i++) {
      viewer.send(new Uint8Array(burst));
      await host.nextBytes();
      await sleep(1_500);
      // Stay alive for the heartbeat sweep meanwhile.
      host.send(HEARTBEAT_PING);
      viewer.send(HEARTBEAT_PING);
      expect(await host.next()).toBe(HEARTBEAT_PONG);
      expect(await viewer.next()).toBe(HEARTBEAT_PONG);
      await evictDurableObject(roomStub(roomId));
    }
    const refused = await join(roomId);
    expect((await refused.waitClosed()).code).toBe(CLOSE_LIMIT);
  }, 15_000);

  it("keeps the byte count across eviction", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    viewer.send(new Uint8Array(TEST_DAILY_BYTES));
    await host.nextBytes();

    await evictDurableObject(env.ROOM.get(env.ROOM.idFromName(roomId)));
    const refused = await join(roomId);
    expect((await refused.waitClosed()).code).toBe(CLOSE_LIMIT);
  });
});

describe("heartbeat", () => {
  it("answers a ping from the host and from a viewer, without forwarding it", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    host.send(HEARTBEAT_PING);
    expect(await host.next()).toBe(HEARTBEAT_PONG);

    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    viewer.send(HEARTBEAT_PING);
    expect(await viewer.next()).toBe(HEARTBEAT_PONG);
    // Not text the room acts on: the viewer stays, the host hears nothing.
    expect(await host.quiet()).toBe(true);
    expect(viewer.isClosed()).toBe(false);
  });

  it("reaps a viewer that stopped pinging, and tells the host", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const ghost = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    const alive = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 2));

    const deadline = Date.now() + TEST_STALE_MS + 500;
    while (Date.now() < deadline) {
      host.send(HEARTBEAT_PING);
      alive.send(HEARTBEAT_PING);
      expect(await host.next()).toBe(HEARTBEAT_PONG);
      expect(await alive.next()).toBe(HEARTBEAT_PONG);
      await sleep(500);
    }
    await runDurableObjectAlarm(roomStub(roomId));

    expect((await ghost.waitClosed()).code).toBe(CLOSE_IDLE);
    expect(await host.nextBytes()).toEqual(frame(OP_CLOSE, 1));
    expect(alive.isClosed()).toBe(false);
    expect(host.isClosed()).toBe(false);
  }, 10_000);

  it("refuses a join with 4404 when the host stopped pinging", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    await sleep(TEST_STALE_MS + 500);
    const viewer = await join(roomId);
    expect((await viewer.waitClosed()).code).toBe(CLOSE_NO_HOST);
    expect((await host.waitClosed()).code).toBe(CLOSE_IDLE);
  }, 10_000);

  it("keeps a pinging host across the sweep", async () => {
    const { identity, roomId } = newIdentity();
    const host = await liveHost(identity, roomId);
    const deadline = Date.now() + TEST_STALE_MS + 500;
    while (Date.now() < deadline) {
      host.send(HEARTBEAT_PING);
      expect(await host.next()).toBe(HEARTBEAT_PONG);
      await sleep(500);
    }
    await runDurableObjectAlarm(roomStub(roomId));
    const viewer = await join(roomId);
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));
    expect(viewer.isClosed()).toBe(false);
  }, 10_000);
});
