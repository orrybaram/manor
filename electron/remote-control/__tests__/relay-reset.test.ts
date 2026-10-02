/**
 * "Reset relay address", end to end (ADR-206): the real controller, the real
 * connector against the in-process fake relay, the real bridge hello gate.
 *
 * The property: a browser paired through the relay hears 4401 — "re-pair" —
 * when the address it holds is reset. Stopping the relay first would take the
 * host socket away and the room would answer 4404 ("this machine is not
 * reachable"), which the browser retries forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../src/lib/relay-crypto";
import type { BridgeServer } from "../../bridge/server";
import { WsBridgeServer } from "../../bridge/transports/ws";
import type { HostDeps } from "../../ipc/types";
import {
  RemoteControlController,
  type RemoteControlRuntime,
} from "../controller";
import type { RemoteDeviceStore } from "../devices";
import { AuthRateLimiter } from "../rate-limit";
import { RelayConnector } from "../relay/connector";
import type { RelayIdentityStore } from "../relay/identity";
import { FakeRelay, FakeViewer } from "../relay/__tests__/fake-relay";
import { RemoteControlServer, type AuthenticatedDevice } from "../server";

const RELAY_TOKEN = "relay-token";

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

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("resetting the relay address", () => {
  let relay: FakeRelay;
  let bridge: WsBridgeServer;
  let connector: RelayConnector;
  let viewers: FakeViewer[];

  beforeEach(async () => {
    relay = new FakeRelay();
    await relay.listen();
    viewers = [];
  });

  afterEach(async () => {
    for (const v of viewers) v.ws.terminate();
    connector?.stop();
    bridge?.dispose();
    await relay.close();
  });

  it("closes a live relay browser with 4401, not 4404", async () => {
    const identity = generateRelayIdentity();
    const roomId = roomIdFor(identity.ed25519.pub);

    const devices = new Map<string, AuthenticatedDevice>([
      [
        RELAY_TOKEN,
        { id: "dev-relay", label: "browser", capability: "full", via: "relay" },
      ],
    ]);
    const deviceStore = {
      verify: (raw: unknown) =>
        typeof raw === "string" ? (devices.get(raw) ?? null) : null,
      idsVia: (via: string) =>
        [...devices.values()].filter((d) => d.via === via).map((d) => d.id),
      idsInOtherRelayRooms: () => [],
      revoke: (id: string) => {
        for (const [token, d] of devices)
          if (d.id === id) devices.delete(token);
      },
      list: () => [],
    };

    const host = {
      accept: () => {},
      drop: () => {},
      receive: async () => null,
    } as unknown as BridgeServer;
    bridge = new WsBridgeServer(host, { appVersion: "9.9.9" });
    const server = new RemoteControlServer(
      () => ({}) as unknown as HostDeps,
      deviceStore,
      {
        limiter: new AuthRateLimiter(),
        clientDir: null,
        webDir: null,
        bridge,
      },
    );
    connector = new RelayConnector({
      identity: { load: () => clone(identity) },
      bridge,
      authenticate: (token) => server.authenticateRelayHello(token),
      relayUrl: relay.url,
      timing: { backoffMinMs: 20, backoffMaxMs: 100 },
    });
    const identityStore = {
      describe: () => ({ roomId, x25519Pub: "" }),
      reset: () => ({ roomId: "new", x25519Pub: "" }),
    };
    const runtime: RemoteControlRuntime = {
      server,
      relay: connector,
      relayIdentity: identityStore as unknown as RelayIdentityStore,
    };
    const controller = new RemoteControlController(
      async () => runtime,
      deviceStore as unknown as RemoteDeviceStore,
      () => true,
      null,
    );

    connector.start();
    await until(() => connector.status.state === "running", "relay running");

    const viewer = await FakeViewer.open(
      relay.url,
      roomId,
      identity.x25519.pub,
    );
    viewers.push(viewer);
    viewer.send({ type: "hello", token: RELAY_TOKEN });
    await viewer.next((f) => f.type === "hello");

    const status = await controller.resetRelayAddress();
    expect(await viewer.closed).toBe(4401);
    expect(status.relay.state).toBe("stopped");
    expect(devices.size).toBe(0);
  });
});
