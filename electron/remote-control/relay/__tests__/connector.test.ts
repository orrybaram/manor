/**
 * The relay connector end to end (ADR-206 D5): a real `ws` relay in-process,
 * a viewer running the real Noise initiator, the real `RelayGate` in front of
 * the real `WsBridgeServer` hello gate — only the bridge's handler table is a
 * stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../../src/lib/relay-crypto";
import { MAX_RELAY_PAYLOAD_BYTES } from "../../../../src/lib/relay-crypto/protocol";
import type { BridgeServer } from "../../../bridge/server";
import {
  WsBridgeServer,
  type BridgeAuthResult,
} from "../../../bridge/transports/ws";
import type { BridgeConnection } from "../../../bridge/types";
import { AuthRateLimiter } from "../../rate-limit";
import { RelayGate, type AuthenticatedDevice } from "../../relay-gate";
import {
  RelayConnector,
  parseRelayUrl,
  resolveRelayUrl,
  type RelayStatus,
} from "../connector";
import { FakeRelay, FakeViewer } from "./fake-relay";

const FULL_TOKEN = "full-token";
const SEND_TOKEN = "send-token";
const full: AuthenticatedDevice = {
  id: "d-full",
  label: "browser",
  capability: "full",
  via: "relay",
};
const send: AuthenticatedDevice = {
  id: "d-send",
  label: "phone",
  capability: "send",
  via: "relay",
};

/** A 1 MiB-ish reply, as close to the frame cap as the JSON envelope allows. */
const BIG = "x".repeat(1024 * 1024 - 200);
/** Bigger than any viewer may send: a long scrollback's `pty.create`. */
const HUGE = "h".repeat(3 * 1024 * 1024);

function clone(identity: RelayIdentity): RelayIdentity {
  return {
    ed25519: {
      pub: identity.ed25519.pub.slice(),
      priv: identity.ed25519.priv.slice(),
    },
    x25519: {
      pub: identity.x25519.pub.slice(),
      priv: identity.x25519.priv.slice(),
    },
  };
}

