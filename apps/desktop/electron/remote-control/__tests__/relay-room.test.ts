/**
 * `RelayRoom` — the room operations the desktop controller and the host
 * server's relay share: the pairing link and its reissue, revoke-then-close, the reset order
 * that lets a relay browser hear 4401, stale-room revokes, durability, and
 * that the operations never interleave.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import type { RemoteDeviceStore } from "../devices";
import type { RelayConnector } from "../relay/connector";
import type { RelayIdentityStore } from "../relay/identity";
import { RelayRoom } from "../relay-room";
import { parseFragment } from "../../../src/bridge/web-pairing";
import { base64urlEncode } from "@manor/protocol/relay-crypto";

const ROOM = "AbCdEfGhIjKlMnOpQr_-01";
const KEY = base64urlEncode(new Uint8Array(32).fill(9));
/** Token-shaped, as the store mints them. */
const TICKET = base64urlEncode(new Uint8Array(32).fill(7));
const NEW_TICKET = base64urlEncode(new Uint8Array(32).fill(8));
const EXPIRES_AT = 600_000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakes() {
  const order: string[] = [];
  const gate = {
    closeDevice: vi.fn((id: string) => order.push(`close:${id}`)),
  };
  const connector = {
    origin: "https://relay.example.test" as string | null,
    start: vi.fn(() => order.push("start")),
    stop: vi.fn(() => order.push("stop")),
  };
  const identityState = { roomId: ROOM, resets: 0 };
  /** Set by a test to hold `identity.reset()` until it says. */
  let holdReset: Promise<void> | null = null;
  const identity = {
    describe: () => ({ roomId: identityState.roomId, x25519Pub: KEY }),
    reset: vi.fn(async () => {
      order.push("identity:begin");
      if (holdReset) await holdReset;
      identityState.resets += 1;
      identityState.roomId = `room-${identityState.resets}`;
      order.push("identity:end");
      return { roomId: identityState.roomId, x25519Pub: KEY };
    }),
  };

  const paired: Array<{ id: string; label: string; relayRoom: string }> = [];
  let minted = 0;
  /** Set by a test to make the next write fail. */
  let failWrite: Error | null = null;
  const write = async () => {
    const err = failWrite;
    failWrite = null;
    if (err) throw err;
  };
  const devices = {
    pair: vi.fn(async (
      label: string,
      relayRoom: string,
      options?: { direct?: boolean },
    ) => {
      minted += 1;
      const device = {
        id: `dev-${minted}`,
        label,
        relayRoom,
        createdAt: 0,
        lastSeenAt: null,
      };
      paired.push(device);
      order.push(`pair:${device.id}`);
      await write();
      return options?.direct
        ? { device, rawToken: "raw-token-value" }
        : { device, ticket: TICKET, expiresAt: EXPIRES_AT };
    }),
    reissue: vi.fn(async (id: string) => {
      const device = paired.find((d) => d.id === id);
      if (!device) throw new Error("Only a device that has not connected yet can get a new link.");
      order.push(`reissue:${id}`);
      await write();
      return { device, ticket: NEW_TICKET, expiresAt: EXPIRES_AT + 1 };
    }),
    revokeMany: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) {
        order.push(`revoke:${id}`);
        const i = paired.findIndex((d) => d.id === id);
        if (i >= 0) paired.splice(i, 1);
      }
      await write();
    }),
    ids: () => paired.map((d) => d.id),
    idsInOtherRelayRooms: (roomId: string) =>
      paired.filter((d) => d.relayRoom !== roomId).map((d) => d.id),
  };

  const onStaleRevoked = vi.fn();
  let relayAvailable = true;
  let gateLoaded = true;
  const room = new RelayRoom({
    devices: devices as unknown as RemoteDeviceStore,
    gate: () => (gateLoaded ? gate : null),
    relay: () =>
      relayAvailable
        ? {
            connector: connector as unknown as RelayConnector,
            identity: identity as unknown as RelayIdentityStore,
          }
        : null,
    appVersion: "1.2.3",
    onStaleRevoked,
  });

  return {
    room,
    order,
    gate,
    connector,
    identity,
    identityState,
    devices,
    paired,
    onStaleRevoked,
    holdReset: (p: Promise<void>) => {
      holdReset = p;
    },
    failNextWrite: (err: Error) => {
      failWrite = err;
    },
    setRelayAvailable: (v: boolean) => {
      relayAvailable = v;
    },
    setGateLoaded: (v: boolean) => {
      gateLoaded = v;
    },
  };
}

