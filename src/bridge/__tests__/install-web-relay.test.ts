/**
 * `install-web.ts` on a relay-served page (ADR-206 D3, D4) — the only kind
 * there is (ADR-207 D2): the fragment picks the relay pipe, the host's
 * `appVersion` redirects once, relay 4404 reads as "not reachable", and a bad
 * message 2 does not forget it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import type { ElectronAPI } from "../../electron";
import { PAIRINGS_KEY } from "../pairings";
import { desktopKey, FakeRelaySocket } from "./fake-relay";

const ROOM = "AbCdEfGhIjKlMnOpQr_-01";

type InstallWeb = typeof import("../install-web");

describe("install-web on a relay-served page", () => {
  let local: Map<string, string>;
  let session: Map<string, string>;
  let replace: ReturnType<typeof vi.fn>;
  let previousApi: unknown;

  function storage(map: Map<string, string>): Partial<Storage> {
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  async function install(
    hash: string,
    pathname = "/app/1.0.0/",
  ): Promise<{
    mod: InstallWeb;
    api: ElectronAPI;
  }> {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "relay.test",
      hash,
      pathname,
      search: "",
      replace,
    });
    const mod = await import("../install-web");
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
    return { mod, api };
  }

  function relayHash(): string {
    return `#relay=${ROOM}.${base64urlEncode(FakeRelaySocket.key.pub)}&t=tok`;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    previousApi = (window as unknown as { electronAPI?: unknown }).electronAPI;
    FakeRelaySocket.instances = [];
    FakeRelaySocket.key = desktopKey();
    local = new Map();
    session = new Map();
    replace = vi.fn();
    vi.stubGlobal("WebSocket", FakeRelaySocket);
    vi.stubGlobal("localStorage", storage(local));
    vi.stubGlobal("sessionStorage", storage(session));
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("__APP_VERSION__", "1.0.0");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (window as unknown as { electronAPI?: unknown }).electronAPI = previousApi;
  });

  it("dials the relay's /join with the token from the link", async () => {
    const { mod, api } = await install(relayHash());
    expect(mod.webToken).toBe("tok");
    expect(local.has(PAIRINGS_KEY)).toBe(true);

    void api.projects.getAll().catch(() => {});
    const socket = FakeRelaySocket.last;
    expect(socket.url).toBe(`wss://relay.test/join/${ROOM}`);
    socket.handshake();
    expect(socket.frames[0]).toEqual({ type: "hello", token: "tok" });
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to the desktop's version once per session", async () => {
    const { api } = await install(relayHash());
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake({ appVersion: "1.1.0" });
    expect(replace).toHaveBeenCalledExactlyOnceWith("/app/1.1.0/");

    // The new page loads (same session) and still disagrees: it stays.
    vi.resetModules();
    const again = await install("");
    expect(again.mod.webToken).toBe("tok");
    void again.api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake({ appVersion: "1.1.0" });
    expect(replace).toHaveBeenCalledOnce();
  });

  it("follows a later desktop update once the page has arrived", async () => {
    const { api } = await install(relayHash());
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake({ appVersion: "1.1.0" });
    expect(replace).toHaveBeenLastCalledWith("/app/1.1.0/");

    // The 1.1.0 build loads and matches, then the desktop updates to 1.2.0.
    vi.resetModules();
    vi.stubGlobal("__APP_VERSION__", "1.1.0");
    const arrived = await install("", "/app/1.1.0/");
    void arrived.api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake({ appVersion: "1.1.0" });
    expect(replace).toHaveBeenCalledOnce();
    FakeRelaySocket.last.drop(1006);
    arrived.mod.retryBridgeNow();
    FakeRelaySocket.last.handshake({ appVersion: "1.2.0" });
    expect(replace).toHaveBeenLastCalledWith("/app/1.2.0/");
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("does not take a desktop that names itself for a host server", async () => {
    const { api } = await install(relayHash());
    const connection = await import("../connection");
    void api.projects.getAll().catch(() => {});
    // The desktop sends `hostName` too (ADR-225 D7), but no `hostServer`.
    FakeRelaySocket.last.handshake({ hostName: "desk.local" });
    expect(connection.getConnection()).toEqual({
      activeRoomId: ROOM,
      hostName: "desk.local",
      isHostServer: false,
    });
    expect(JSON.parse(local.get(PAIRINGS_KEY) ?? "[]")[0].name).toBe("desk.local");
  });

  it("learns from the hello whether the host is a host server", async () => {
    const { api } = await install(relayHash());
    // `vi.resetModules()` gives each install a fresh `connection.ts`: read
    // the one this install wrote to.
    const connection = await import("../connection");
    expect(connection.getConnection()).toEqual({
      activeRoomId: ROOM,
      hostName: null,
      isHostServer: false,
    });
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake({ hostName: "Studio", hostServer: true });
    expect(connection.getConnection()).toEqual({
      activeRoomId: ROOM,
      hostName: "Studio",
      isHostServer: true,
    });
    expect(JSON.parse(local.get(PAIRINGS_KEY) ?? "[]")[0].name).toBe("Studio");
  });

  it("keeps the relay pairing when an anchor link opens a new tab", async () => {
    await install(relayHash());
    vi.resetModules();
    const { mod } = await install("#details");
    expect(mod.webToken).toBe("tok");
    expect(local.has(PAIRINGS_KEY)).toBe(true);
  });

  it("dials nothing with an old listener link and no relay pairing", async () => {
    // The loopback listener's `/app#<token>` link (ADR-207 D2): stripped,
    // never stored, and nothing to dial.
    const token = base64urlEncode(new Uint8Array(32).fill(3));
    const { mod, api } = await install(`#${token}`, "/app/");
    expect(mod.webToken).toBeNull();
    await expect(api.projects.getAll()).rejects.toThrow(/not paired/);
    expect(FakeRelaySocket.instances).toHaveLength(0);
    expect(local.size).toBe(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it("reports 4404 as unreachable until the next hello", async () => {
    const { mod, api } = await install(relayHash());
    const seen: string[] = [];
    mod.subscribeReachability(() => seen.push(mod.getReachability()));
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.drop(4404);
    expect(mod.getReachability()).toBe("unreachable");
    mod.retryBridgeNow();
    FakeRelaySocket.last.handshake();
    expect(mod.getReachability()).toBe("connected");
    expect(seen).toEqual(["unreachable", "connected"]);
    expect(local.has(PAIRINGS_KEY)).toBe(true);
  });

  it("emits a resync on a resumed hello, not the first", async () => {
    const { api } = await install(relayHash());
    // Same module registry as the install above, so the same listener set.
    const { onBridgeResync } = await import("../resync");
    const resync = vi.fn();
    onBridgeResync(resync);
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake();
    expect(resync).not.toHaveBeenCalled();

    FakeRelaySocket.last.drop(1006);
    vi.advanceTimersByTime(1_000);
    FakeRelaySocket.last.handshake();
    expect(resync).toHaveBeenCalledOnce();
  });

  /** Whether `promise` has settled, without waiting on it. */
  async function isSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    return settled;
  }

  it("refreshBridge re-fetches over a live line, and waits for it", async () => {
    const { mod, api } = await install(relayHash());
    const { onBridgeResync } = await import("../resync");
    let finish: () => void = () => {};
    const resync = vi.fn(() => new Promise<void>((r) => (finish = r)));
    onBridgeResync(resync);
    void api.projects.getAll().catch(() => {});
    const socket = FakeRelaySocket.last;
    socket.handshake();

    const refreshed = mod.refreshBridge();
    socket.pong();
    await vi.advanceTimersByTimeAsync(0);
    expect(resync).toHaveBeenCalledOnce();
    expect(await isSettled(refreshed)).toBe(false);
    finish();
    await refreshed;
    expect(FakeRelaySocket.instances).toHaveLength(1);
  });

  it("refreshBridge redials a dead line and waits for its hello's resync", async () => {
    const { mod, api } = await install(relayHash());
    const { onBridgeResync } = await import("../resync");
    const resync = vi.fn();
    onBridgeResync(resync);
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake();

    const refreshed = mod.refreshBridge();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(resync).not.toHaveBeenCalled();
    expect(FakeRelaySocket.instances).toHaveLength(2);
    expect(await isSettled(refreshed)).toBe(false);
    FakeRelaySocket.last.handshake();
    expect(resync).toHaveBeenCalledOnce();
    await refreshed;
  });

  it("refreshBridge stops waiting on a redial that never says hello", async () => {
    const { mod, api } = await install(relayHash());
    void api.projects.getAll().catch(() => {});
    FakeRelaySocket.last.handshake();

    const refreshed = mod.refreshBridge();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await isSettled(refreshed)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await isSettled(refreshed)).toBe(true);
  });

  it("keeps the pairing on a message 2 that does not authenticate", async () => {
    const { mod, api } = await install(relayHash());
    const outcome = vi.fn();
    mod.onBridgeOutcome(outcome);
    void api.projects.getAll().catch(() => {});
    const socket = FakeRelaySocket.last;
    socket.accept();
    // Stale or misrouted bytes far more often than a different key: the
    // pipe reconnects instead of forgetting (relay-pipe.ts, "Failures").
    socket.deliverRaw(new Uint8Array(48).fill(1));
    expect(outcome).not.toHaveBeenCalled();
    expect(local.has(PAIRINGS_KEY)).toBe(true);
  });

  it("settles key-mismatch after repeated bad message 2s, keeping the pairing", async () => {
    const { mod, api } = await install(relayHash());
    const outcome = vi.fn();
    mod.onBridgeOutcome(outcome);
    void api.projects.getAll().catch(() => {});
    for (let i = 0; i < 3; i++) {
      const socket = FakeRelaySocket.last;
      socket.accept();
      socket.deliverRaw(new Uint8Array(48).fill(1));
      if (i < 2) {
        expect(outcome).not.toHaveBeenCalled();
        vi.advanceTimersByTime(30_000);
      }
    }
    expect(outcome).toHaveBeenCalledExactlyOnceWith("key-mismatch");
    expect(local.has(PAIRINGS_KEY)).toBe(true);
  });
});
