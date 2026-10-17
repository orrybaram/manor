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
  /** Each paired device's label and creation time, as `listDevices` reads them. */
  const rows = new Map<string, { label: string; createdAt: number }>();
  let minted = 0;
  const host = {
    hostId,
    state: "connected" as HostServerClientState,
    roomId,
    paired,
    rows,
    /** The user pairs a phone on the host itself, not through this desktop. */
    pairDirectly(label: string): string {
      const id = `${hostId}-direct-${++minted}`;
      paired.add(id);
      rows.set(id, { label, createdAt: Date.now() });
      return id;
    },
    subscribe: vi.fn(() => () => {}),
    api: {
      hostServer: {
        status: vi.fn(async () => ({
          roomId: host.roomId,
          capabilities: ["viewer-bridge"],
          ownership: "owned",
          relay: { roomId: host.roomId, connected: true, error: null },
          pushEndpoints: [],
        })),
      },
      remoteControl: {
        pair: vi.fn(async (label: string) => {
          const id = `${hostId}-device-${++minted}`;
          paired.add(id);
          rows.set(id, { label, createdAt: Date.now() });
          return {
            device: { id, label },
            rawToken: `token-${id}`,
            pairingUrl: `https://relay.test/app/1/#relay=${host.roomId}.${KEY}&t=token-${id}`,
          };
        }),
        listDevices: vi.fn(async () =>
          [...paired].map((id) => ({
            id,
            label: rows.get(id)?.label ?? "",
            createdAt: rows.get(id)?.createdAt ?? 0,
            lastSeenAt: null,
            hasPush: false,
          })),
        ),
        revoke: vi.fn(async (id: string) => {
          if (host.state !== "connected") throw new Error("host away");
          paired.delete(id);
          rows.delete(id);
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
  let records: Record<
    string,
    {
      linkPhones: boolean;
      pendingRevokes: string[];
      pendingMints: Array<{ label: string; startedAt: number }>;
    }
  >;
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
      box: { linkPhones: true, pendingRevokes: [], pendingMints: [] },
      wsl: { linkPhones: true, pendingRevokes: [], pendingMints: [] },
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
        pendingMints: (id) => records[id].pendingMints,
        addPendingMint: (id, mint) => {
          records[id].pendingMints = [...records[id].pendingMints, mint];
        },
        clearPendingMints: (id, labels) => {
          records[id].pendingMints = records[id].pendingMints.filter(
            (m) => !labels.includes(m.label),
          );
        },
        forgetOwed: (id) => {
          records[id].pendingRevokes = [];
          records[id].pendingMints = [];
        },
        pendingRevokes: (id) => records[id].pendingRevokes,
      },
      revokePending: (id) => sync.revokePending(id),
      pairingChanged,
      log: { warn: () => {} },
    });
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
      pendingMints: links.pendingMints(),
      reconcileLinks: (id) => links.reconcileLinks(id),
      log: { warn: () => {} },
    });
    sync.start();
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
    // Under its label, with a suffix no pairing made on the host shares.
    expect(box().api.remoteControl.pair).toHaveBeenCalledWith(
      expect.stringMatching(/^Orry's phone \([0-9a-f]{6}\)$/),
    );
    expect(wsl().api.remoteControl.pair).not.toHaveBeenCalled();
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-1", roomId: "room-box" }]);
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
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-2", roomId: "room-box" }]);
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
    expect(devices.hostLinks(a)).toEqual([{ hostId: "wsl", hostDeviceId: "wsl-device-1", roomId: "room-wsl" }]);

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

  /** The host's owner channel comes back: `HostServerSync` runs its connect work. */
  const reconnect = (host: FakeHost) => {
    host.state = "connected";
    for (const listener of stateListeners) listener(host.hostId, "connected");
  };

  it("revokes a pairing the host committed whose answer was lost, on the next connect (R7 b)", async () => {
    const id = await phone();
    const pair = box().api.remoteControl.pair.getMockImplementation()!;
    box().api.remoteControl.pair.mockImplementationOnce(async (label: string) => {
      await pair(label);
      box().state = "idle";
      throw new Error("owner channel closed");
    });
    await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
    expect([...box().paired]).toEqual(["box-device-1"]);
    expect(records.box.pendingMints).toHaveLength(1);

    reconnect(box());
    await vi.waitFor(() => expect(box().paired.size).toBe(0));
    expect(box().api.remoteControl.revoke).toHaveBeenCalledWith("box-device-1");
    await vi.waitFor(() => expect(records.box.pendingMints).toEqual([]));
    expect(devices.hostLinks(id)).toEqual([]);
  });

  it("records no link when the host's room changed between status and pair, and mints again next time (R7 a)", async () => {
    const id = await phone();
    const pair = box().api.remoteControl.pair.getMockImplementation()!;
    box().api.remoteControl.pair.mockImplementationOnce(async (label: string) => {
      // Reset by something else (the box's CLI) after the status read.
      box().roomId = "room-box-2";
      return pair(label);
    });
    await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
    expect(devices.hostLinks(id)).toEqual([]);
    expect(records.box.pendingMints).toEqual([]);
    // Owed, and revoked at once since the host is up.
    expect(box().api.remoteControl.revoke).toHaveBeenCalledWith("box-device-1");
    expect(records.box.pendingRevokes).toEqual([]);

    const again = await links.link(id, ["room-wsl"]);
    expect(again.map((p) => p.roomId)).toEqual(["room-box-2"]);
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-2", roomId: "room-box-2" }]);
  });

  it("runs a reset queued during a mint after it, and leaves the host with no links and nothing owed (R7 a)", async () => {
    const id = await phone();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pair = box().api.remoteControl.pair.getMockImplementation()!;
    box().api.remoteControl.pair.mockImplementationOnce(async (label: string) => {
      await gate;
      order.push("pair");
      return pair(label);
    });
    records.box.pendingRevokes = ["box-old"];

    const linking = links.link(id, ["room-wsl"]);
    await vi.waitFor(() => expect(box().api.remoteControl.pair).toHaveBeenCalled());
    const resetting = links.resetHost("box", async () => {
      order.push("reset");
      box().paired.clear();
      box().roomId = "room-box-2";
      return "status";
    });
    release();
    await expect(resetting).resolves.toBe("status");
    await linking;

    expect(order).toEqual(["pair", "reset"]);
    expect(devices.hostLinks(id)).toEqual([]);
    expect(links.linkedOn("box")).toEqual([]);
    expect(records.box.pendingRevokes).toEqual([]);
    expect(records.box.pendingMints).toEqual([]);
  });

  it("leaves a mint still in flight alone when the host's connect work runs meanwhile", async () => {
    const id = await phone();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pair = box().api.remoteControl.pair.getMockImplementation()!;
    box().api.remoteControl.pair.mockImplementationOnce(async (label: string) => {
      const out = await pair(label);
      await gate;
      return out;
    });
    const linking = links.link(id, ["room-wsl"]);
    await vi.waitFor(() => expect(box().paired.size).toBe(1));
    // A connect lands while the answer is on its way.
    await sync.reconcileMints("box");
    release();
    expect((await linking).map((p) => p.roomId)).toEqual(["room-box"]);
    expect([...box().paired]).toEqual(["box-device-1"]);
    expect(devices.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-1", roomId: "room-box" }]);
    expect(records.box.pendingMints).toEqual([]);
  });

  it("never revokes a pairing the user made on the host, however alike its label", async () => {
    const id = await phone();
    const pair = box().api.remoteControl.pair.getMockImplementation()!;
    box().api.remoteControl.pair.mockImplementationOnce(async (label: string) => {
      await pair(label);
      // The user pairs the same phone on the host by hand, under its own name.
      box().pairDirectly("Orry's phone");
      box().state = "idle";
      throw new Error("owner channel closed");
    });
    await links.link(id, ["room-wsl"]);
    const direct = [...box().paired].find((d) => d.includes("direct"))!;

    reconnect(box());
    await vi.waitFor(() => expect(records.box.pendingMints).toEqual([]));
    expect([...box().paired]).toEqual([direct]);
    expect(box().api.remoteControl.revoke).not.toHaveBeenCalledWith(direct);
  });

  describe("a pairing revoked on the host (ADR-238 D2)", () => {
    /** The phone, linked on the box only. */
    const linkedOnBox = async () => {
      const id = await phone();
      await links.link(id, ["room-wsl"]);
      expect(devices.hostLinks(id)).toEqual([
        { hostId: "box", hostDeviceId: "box-device-1", roomId: "room-box" },
      ]);
      return id;
    };
    const revokeOnBox = (hostDeviceId: string) =>
      links.revokeOnHost("box", hostDeviceId, () =>
        box().api.remoteControl.revoke(hostDeviceId),
      );

    it("revokeOnHost blocks the phone there, and only there", async () => {
      const id = await linkedOnBox();
      await revokeOnBox("box-device-1");
      expect(box().paired.size).toBe(0);
      expect(devices.hostLinks(id)).toEqual([]);
      expect(links.blockedOn("box")).toEqual([{ deviceId: id, label: "Orry's phone" }]);

      // Its next hello holds neither room: the wsl box mints, the box does not.
      const linked = await links.link(id, []);
      expect(linked.map((p) => p.roomId)).toEqual(["room-wsl"]);
      expect(box().api.remoteControl.pair).toHaveBeenCalledTimes(1);
      expect(devices.hostLinks(id).map((l) => l.hostId)).toEqual(["wsl"]);
    });

    it("turning the switch off and on lifts the block", async () => {
      const id = await linkedOnBox();
      await revokeOnBox("box-device-1");
      await links.setLinkPhones("box", false);
      await links.setLinkPhones("box", true);
      expect(links.blockedOn("box")).toEqual([]);
      const linked = await links.link(id, ["room-wsl"]);
      expect(linked.map((p) => p.roomId)).toEqual(["room-box"]);
    });

    it("a reset of the host's keys keeps the block", async () => {
      const id = await linkedOnBox();
      await revokeOnBox("box-device-1");
      await links.resetHost("box", async () => {
        box().paired.clear();
        box().roomId = "room-box-2";
      });
      expect(links.blockedOn("box")).toEqual([{ deviceId: id, label: "Orry's phone" }]);
      await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
      expect(box().api.remoteControl.pair).toHaveBeenCalledTimes(1);
    });

    it("finds a revoke made on the box before minting again, and mints nothing", async () => {
      const id = await linkedOnBox();
      // Revoked on the box itself; the phone was refused and let the room go.
      box().paired.delete("box-device-1");
      await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
      expect(box().api.remoteControl.listDevices).toHaveBeenCalled();
      expect(box().api.remoteControl.pair).toHaveBeenCalledTimes(1);
      expect(devices.hostLinks(id)).toEqual([]);
      expect(links.blockedOn("box")).toEqual([{ deviceId: id, label: "Orry's phone" }]);
    });

    it("re-mints after a reset made elsewhere, in the new room, without blocking", async () => {
      const id = await linkedOnBox();
      box().paired.clear();
      box().roomId = "room-box-2";
      const linked = await links.link(id, ["room-wsl"]);
      expect(linked.map((p) => p.roomId)).toEqual(["room-box-2"]);
      expect(links.blockedOn("box")).toEqual([]);
      expect(box().api.remoteControl.revoke).not.toHaveBeenCalled();
      expect(devices.hostLinks(id)).toEqual([
        { hostId: "box", hostDeviceId: "box-device-2", roomId: "room-box-2" },
      ]);
    });

    it("mints nothing when the host's device list cannot be read", async () => {
      const id = await linkedOnBox();
      box().api.remoteControl.listDevices.mockRejectedValueOnce(new Error("boom"));
      await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
      expect(box().api.remoteControl.pair).toHaveBeenCalledTimes(1);
      expect(links.blockedOn("box")).toEqual([]);
      expect(devices.hostLinks(id)).toHaveLength(1);
    });

    it("on reconnect, blocks a phone revoked on the box", async () => {
      const id = await linkedOnBox();
      box().paired.delete("box-device-1");
      pairingChanged.mockClear();
      reconnect(box());
      await vi.waitFor(() =>
        expect(links.blockedOn("box")).toEqual([{ deviceId: id, label: "Orry's phone" }]),
      );
      expect(devices.hostLinks(id)).toEqual([]);
      expect(pairingChanged).toHaveBeenCalledWith("box");
    });

    it("on reconnect, forgets a link lost to a reset elsewhere, without blocking", async () => {
      const id = await linkedOnBox();
      box().paired.clear();
      box().roomId = "room-box-2";
      reconnect(box());
      await vi.waitFor(() => expect(devices.hostLinks(id)).toEqual([]));
      expect(links.blockedOn("box")).toEqual([]);
    });

    it("on reconnect, leaves a link the host still lists alone", async () => {
      const id = await linkedOnBox();
      pairingChanged.mockClear();
      await links.reconcileLinks("box");
      expect(devices.hostLinks(id)).toHaveLength(1);
      expect(links.blockedOn("box")).toEqual([]);
      expect(pairingChanged).not.toHaveBeenCalled();
    });

    it("never blocks a phone whose old link this desktop revoked after a failed mint", async () => {
      const id = await linkedOnBox();
      // The phone let the room go; the mint that would replace its link fails.
      box().api.remoteControl.pair.mockRejectedValueOnce(new Error("owner channel closed"));
      await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
      expect(records.box.pendingRevokes).toEqual(["box-device-1"]);
      expect(devices.hostLinks(id)).toEqual([]);

      // The owed revoke goes through on the next connect; nothing is blocked.
      reconnect(box());
      await vi.waitFor(() => expect(records.box.pendingRevokes).toEqual([]));
      expect(links.blockedOn("box")).toEqual([]);
      const linked = await links.link(id, ["room-wsl"]);
      expect(linked.map((p) => p.roomId)).toEqual(["room-box"]);
    });

    it("takes a link from before ADR-238, missing from the host, as revoked", async () => {
      const id = await phone();
      await devices.setHostLink(id, { hostId: "box", hostDeviceId: "box-old" });
      await expect(links.link(id, ["room-wsl"])).resolves.toEqual([]);
      expect(box().api.remoteControl.pair).not.toHaveBeenCalled();
      expect(links.blockedOn("box")).toEqual([{ deviceId: id, label: "Orry's phone" }]);
    });
  });

  it("keeps a device's links across a restart", async () => {
    const id = await phone();
    await links.link(id, ["room-wsl"]);
    await devices.flush();
    const reopened = new RemoteDeviceStore(switchableBox(), path.join(dir, "devices.enc"));
    await reopened.init();
    expect(reopened.hostLinks(id)).toEqual([{ hostId: "box", hostDeviceId: "box-device-1", roomId: "room-box" }]);
    // Never in what the settings page lists.
    expect(reopened.list()[0]).not.toHaveProperty("hostLinks");
  });
});
