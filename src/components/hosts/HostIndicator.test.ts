// @vitest-environment jsdom
/**
 * On a phone the merged sidebar names each machine by its
 * pairing, and a host's away state follows whichever server answers for it.
 * Three shapes: desktop + host both reachable, the host alone, and the
 * desktop alone with the host forwarded through it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { base64urlEncode } from "@manor/protocol/relay-crypto";
import type { BridgeTransport } from "../../bridge/client";
import { recordPairingHello, upsertPairing } from "../../bridge/pairings";
import {
  directReachability,
  isHostAway,
  servers,
  viaReachability,
} from "../../bridge/server-set";
import { isHostOffline } from "../../lib/host-status";
import { LOCAL_HOST_ID } from "../../lib/hosts";
import { useHostStore, type HostStatusInfo } from "../../store/host-store";
import { LocalHostLabel, RemoteHostLabel } from "./HostIndicator";

const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const DESKTOP = "AbCdEfGhIjKlMnOpQr_-01";
const BOX = "ZyXwVuTsRqPoNmLkJi_-02";

function transport(): BridgeTransport {
  return {
    start() {},
    rendererId: null,
    platform: "web",
    rootValues: {},
    localNamespaces: {},
    locallyServed: {},
    invoke: () => new Promise(() => {}),
    subscribe: () => () => {},
  };
}

function host(hostId: string, target: string): HostStatusInfo {
  return { hostId, spec: { kind: "ssh", target }, status: "connected" };
}

const offline = (hostId: string, hosts: readonly HostStatusInfo[]) =>
  isHostOffline(hostId, hosts, directReachability, viaReachability);

describe("the phone's merged sidebar, per source", () => {
  let container: HTMLDivElement;
  let root: Root;

  const text = (element: ReturnType<typeof createElement>) => {
    act(() => root.render(element));
    return container.textContent;
  };

  beforeEach(() => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    upsertPairing({ roomId: DESKTOP, serverKey: KEY, token: "a" }, 10);
    upsertPairing({ roomId: BOX, serverKey: KEY, token: "b" }, 20);
    servers.add(DESKTOP, transport(), { home: true, roomId: DESKTOP });
    // `install-web.ts` records each hello on the pairing too.
    recordPairingHello(DESKTOP, { hostName: "desk.local", hostServer: false });
    recordPairingHello(BOX, { hostName: "wsl-box", hostServer: true });
    servers.recordHello(DESKTOP, { hostName: "desk.local", hostServer: false });
    servers.setReachability(DESKTOP, "connected");
    servers.add(BOX, transport(), { roomId: BOX });
    servers.recordHello(BOX, { hostName: "wsl-box", hostServer: true });
    servers.setReachability(BOX, "connected");
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    servers.remove(BOX);
    servers.setLists(DESKTOP, []);
    useHostStore.setState({ hosts: [] });
    vi.unstubAllGlobals();
  });

  it("desktop + host, both reachable: each is named by its pairing and neither is away", () => {
    servers.setLists(DESKTOP, [BOX]);
    const hosts = [host(BOX, "me@box")];

    expect(text(createElement(LocalHostLabel))).toBe("desk.local");
    expect(text(createElement(RemoteHostLabel, { hostId: BOX }))).toBe("wsl-box");
    expect(offline(LOCAL_HOST_ID, hosts)).toBe(false);
    expect(offline(BOX, hosts)).toBe(false);
  });

  it("host only: the desktop's projects are away, the host's are not", () => {
    servers.setReachability(DESKTOP, "unreachable");
    servers.setLists(DESKTOP, [BOX]);
    const hosts = [host(BOX, "me@box")];

    expect(offline(LOCAL_HOST_ID, hosts)).toBe(true);
    // The host answers over its own bridge, whatever the desktop lists.
    expect(offline(BOX, hosts)).toBe(false);
  });

  it("desktop only, host forwarded: the host is away only when the desktop is", () => {
    servers.remove(BOX);
    servers.setLists(DESKTOP, ["via-id"]);
    const hosts = [host("via-id", "me@box")];
    useHostStore.setState({ hosts });

    expect(text(createElement(RemoteHostLabel, { hostId: "via-id" }))).toBe("me@box");
    expect(offline("via-id", hosts)).toBe(false);

    act(() => servers.setReachability(DESKTOP, "unreachable"));
    expect(offline("via-id", hosts)).toBe(true);
    expect(offline(LOCAL_HOST_ID, hosts)).toBe(true);
  });

  it("the desktop's own room, gone silent, is away though its last word says connected", () => {
    // The router stamps the desktop's `local` with its room, and the frozen
    // desktop's last `hosts.list` still says it is connected.
    const hosts = [host(DESKTOP, "local"), host(BOX, "me@box")];
    servers.setLists(DESKTOP, [BOX]);
    expect(isHostAway(DESKTOP, hosts)).toBe(false);

    servers.setReachability(DESKTOP, "unreachable");
    expect(isHostAway(DESKTOP, hosts)).toBe(true);
    expect(isHostAway(BOX, hosts)).toBe(false);
  });

  it("the desktop's own page never reads as a phone", () => {
    servers.setReachability(DESKTOP, "unreachable");
    servers.setLists(DESKTOP, ["h"]);
    // `LOCAL_HOST_ID` is home, but the home here is a relay room: a phone.
    expect(viaReachability(LOCAL_HOST_ID)).toBe("unreachable");
    expect(offline("unlisted", [host("unlisted", "x")])).toBe(false);
  });
});
