// @vitest-environment jsdom
/**
 * The phone's Hosts sheet lists every pairing with its state,
 * renames one, and removes one only after an in-place confirm. The
 * `phone-host-*` test ids are the phone E2E's.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

import { base64urlEncode } from "@manor/protocol/relay-crypto";
import type { BridgeTransport } from "../../../../bridge/client";
import { declinePairing, listPairings, upsertPairing } from "../../../../bridge/pairings";
import { servers } from "../../../../bridge/server-set";
import { HostsSheet } from "../HostsSheet";
import { useHostStore } from "../../../../store/host-store";

const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const A = "AbCdEfGhIjKlMnOpQr_-01";
const B = "ZyXwVuTsRqPoNmLkJi_-02";

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

// The page's set, as `install-web.ts` fills it: the desktop home, a host.
servers.add(A, transport(), { home: true, roomId: A });
servers.add(B, transport(), { roomId: B });

describe("HostsSheet", () => {
  let map: Map<string, string>;
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const click = (el: HTMLElement | null | undefined) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

  beforeEach(() => {
    map = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" }, 20);
    servers.recordHello(A, { hostName: "desk.local", hostServer: false });
    servers.setReachability(A, "connected");
    servers.recordHello(B, { hostName: "wsl-box", hostServer: true });
    servers.setReachability(B, "unreachable");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(HostsSheet, { open: true, onOpenChange: () => {} })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lists every pairing with how it is doing", () => {
    const rows = all("phone-host-option");
    expect(rows.map((r) => r.getAttribute("data-room-id"))).toEqual([A, B]);
    expect(rows.map((r) => r.querySelector('[data-testid="phone-host-status"]')?.textContent)).toEqual([
      "Connected · Desktop",
      "Not reachable",
    ]);
    // Home is marked.
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[1].getAttribute("aria-current")).toBeNull();
  });

  it("renames a pairing", () => {
    click(all("phone-host-rename")[1]);
    const input = q("phone-host-rename-input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Build box");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(q("phone-host-rename-save"));
    expect(listPairings().find((p) => p.roomId === B)).toMatchObject({
      name: "Build box",
      customName: true,
    });
    expect(all("phone-host-option")[1].textContent).toContain("Build box");
  });

  it("asks in place before removing a pairing", () => {
    click(all("phone-host-remove")[1]);
    expect(q("phone-host-option")?.textContent).not.toContain("Remove");
    expect(listPairings()).toHaveLength(2);
    click(q("phone-host-remove-cancel"));
    expect(listPairings()).toHaveLength(2);
    click(all("phone-host-remove")[1]);
    click(q("phone-host-remove-confirm"));
    expect(listPairings().map((p) => p.roomId)).toEqual([A]);
    expect(all("phone-host-option")).toHaveLength(1);
  });

  describe("a host asleep", () => {
    const wake = vi.fn();

    beforeEach(() => {
      wake.mockReset().mockResolvedValue(undefined);
      Object.assign(window, { electronAPI: { hosts: { wake } } });
      // The desktop (home) lists the host by its room, and says it sleeps.
      act(() => {
        servers.setLists(A, [B]);
        useHostStore.setState({
          hosts: [{ hostId: B, spec: { kind: "recipe", recipeId: "dev-pod" }, status: "sleeping" }],
        });
      });
    });

    afterEach(() => {
      act(() => useHostStore.setState({ hosts: [] }));
      delete (window as { electronAPI?: unknown }).electronAPI;
    });

    it("reads Asleep, and Wake asks the desktop to start it", async () => {
      const row = all("phone-host-option")[1];
      expect(row.getAttribute("data-state")).toBe("asleep");
      expect(row.querySelector('[data-testid="phone-host-status"]')?.textContent).toBe("Asleep");
      click(row.querySelector<HTMLElement>('[data-testid="phone-host-wake"]'));
      await act(async () => {});
      expect(wake).toHaveBeenCalledWith(B);
    });

    it("says the desktop is away when there is none to wake it", () => {
      act(() => servers.setReachability(A, "unreachable"));
      const row = all("phone-host-option")[1];
      expect(row.querySelector('[data-testid="phone-host-wake"]')).toBeNull();
      expect(row.querySelector('[data-testid="phone-host-status"]')?.textContent).toBe(
        "Host 2 is asleep, and Host 1 is away",
      );
    });
  });

  describe("a host reached only through the desktop", () => {
    const C = "QwErTyUiOpAsDfGhJk_-03";

    beforeEach(() => {
      act(() =>
        useHostStore.setState({
          hosts: [
            { hostId: B, spec: { kind: "ssh", target: "wsl-box" }, status: "connected", roomId: B },
            { hostId: C, spec: { kind: "ssh", target: "blade" }, status: "connected", roomId: C },
          ],
        }),
      );
    });

    afterEach(() => {
      act(() => useHostStore.setState({ hosts: [] }));
    });

    // The user removed it here by hand.
    const declineC = () =>
      act(() => {
        declinePairing(upsertPairing({ roomId: C, serverKey: KEY, token: "old" }));
      });

    it("is listed after the pairings, and Connect directly asks for a pairing of its own", async () => {
      declineC();
      const rows = all("phone-host-indirect");
      expect(rows.map((r) => r.getAttribute("data-host-id"))).toEqual([C]);
      expect(rows[0].textContent).toContain("blade");
      expect(rows[0].textContent).toContain("Removed here · only through Host 1");
      const relink = vi.fn(async () => {
        const { linkPairing } = await import("../../../../bridge/pairings");
        linkPairing({ roomId: C, serverKey: KEY, token: "c", name: "blade" });
      });
      const { registerRelink } = await import("../../../../bridge/pairings");
      registerRelink(relink);
      click(q("phone-host-connect-directly"));
      await act(async () => {});
      expect(relink).toHaveBeenCalledOnce();
      expect(all("phone-host-indirect")).toHaveLength(0);
      expect(all("phone-host-option").map((r) => r.getAttribute("data-room-id"))).toEqual([A, B, C]);
    });

    it("offers no way back for a host that was not removed here", () => {
      const rows = all("phone-host-indirect");
      expect(rows[0].textContent).toContain("Only through Host 1");
      expect(rows[0].textContent).not.toContain("Removed here");
      expect(q("phone-host-connect-directly")).toBeNull();
    });

    it("cannot connect directly while the desktop is away", () => {
      declineC();
      act(() => servers.setReachability(A, "unreachable"));
      expect((q("phone-host-connect-directly") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
