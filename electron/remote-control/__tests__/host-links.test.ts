/**
 * One pairing covers every host (ADR-228 D9): the desktop mints a pairing
 * on each host for its own device, skips what the device already holds, and
 * every revoke of the device — or the per-host switch going off — reaches
 * the host, now or on its next connect.
 *
 * Over a real device store and a real `HostServerSync`; each host's owner
 * channel is a fake that keeps its own device list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteDeviceStore } from "../devices";
import { HostPairingLinks } from "../host-links";
import { HostServerSync } from "../../backend/host-server-sync";
import type { HostServerClientState } from "../../backend/host-server-client";
import {
  remoteControlLinkHostPairings,
  remoteControlRevoke,
} from "../../bridge/handlers/remote-control";
import { localCtx } from "../../bridge/method";
import { switchableBox } from "../../platform/__tests__/switchable-box";

const KEY = "A".repeat(43);

/** One host's owner channel, holding its own paired devices. */
function fakeHost(hostId: string, roomId: string) {
  const paired = new Set<string>();
  let minted = 0;
  const host = {
    hostId,
    state: "connected" as HostServerClientState,
    paired,
    subscribe: vi.fn(() => () => {}),
    api: {
      hostServer: {
        status: vi.fn(async () => ({
          roomId,
          capabilities: ["viewer-bridge"],
          ownership: "owned",
          relay: { roomId, connected: true, error: null },
          pushEndpoints: [],
        })),
      },
      remoteControl: {
        pair: vi.fn(async (label: string) => {
          const id = `${hostId}-device-${++minted}`;
          paired.add(id);
          return {
            device: { id, label },
            rawToken: `token-${id}`,
            pairingUrl: `https://relay.test/app/1/#relay=${roomId}.${KEY}&t=token-${id}`,
          };
        }),
        revoke: vi.fn(async (id: string) => {
          if (host.state !== "connected") throw new Error("host away");
          paired.delete(id);
          return [];
        }),
      },
    },
  };
  return host;
}

type FakeHost = ReturnType<typeof fakeHost>;

