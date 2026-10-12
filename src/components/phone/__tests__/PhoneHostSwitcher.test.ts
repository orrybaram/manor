// @vitest-environment jsdom
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

import { base64urlEncode } from "../../../lib/relay-crypto";
import {
  listPairings,
  setActiveRoom,
  upsertPairing,
} from "../../../bridge/pairings";
import { PhoneHostSwitcher } from "../PhoneHostSwitcher";

const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const A = "AbCdEfGhIjKlMnOpQr_-01";
const B = "ZyXwVuTsRqPoNmLkJi_-02";

describe("PhoneHostSwitcher", () => {
  let map: Map<string, string>;
  let container: HTMLDivElement;
  let root: Root;
  const onReload = vi.fn();

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) =>
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
    onReload.mockClear();
    setActiveRoom(A);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => root.render(createElement(PhoneHostSwitcher, { onReload })));
  }

  it("renders nothing with fewer than two pairings", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" });
    render();
    expect(q("phone-host-switcher")).toBeNull();
  });

  it("lists hosts and switching marks the room last used and reloads", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" }, 5);
    render();
    expect(q("phone-host-switcher")?.textContent).toContain("Host 1");
    click(q("phone-host-switcher"));
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="phone-host-option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["Host 1", "Host 2"]);
    click(options[1]);
    expect(onReload).toHaveBeenCalledOnce();
    expect(listPairings().find((p) => p.roomId === B)!.lastUsedAt).toBeGreaterThan(10);
  });

  it("asks inline before removing a pairing", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" });
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" });
    render();
    click(q("phone-host-switcher"));
    click(document.querySelectorAll<HTMLElement>('[data-testid="phone-host-remove"]')[1]);
    expect(listPairings()).toHaveLength(2);
    click(q("phone-host-remove-cancel"));
    expect(listPairings()).toHaveLength(2);
    click(document.querySelectorAll<HTMLElement>('[data-testid="phone-host-remove"]')[1]);
    click(q("phone-host-remove-confirm"));
    expect(listPairings().map((p) => p.roomId)).toEqual([A]);
    // Not the connected host: no reload.
    expect(onReload).not.toHaveBeenCalled();
  });
});
