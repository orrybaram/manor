/**
 * Flow control and liveness on the host socket (ADR-206, amendments after
 * review): the desktop's uplink is throttled by a TCP proxy, the viewers talk
 * to the relay directly. Real connector, real `RelayChannel`s, real bridge
 * hello gate; only the bridge's handler table is a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../../src/lib/relay-crypto";
import type { BridgeServer } from "../../../bridge/server";
import {
  WsBridgeServer,
  type BridgeAuthResult,
} from "../../../bridge/transports/ws";
import type { BridgeConnection } from "../../../bridge/types";
import { CHANNEL_BACKLOG_BYTES } from "../channel";
import { RelayConnector, type RelayTiming } from "../connector";
import {
  FakeRelay,
  FakeViewer,
  throttledLink,
  type ThrottledLink,
} from "./fake-relay";

/** ~8 Mbit/s: a home uplink. */
const UPLINK_BYTES_PER_SEC = 1_000_000;
const TOKEN = "full-token";

async function until(
  check: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("relay host socket flow control", () => {
  let relay: FakeRelay;
  let link: ThrottledLink;
  let identity: RelayIdentity;
  let roomId: string;
  let connector: RelayConnector;
  let bridge: WsBridgeServer;
  let accepted: BridgeConnection[];
  let viewers: FakeViewer[];

  async function setup(timing: Partial<RelayTiming> = {}): Promise<void> {
    relay = new FakeRelay();
    await relay.listen();
    link = await throttledLink(relay.url, UPLINK_BYTES_PER_SEC);
    identity = generateRelayIdentity();
    roomId = roomIdFor(identity.ed25519.pub);
    const host = {
      accept: (c: BridgeConnection) => accepted.push(c),
      drop: () => {},
      receive: async (_c: BridgeConnection, frame: Record<string, unknown>) =>
        frame.kind === "invoke"
          ? { id: frame.id, kind: "result", ok: true, result: frame.args }
          : null,
    } as unknown as BridgeServer;
    bridge = new WsBridgeServer(host, {});
    const keys = identity;
    connector = new RelayConnector({
      identity: {
        load: () => ({
          ed25519: {
            pub: keys.ed25519.pub.slice(),
            priv: keys.ed25519.priv.slice(),
          },
          x25519: {
            pub: keys.x25519.pub.slice(),
            priv: keys.x25519.priv.slice(),
          },
        }),
      },
      gate: {
        attach: (socket) =>
          bridge.attach(
            socket,
            (token): BridgeAuthResult =>
              token === TOKEN
                ? {
                    ok: true,
                    device: { id: "d", label: "p" },
                  }
                : { ok: false, code: 4401 },
          ),
      },
      relayUrl: link.url,
      timing: { backoffMinMs: 20, backoffMaxMs: 100, ...timing },
    });
    connector.start();
    await until(() => connector.status.state === "running", "running");
  }

  beforeEach(() => {
    accepted = [];
    viewers = [];
  });

  afterEach(async () => {
    for (const v of viewers) v.ws.terminate();
    connector.stop();
    bridge.dispose();
    await link.close();
    await relay.close();
  });

  async function helloed(): Promise<FakeViewer> {
    const v = await FakeViewer.open(relay.url, roomId, identity.x25519.pub);
    viewers.push(v);
    v.send({ type: "hello", token: TOKEN });
    await v.next((f) => f.type === "hello", 10_000);
    return v;
  }

  /** `cat bigfile` in a pane `conn` watches: 64 KiB output events. */
  function burst(conn: BridgeConnection, totalBytes: number): void {
    const chunk = "y".repeat(64 * 1024 - 128);
    for (let sent = 0, seq = 0; sent < totalBytes; sent += chunk.length) {
      conn.send({
        kind: "event",
        ns: "pty",
        event: "output",
        key: "p",
        args: [chunk, seq++],
      });
    }
  }

  it("does not hold one viewer's reply behind another viewer's backlog", async () => {
    await setup();
    const a = await helloed();
    const b = await helloed();
    burst(accepted[0], 6 * 1024 * 1024);
    await sleep(50);

    const start = Date.now();
    b.send({ id: 1, kind: "invoke", ns: "t", method: "echo", args: ["key"] });
    await b.next((f) => f.id === 1, 10_000);
    // Unscheduled, this waited for all 6 MB at 1 MB/s.
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
  }, 20_000);

  it("lets a new viewer finish its handshake and hello during a backlog", async () => {
    await setup();
    await helloed();
    burst(accepted[0], 7 * 1024 * 1024);
    await sleep(50);

    const start = Date.now();
    const c = await FakeViewer.connect(relay.url, roomId);
    viewers.push(c);
    await c.handshake(identity.x25519.pub);
    c.send({ type: "hello", token: TOKEN });
    await c.next((f) => f.type === "hello", 10_000);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 20_000);

  it("closes a viewer that falls too far behind, and only that viewer", async () => {
    await setup();
    const a = await helloed();
    const b = await helloed();
    burst(accepted[0], CHANNEL_BACKLOG_BYTES + 2 * 1024 * 1024);
    // A plain close: not a bridge verdict, so the page just reconnects.
    expect(await a.closed).toBe(1000);
    b.send({ id: 2, kind: "invoke", ns: "t", method: "echo", args: [] });
    await b.next((f) => f.id === 2, 10_000);
    expect(connector.status.state).toBe("running");
  }, 20_000);

  it("sends heartbeats once authenticated", async () => {
    await setup({ pingIntervalMs: 100 });
    await until(() => relay.hostPings >= 2, "two heartbeats");
  });

  it("keeps a socket whose heartbeat is stuck behind a backlog", async () => {
    await setup({ pingIntervalMs: 300 });
    await helloed();
    // The room's acks keep coming while the backlog drains, so an
    // unanswered heartbeat for a few intervals is not a dead socket.
    relay.muteHeartbeat = true;
    burst(accepted[0], 2_500_000);
    await sleep(1_500);
    expect(relay.authCount).toBe(1);
    expect(connector.status.state).toBe("running");
  }, 20_000);

  it("drops a socket that hears nothing for an interval", async () => {
    await setup({ pingIntervalMs: 200 });
    relay.muteHeartbeat = true;
    relay.muteAcks = true;
    await until(() => relay.authCount === 2, "reconnected", 10_000);
  }, 20_000);
});