describe("HostPairingLinks", () => {
  let dir: string;
  let devices: RemoteDeviceStore;
  let hosts: FakeHost[];
  let stateListeners: Array<(hostId: string, state: HostServerClientState) => void>;
  /** `PersistedHost`, as far as this is concerned. */
  let records: Record<string, { linkPhones: boolean; pendingRevokes: string[] }>;
  let sync: HostServerSync;
  let links: HostPairingLinks;
  const pairingChanged = vi.fn();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-host-links-"));
    devices = new RemoteDeviceStore(switchableBox(), path.join(dir, "devices.enc"));
    await devices.init();
    hosts = [fakeHost("box", "room-box"), fakeHost("wsl", "room-wsl")];
    stateListeners = [];
    records = {
      box: { linkPhones: true, pendingRevokes: [] },
      wsl: { linkPhones: true, pendingRevokes: [] },
    };
    const registry = {
      hostServer: (id: string) => hosts.find((h) => h.hostId === id) as never,
      hostServers: () => hosts as never,
      onHostServerStateChange: (
        listener: (hostId: string, state: HostServerClientState) => void,
      ) => {
        stateListeners.push(listener);
        return () => {};
      },
    };
    sync = new HostServerSync({
      registry,
      pendingRevokes: {
        list: (id) => records[id].pendingRevokes,
        clear: (id, done) => {
          records[id].pendingRevokes = records[id].pendingRevokes.filter(
            (d) => !done.includes(d),
          );
        },
      },
      log: { warn: () => {} },
    });
    sync.start();
    links = new HostPairingLinks({
      devices,
      hostServers: registry.hostServers,
      records: {
        linkPhones: (id) => records[id].linkPhones,
        setLinkPhones: (id, on) => {
          records[id].linkPhones = on;
        },
        addPendingRevokes: (id, ids) => {
          records[id].pendingRevokes = [...new Set([...records[id].pendingRevokes, ...ids])];
        },
        label: (id) => `me@${id}`,
      },
      revokePending: (id) => sync.revokePending(id),
      pairingChanged,
      log: { warn: () => {} },
    });
    links.start();
  });

  afterEach(async () => {
    links.dispose();
    sync.dispose();
    await devices.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const box = () => hosts[0];
  const wsl = () => hosts[1];
  const phone = async (label = "Orry's phone") => (await devices.pair(label, "room-desk")).device.id;
  /** The handler, as a paired device calls it. */
  const deviceCtx = (deviceId: string) => ({
    deps: { hostLinks: links } as never,
    caller: { id: "conn-1", callerClass: "device" as const, deviceId },
  });

  it("mints a pairing on every host the device does not hold, under its label, and links it", async () => {
    const id = await phone();
    const linked = await links.link(id, ["room-desk", "room-wsl"]);

    expect(linked).toEqual([
      { roomId: "room-box", serverKey: KEY, token: "token-box-device-1", name: "me@box" },
    ]);
    expect(box().api.remoteControl.pair).toHaveBeenCalledWith("Orry's phone");
    expect(wsl().api.remoteControl.pair).not.toHaveBeenCalled();
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-1" }]);
    expect(links.linkedOn("box")).toEqual(["box-device-1"]);
    expect(pairingChanged).toHaveBeenCalledWith("box");
  });

  it("skips a host that is away, or whose switch is off", async () => {
    const id = await phone();
    box().state = "idle";
    records.wsl.linkPhones = false;
    await expect(links.link(id, [])).resolves.toEqual([]);
    expect(box().api.remoteControl.pair).not.toHaveBeenCalled();
    expect(wsl().api.remoteControl.pair).not.toHaveBeenCalled();
  });

  it("skips a host whose relay is down, until a later call finds it up", async () => {
    const id = await phone();
    const up = await box().api.hostServer.status();
    box().api.hostServer.status.mockResolvedValueOnce({
      ...up,
      relay: { ...up.relay, connected: false },
    });
    await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
    expect(box().api.remoteControl.pair).not.toHaveBeenCalled();
    const later = await links.link(id, ["room-wsl"]);
    expect(later.map((p) => p.roomId)).toEqual(["room-box"]);
  });

  it("revokes a link the device let go of before minting it a new one", async () => {
    const id = await phone();
    await links.link(id, ["room-wsl"]);
    // The phone removed the box's pairing; its next hello holds no box room.
    const again = await links.link(id, ["room-wsl"]);
    expect(again.map((p) => p.token)).toEqual(["token-box-device-2"]);
    expect(box().api.remoteControl.revoke).toHaveBeenCalledWith("box-device-1");
    expect([...box().paired]).toEqual(["box-device-2"]);
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-2" }]);
  });

  it("gives a desktop window, or a device that is not paired, nothing", async () => {
    const local = localCtx({ hostLinks: links } as never);
    await expect(remoteControlLinkHostPairings(local, [])).resolves.toEqual([]);
    await expect(links.link("not-a-device", [])).resolves.toEqual([]);
    expect(box().api.remoteControl.pair).not.toHaveBeenCalled();
    expect(() => remoteControlLinkHostPairings(local, "room" as never)).toThrow(/room ids/);
  });

  it("answers a device through the handler", async () => {
    const id = await phone();
    const linked = await remoteControlLinkHostPairings(deviceCtx(id), ["room-box"]);
    expect(linked.map((p) => p.roomId)).toEqual(["room-wsl"]);
  });

  it("revoking the device revokes its pairing on every host, and owes an away host until it connects", async () => {
    const id = await phone();
    await links.link(id, []);
    expect([...box().paired]).toEqual(["box-device-1"]);
    expect([...wsl().paired]).toEqual(["wsl-device-1"]);

    wsl().state = "idle";
    const revoke = vi.fn(async (deviceId: string) => {
      await devices.revoke(deviceId);
      return {} as never;
    });
    await remoteControlRevoke(localCtx({ remoteControl: { revoke } } as never), id);
    expect(revoke).toHaveBeenCalledWith(id);

    // The box is up: revoked now. The wsl box is away: owed.
    await vi.waitFor(() => expect(box().paired.size).toBe(0));
    expect(records.box.pendingRevokes).toEqual([]);
    expect(records.wsl.pendingRevokes).toEqual(["wsl-device-1"]);
    expect([...wsl().paired]).toEqual(["wsl-device-1"]);

    // It connects: the owed revoke goes through, and is no longer owed.
    wsl().state = "connected";
    for (const listener of stateListeners) listener("wsl", "connected");
    await vi.waitFor(() => expect(wsl().paired.size).toBe(0));
    await vi.waitFor(() => expect(records.wsl.pendingRevokes).toEqual([]));
  });

  it("revoking every device at once (a relay reset) cascades too", async () => {
    const a = await phone("a");
    const b = await phone("b");
    await links.link(a, ["room-wsl"]);
    await links.link(b, ["room-wsl"]);
    expect(box().paired.size).toBe(2);
    await devices.revokeMany(devices.ids());
    await vi.waitFor(() => expect(box().paired.size).toBe(0));
  });

  it("turning the switch off revokes every linked pairing on that host, and mints none after", async () => {
    const a = await phone("a");
    const b = await phone("b");
    await links.link(a, []);
    await links.link(b, []);
    expect(box().paired.size).toBe(2);

    await links.setLinkPhones("box", false);
    expect(records.box.linkPhones).toBe(false);
    expect(box().paired.size).toBe(0);
    expect(records.box.pendingRevokes).toEqual([]);
    expect(links.linkedOn("box")).toEqual([]);
    // The other host keeps its links.
    expect(wsl().paired.size).toBe(2);
    expect(devices.hostLinks(a)).toEqual([{ hostId: "wsl", hostDeviceId: "wsl-device-1" }]);

    await expect(links.link(a, ["room-wsl"])).resolves.toEqual([]);
    expect(box().paired.size).toBe(0);
  });

  it("turning the switch off with the host away owes the revokes", async () => {
    const a = await phone();
    await links.link(a, ["room-wsl"]);
    box().state = "idle";
    await links.setLinkPhones("box", false);
    expect(records.box.pendingRevokes).toEqual(["box-device-1"]);
    expect(box().paired.size).toBe(1);
    box().state = "connected";
    for (const listener of stateListeners) listener("box", "connected");
    await vi.waitFor(() => expect(box().paired.size).toBe(0));
  });

  it("keeps a device's links across a restart", async () => {
    const id = await phone();
    await links.link(id, ["room-wsl"]);
    await devices.flush();
    const reopened = new RemoteDeviceStore(switchableBox(), path.join(dir, "devices.enc"));
    await reopened.init();
    expect(reopened.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-1" }]);
    // Never in what the settings page lists.
    expect(reopened.list()[0]).not.toHaveProperty("hostLinks");
  });
});
