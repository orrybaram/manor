import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BridgeTransport } from "../../bridge/client";
import { recordPairingHello, upsertPairing } from "../../bridge/pairings";
import { servers } from "../../bridge/server-set";
import { base64urlEncode } from "@manor/protocol/relay-crypto";
import { runAutoJoin, startAutoJoin, type AutoJoinDeps } from "../auto-join";
import { useHostStore } from "../host-store";
import { clearRecords, toastStore } from "../../toast/toast-store";

// Main joins same-origin projects; the store shows one toast per
// pair (a summary from three), each with an Undo that reverts via main.

const api = {
  autoJoin: vi.fn(),
  undoAutoJoin: vi.fn(async () => {}),
};

vi.stubGlobal("window", { ...globalThis.window, electronAPI: { projects: api } });

const PROJECTS = [
  { id: "local-app", name: "manor", hostId: "local" },
  { id: "box-app", name: "manor", hostId: "box" },
  { id: "mac-app", name: "other", hostId: "mac" },
  { id: "p4", name: "p4", hostId: "box" },
  { id: "p5", name: "p5", hostId: "box" },
];

/** A phone whose home server is the relay room of a desktop called desk.local. */
function onPhone(): () => void {
  const map = new Map<string, string>();
  const prior = (globalThis as { localStorage?: Storage }).localStorage;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  const room = "AbCdEfGhIjKlMnOpQr_-01";
  upsertPairing({ roomId: room, serverKey: base64urlEncode(new Uint8Array(32)), token: "t" });
  recordPairingHello(room, { hostName: "desk.local", hostServer: false });
  const transport = { invoke: () => new Promise(() => {}), subscribe: () => () => {} };
  servers.add(room, transport as unknown as BridgeTransport, { home: true, roomId: room });
  return () => {
    servers.remove(room);
    vi.stubGlobal("localStorage", prior);
  };
}

const reload = vi.fn(async () => {});
const deps: AutoJoinDeps = { getProjects: () => PROJECTS, reload };
const toasts = () => toastStore.getState().toasts;

beforeEach(() => {
  vi.clearAllMocks();
  clearRecords();
  useHostStore.setState({
    hosts: [{ hostId: "box", spec: { kind: "ssh", target: "me@box" }, status: "connected" }],
  } as never);
});

describe("runAutoJoin", () => {
  it("does nothing, and does not reload, when nothing joined", async () => {
    api.autoJoin.mockResolvedValue([]);
    await runAutoJoin(deps);
    expect(reload).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it("shows nothing when main fails", async () => {
    api.autoJoin.mockRejectedValue(new Error("boom"));
    await runAutoJoin(deps);
    expect(toasts()).toEqual([]);
  });

  it("reloads and toasts one pair with an Undo that unjoins via main", async () => {
    api.autoJoin.mockResolvedValue([{ joinedId: "box-app", intoId: "local-app" }]);
    await runAutoJoin(deps);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toBe("Joined manor on me@box with manor on This machine");
    expect(toasts()[0].action?.label).toBe("Undo");

    toasts()[0].action!.onClick();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(api.undoAutoJoin).toHaveBeenCalledWith("box-app", "local-app");
    expect(toasts()).toEqual([]);
  });

  it("one toast per pair for two pairs", async () => {
    api.autoJoin.mockResolvedValue([
      { joinedId: "box-app", intoId: "local-app" },
      { joinedId: "mac-app", intoId: "local-app" },
    ]);
    await runAutoJoin(deps);
    expect(toasts()).toHaveLength(2);
  });

  it("three pairs make one summary whose Undo reverts all of them", async () => {
    const pairs = [
      { joinedId: "box-app", intoId: "local-app" },
      { joinedId: "p4", intoId: "mac-app" },
      { joinedId: "p5", intoId: "mac-app" },
    ];
    api.autoJoin.mockResolvedValue(pairs);
    await runAutoJoin(deps);

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toBe("Joined 3 projects across hosts");
    toasts()[0].action!.onClick();
    await vi.waitFor(() => expect(api.undoAutoJoin).toHaveBeenCalledTimes(3));
    expect(api.undoAutoJoin.mock.calls).toEqual(pairs.map((p) => [p.joinedId, p.intoId]));
  });
});

describe("startAutoJoin", () => {
  it("runs now and again the first time a host connects, not on reconnect", async () => {
    api.autoJoin.mockResolvedValue([]);
    useHostStore.setState({
      hosts: [{ hostId: "cloud", spec: { kind: "ssh", target: "me@cloud" }, status: "connecting" }],
    } as never);
    await startAutoJoin(deps);
    expect(api.autoJoin).toHaveBeenCalledTimes(1);

    const set = (status: string) =>
      useHostStore.setState({
        hosts: [{ hostId: "cloud", spec: { kind: "ssh", target: "me@cloud" }, status }],
      } as never);
    set("connected");
    expect(api.autoJoin).toHaveBeenCalledTimes(2);
    set("disconnected");
    set("connected");
    expect(api.autoJoin).toHaveBeenCalledTimes(2);
  });
});

describe("on a phone", () => {
  it("names the desktop instead of This machine", async () => {
    const off = onPhone();
    try {
      api.autoJoin.mockResolvedValue([{ joinedId: "box-app", intoId: "local-app" }]);
      await runAutoJoin(deps);
      expect(toasts()[0].message).toBe("Joined manor on me@box with manor on desk.local");
    } finally {
      off();
    }
  });
});