describe("RelayRoom", () => {
  let f: ReturnType<typeof fakes>;

  beforeEach(() => {
    f = fakes();
  });

  describe("pair", () => {
    it("builds a ticket link the browser's parser accepts", async () => {
      const result = await f.room.pair("browser");
      expect(result.pairingUrl).toBe(
        `https://relay.example.test/app/1.2.3/#relay=${ROOM}.${KEY}&ticket=${TICKET}`,
      );
      expect(result.expiresAt).toBe(EXPIRES_AT);
      expect(result).not.toHaveProperty("rawToken");
      expect(f.devices.pair).toHaveBeenCalledWith("browser", ROOM, undefined);
      const hash = result.pairingUrl.slice(result.pairingUrl.indexOf("#"));
      expect(parseFragment(hash)).toEqual({
        kind: "ticket",
        link: { roomId: ROOM, serverKey: KEY, ticket: TICKET },
      });
    });

    it("direct: hands back the raw token, in a token link", async () => {
      const result = await f.room.pair("host phone", { direct: true });
      expect(f.devices.pair).toHaveBeenCalledWith("host phone", ROOM, { direct: true });
      expect(result.rawToken).toBe("raw-token-value");
      expect(result.expiresAt).toBeNull();
      expect(result.pairingUrl).toBe(
        `https://relay.example.test/app/1.2.3/#relay=${ROOM}.${KEY}&t=raw-token-value`,
      );
    });

    it("refuses while the relay is unavailable or its address unset", async () => {
      f.setRelayAvailable(false);
      await expect(f.room.pair("p")).rejects.toThrow(/not available/);
      f.setRelayAvailable(true);
      f.connector.origin = null;
      await expect(f.room.pair("p")).rejects.toThrow(/not configured/);
      expect(f.devices.pair).not.toHaveBeenCalled();
    });

    it("revokes devices left on a stale room first", async () => {
      await f.room.pair("old");
      f.identityState.roomId = "another-room";
      await f.room.pair("new");
      expect(f.paired.map((d) => d.label)).toEqual(["new"]);
      expect(f.gate.closeDevice).toHaveBeenCalledWith("dev-1");
      expect(f.onStaleRevoked).toHaveBeenCalledWith(1);
    });

    it("rejects when the device could not be saved", async () => {
      f.failNextWrite(new Error("disk full"));
      await expect(f.room.pair("p")).rejects.toThrow(/disk full/);
    });
  });

  describe("reissue", () => {
    it("links the device's new ticket, revoking nothing", async () => {
      await f.room.pair("a");
      const result = await f.room.reissue("dev-1");
      expect(f.devices.reissue).toHaveBeenCalledWith("dev-1");
      expect(result.pairingUrl).toBe(
        `https://relay.example.test/app/1.2.3/#relay=${ROOM}.${KEY}&ticket=${NEW_TICKET}`,
      );
      expect(result.expiresAt).toBe(EXPIRES_AT + 1);
      expect(f.devices.revokeMany).not.toHaveBeenCalled();
      expect(f.onStaleRevoked).not.toHaveBeenCalled();
    });

    it("refuses a device on a room the identity no longer is, revoking nothing", async () => {
      await f.room.pair("a");
      f.identityState.roomId = "another-room";
      await expect(f.room.reissue("dev-1")).rejects.toThrow(/old relay address/);
      expect(f.devices.reissue).not.toHaveBeenCalled();
      expect(f.devices.revokeMany).not.toHaveBeenCalled();
    });

    it("passes the store's refusal on", async () => {
      await expect(f.room.reissue("nope")).rejects.toThrow(/not connected yet/);
    });

    it("refuses while the relay is unavailable", async () => {
      await f.room.pair("a");
      f.setRelayAvailable(false);
      await expect(f.room.reissue("dev-1")).rejects.toThrow(/not available/);
      expect(f.devices.reissue).not.toHaveBeenCalled();
    });

    it("runs on the queue, behind a reset", async () => {
      await f.room.pair("a");
      const held = deferred();
      f.holdReset(held.promise);
      const resetting = f.room.reset();
      const reissuing = f.room.reissue("dev-1");
      await vi.waitFor(() => expect(f.identity.reset).toHaveBeenCalled());
      expect(f.devices.reissue).not.toHaveBeenCalled();
      held.resolve();
      await resetting;
      // The reset revoked it: the store has nothing to reissue.
      await expect(reissuing).rejects.toThrow(/not connected yet/);
    });
  });

  describe("revoke", () => {
    it("refuses the device before closing its channels", async () => {
      await f.room.pair("a");
      await f.room.pair("b");
      f.order.length = 0;
      await f.room.revoke("dev-1");
      expect(f.order).toEqual(["revoke:dev-1", "close:dev-1"]);
      expect(f.paired.map((d) => d.id)).toEqual(["dev-2"]);
    });

    it("closes nothing when no gate is loaded", async () => {
      await f.room.pair("a");
      f.setGateLoaded(false);
      await f.room.revoke("dev-1");
      expect(f.gate.closeDevice).not.toHaveBeenCalled();
      expect(f.paired).toEqual([]);
    });

    it("disconnects but rejects when the revoke could not be saved", async () => {
      await f.room.pair("a");
      f.failNextWrite(new Error("disk full"));
      await expect(f.room.revoke("dev-1")).rejects.toThrow(/disk full/);
      expect(f.gate.closeDevice).toHaveBeenCalledWith("dev-1");
    });

    it("revokeAll revokes and closes every device", async () => {
      await f.room.pair("a");
      await f.room.pair("b");
      await f.room.revokeAll();
      expect(f.paired).toEqual([]);
      expect(f.gate.closeDevice).toHaveBeenCalledTimes(2);
    });
  });

  describe("revokeStale", () => {
    it("revokes devices on other rooms and reports how many", async () => {
      await f.room.pair("old");
      await f.devices.pair("current", "another-room");
      expect(await f.room.revokeStale("another-room")).toBe(1);
      expect(f.paired.map((d) => d.label)).toEqual(["current"]);
      expect(f.onStaleRevoked).toHaveBeenCalledWith(1);
    });

    it("says nothing when every device is on the room", async () => {
      await f.room.pair("a");
      expect(await f.room.revokeStale(ROOM)).toBe(0);
      expect(f.onStaleRevoked).not.toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("closes devices while the relay is still up, then stops it", async () => {
      await f.room.pair("rl1");
      await f.room.pair("rl2");
      f.order.length = 0;
      await f.room.reset();
      // 4401 has to travel through the live relay; after `stop` it cannot.
      expect(f.order).toEqual([
        "revoke:dev-1",
        "revoke:dev-2",
        "close:dev-1",
        "close:dev-2",
        "stop",
        "identity:begin",
        "identity:end",
      ]);
      expect(f.connector.start).not.toHaveBeenCalled();
    });

    it("redials when asked, even after a reset that failed", async () => {
      f.identity.reset.mockRejectedValueOnce(new Error("seal failed"));
      await expect(f.room.reset({ redial: () => true })).rejects.toThrow(
        /seal failed/,
      );
      expect(f.connector.start).toHaveBeenCalledTimes(1);
    });

    it("refuses while the relay is unavailable", async () => {
      f.setRelayAvailable(false);
      await expect(f.room.reset()).rejects.toThrow(/not available/);
    });

    it("two concurrent resets run one after the other", async () => {
      await f.room.pair("a");
      const held = deferred();
      f.holdReset(held.promise);
      f.order.length = 0;
      const first = f.room.reset();
      const second = f.room.reset();
      // Let the first reach `identity.reset` and park there.
      await vi.waitFor(() => expect(f.identity.reset).toHaveBeenCalledTimes(1));
      expect(f.connector.stop).toHaveBeenCalledTimes(1);
      held.resolve();
      await Promise.all([first, second]);
      expect(f.order).toEqual([
        "revoke:dev-1",
        "close:dev-1",
        "stop",
        "identity:begin",
        "identity:end",
        "stop",
        "identity:begin",
        "identity:end",
      ]);
      expect(f.identityState.resets).toBe(2);
    });

    it("a pair queued behind a reset lands on the new room", async () => {
      const held = deferred();
      f.holdReset(held.promise);
      const resetting = f.room.reset();
      const pairing = f.room.pair("after");
      await vi.waitFor(() => expect(f.identity.reset).toHaveBeenCalled());
      expect(f.devices.pair).not.toHaveBeenCalled();
      held.resolve();
      await resetting;
      const { pairingUrl } = await pairing;
      expect(f.devices.pair).toHaveBeenCalledWith("after", "room-1", undefined);
      expect(pairingUrl).toContain("#relay=room-1.");
    });

    it("a failed step does not stall the queue", async () => {
      f.identity.reset.mockRejectedValueOnce(new Error("seal failed"));
      const failed = f.room.reset();
      const pairing = f.room.pair("next");
      await expect(failed).rejects.toThrow(/seal failed/);
      await expect(pairing).resolves.toMatchObject({
        device: { label: "next" },
      });
    });
  });
});