async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("RelayConnector", () => {
  let relay: FakeRelay;
  let identity: RelayIdentity;
  let roomId: string;
  let connectors: RelayConnector[];
  let viewers: FakeViewer[];
  let accepted: BridgeConnection[];
  let authResults: BridgeAuthResult[];
  let bridge: WsBridgeServer;
  let gate: RelayGate;

  beforeEach(async () => {
    relay = new FakeRelay();
    await relay.listen();
    identity = generateRelayIdentity();
    roomId = roomIdFor(identity.ed25519.pub);
    connectors = [];
    viewers = [];
    accepted = [];
    authResults = [];

    const host = {
      accept: (c: BridgeConnection) => accepted.push(c),
      drop: () => {},
      receive: async (_c: BridgeConnection, frame: Record<string, unknown>) => {
        if (frame.kind !== "invoke") return null;
        const result = frame.method === "test.big" ? BIG : { echo: frame.args };
        return { id: frame.id, kind: "result", ok: true, result };
      },
    } as unknown as BridgeServer;
    bridge = new WsBridgeServer(host, { appVersion: "9.9.9" });
    gate = new RelayGate(
      {
        verify: (raw) =>
          raw === FULL_TOKEN ? full : raw === SEND_TOKEN ? send : null,
      },
      bridge,
      new AuthRateLimiter(),
    );
  });

  afterEach(async () => {
    for (const v of viewers) v.ws.terminate();
    for (const c of connectors) c.stop();
    bridge.dispose();
    await relay.close();
  });

  function connector(timing: Record<string, number> = {}): RelayConnector {
    const c = new RelayConnector({
      identity: { load: () => clone(identity) },
      // The real gate, with every verdict it hands the bridge recorded.
      gate: {
        attach: (socket) =>
          bridge.attach(socket, (token) => {
            const result = gate.authenticate(token);
            authResults.push(result);
            return result;
          }),
      },
      relayUrl: relay.url,
      timing: { backoffMinMs: 20, backoffMaxMs: 100, ...timing },
    });
    connectors.push(c);
    return c;
  }

  async function running(c: RelayConnector): Promise<void> {
    c.start();
    await until(() => c.status.state === "running", "connector running");
  }

  async function viewer(): Promise<FakeViewer> {
    const v = await FakeViewer.open(relay.url, roomId, identity.x25519.pub);
    viewers.push(v);
    return v;
  }

  it("authenticates the room and reports the relay origin", async () => {
    const c = connector();
    const seen: RelayStatus[] = [];
    c.onStatus((s) => seen.push(s));
    await running(c);
    expect(seen.map((s) => s.state)).toEqual(["starting", "running"]);
    expect(c.status.url).toBe(relay.url.replace("ws://", "http://"));
    expect(relay.authCount).toBe(1);
  });

  it("carries a hello with a full token to the bridge and round-trips an invoke", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    const hello = await v.next((f) => f.type === "hello");
    expect(hello).toMatchObject({ ok: true, appVersion: "9.9.9" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      callerClass: "device",
      deviceId: "d-full",
    });

    v.send({ id: 1, kind: "invoke", method: "test.echo", args: ["hi"] });
    const result = await v.next((f) => f.kind === "result" && f.id === 1);
    expect(result).toMatchObject({ ok: true, result: { echo: ["hi"] } });
    expect(c.channelCount).toBe(1);
  });

  it("coalesces replies written together into one relay message", async () => {
    const c = connector({ flushIntervalMs: 50 });
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    await v.next((f) => f.type === "hello");
    const before = v.messages;
    v.send({ id: 1, kind: "invoke", method: "a", args: [] });
    v.send({ id: 2, kind: "invoke", method: "b", args: [] });
    await v.next((f) => f.id === 2);
    await v.next((f) => f.id === 1);
    expect(v.messages - before).toBe(1);
  });

  it("splits a ~1 MiB frame so no relay message exceeds the payload cap", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    await v.next((f) => f.type === "hello");
    v.send({ id: 7, kind: "invoke", method: "test.big", args: [] });
    const result = await v.next((f) => f.id === 7, 10_000);
    expect(result.result).toBe(BIG);
    // Sealed, the reply is bigger than one relay message may be...
    const sent = [...relay.hostPayloads.values()].flat();
    const total = sent.reduce((n, p) => n + p.length, 0);
    expect(total).toBeGreaterThan(MAX_RELAY_PAYLOAD_BYTES);
    // ...and no single message was.
    expect(relay.maxHostPayload).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
    expect(c.status.state).toBe("running");
  });

  it("revoking a device closes its live relay channel with 4401", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    await v.next((f) => f.type === "hello");

    gate.closeDevice("d-full");
    expect(await v.closed).toBe(4401);
  });

  it("closes the channel when the token is wrong (4401)", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: "nope" });
    // The bridge's code rides on OP_CLOSE through the relay to the viewer.
    expect(await v.closed).toBe(4401);
    expect(authResults).toEqual([{ ok: false, code: 4401 }]);
    expect(accepted).toHaveLength(0);
    await until(() => c.channelCount === 0, "channel dropped");
  });

  it("closes the channel for a device below full (4403)", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: SEND_TOKEN });
    expect(await v.closed).toBe(4403);
    expect(authResults).toEqual([{ ok: false, code: 4403 }]);
  });

  it("closes the channel on tampered ciphertext, and only that channel", async () => {
    const c = connector();
    await running(c);
    const good = await viewer();
    good.send({ type: "hello", token: FULL_TOKEN });
    await good.next((f) => f.type === "hello");

    const bad = await viewer();
    bad.sendTampered({ type: "hello", token: FULL_TOKEN });
    // A channel failure is not a bridge verdict: a plain close.
    expect(await bad.closed).toBe(1000);
    expect(authResults).toHaveLength(1);
    await until(() => c.channelCount === 1, "tampered channel dropped");

    good.send({ id: 3, kind: "invoke", method: "x", args: [] });
    await good.next((f) => f.id === 3);
  });

  it("closes a channel that sends more than PRE_HELLO_BYTES before a frame", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    // Two full chunks of a frame that never ends: ~128 KiB, all decrypting.
    v.sendUnfinishedFrame(2);
    expect(await v.closed).toBe(1000);
    expect(authResults).toHaveLength(0);
    await until(() => c.channelCount === 0, "channel dropped");
  });

  it("carries a desktop frame larger than 1 MiB (a big snapshot)", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    await v.next((f) => f.type === "hello");
    accepted[0].send({
      kind: "event",
      ns: "pty",
      event: "snapshot",
      args: [HUGE],
    });
    const event = await v.next((f) => f.event === "snapshot", 10_000);
    expect((event.args as string[])[0]).toBe(HUGE);
    expect(relay.maxHostPayload).toBeLessThanOrEqual(MAX_RELAY_PAYLOAD_BYTES);
    expect(c.channelCount).toBe(1);
  });

  it("closes a channel whose handshake does not finish in time", async () => {
    const c = connector({ channelHandshakeTimeoutMs: 100 });
    await running(c);
    const v = await FakeViewer.connect(relay.url, roomId);
    viewers.push(v);
    await v.closed;
    expect(c.channelCount).toBe(0);
  });

  it("closes the channel on a handshake against the wrong key", async () => {
    const c = connector();
    await running(c);
    const other = generateRelayIdentity();
    await expect(
      FakeViewer.open(relay.url, roomId, other.x25519.pub),
    ).rejects.toThrow();
    await until(() => c.channelCount === 0, "channel dropped");
  });

  it("fails without reconnecting when another host takes the room (4409)", async () => {
    const first = connector();
    await running(first);
    const second = connector();
    await running(second);
    await until(() => first.status.state === "failed", "first failed");
    expect(first.status.error).toMatch(/Another Manor/);
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.authCount).toBe(2);
    expect(second.status.state).toBe("running");
  });

  it("reconnects after the relay connection drops, and drops its channels", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    v.send({ type: "hello", token: FULL_TOKEN });
    await v.next((f) => f.type === "hello");

    const states: string[] = [];
    c.onStatus((s) => states.push(s.state));
    relay.dropHost();
    await v.closed;
    await until(() => relay.authCount === 2, "re-authenticated");
    await until(() => c.status.state === "running", "running again");
    expect(states).toEqual(["starting", "running"]);
    expect(c.channelCount).toBe(0);

    const again = await viewer();
    again.send({ type: "hello", token: FULL_TOKEN });
    await again.next((f) => f.type === "hello");
  });

  it("stop() closes everything and does not reconnect", async () => {
    const c = connector();
    await running(c);
    const v = await viewer();
    c.stop();
    await v.closed;
    expect(c.status).toEqual({ state: "stopped", url: null, error: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.authCount).toBe(1);
    expect(relay.liveHost).toBeNull();
  });

  it("reports failed when the identity cannot be loaded", () => {
    const c = new RelayConnector({
      identity: {
        load: () => {
          throw new Error("no keychain");
        },
      },
      gate,
      relayUrl: relay.url,
    });
    c.start();
    expect(c.status).toEqual({
      state: "failed",
      url: null,
      error: "no keychain",
    });
  });
});

describe("relay URL", () => {
  it("maps https and wss to an origin and a socket base", () => {
    expect(parseRelayUrl("https://relay.example.com/")).toEqual({
      origin: "https://relay.example.com",
      socketBase: "wss://relay.example.com",
    });
    expect(parseRelayUrl("wss://relay.example.com:8443")).toEqual({
      origin: "https://relay.example.com:8443",
      socketBase: "wss://relay.example.com:8443",
    });
  });

  it("allows plaintext only for localhost", () => {
    expect(parseRelayUrl("ws://localhost:8787").socketBase).toBe(
      "ws://localhost:8787",
    );
    expect(parseRelayUrl("http://127.0.0.1:8787").origin).toBe(
      "http://127.0.0.1:8787",
    );
    expect(() => parseRelayUrl("ws://relay.example.com")).toThrow();
    expect(() => parseRelayUrl("ftp://relay.example.com")).toThrow();
  });

  it("prefers MANOR_RELAY_URL over the default", () => {
    expect(resolveRelayUrl({ MANOR_RELAY_URL: "ws://localhost:1" })).toBe(
      "ws://localhost:1",
    );
    expect(resolveRelayUrl({})).toMatch(/^https:\/\//);
  });
});
