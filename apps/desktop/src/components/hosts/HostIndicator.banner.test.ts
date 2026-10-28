// @vitest-environment jsdom
/**
 * Over a remote pane: a pill while Manor gets the host back on its own, the
 * full banner when the host needs you, nothing while it is connected.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { useHostStore, type HostStatusInfo } from "../../store/host-store";
import { HostIndicator } from "./HostIndicator";

const BOX = "box";

function host(overrides: Partial<HostStatusInfo>): HostStatusInfo {
  return { hostId: BOX, spec: { kind: "ssh", target: "me@box" }, status: "connected", ...overrides };
}

describe("HostIndicator over a pane", () => {
  let container: HTMLDivElement;
  let root: Root;
  const retryConnect = vi.fn(async () => {});

  const render = (status: Partial<HostStatusInfo>, blocksPointer?: boolean) => {
    act(() => useHostStore.setState({ hosts: [host(status)], retryConnect }));
    act(() =>
      root.render(createElement(HostIndicator, { hostId: BOX, variant: "banner", blocksPointer })),
    );
  };
  const pill = () => container.querySelector('[data-testid="host-reconnecting-pill"]');
  const banner = () => container.querySelector('[data-testid="host-offline-banner"]');

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useHostStore.setState({ hosts: [] });
    retryConnect.mockClear();
  });

  it("shows nothing while the host is connected", () => {
    render({ status: "connected" });
    expect(pill()).toBeNull();
    expect(banner()).toBeNull();
  });

  it("shows a pill with the countdown and Retry while reconnecting, not the banner", () => {
    render({ status: "reconnecting", retryAt: Date.now() + 4_000 });
    expect(banner()).toBeNull();
    expect(pill()?.textContent).toMatch(/^Reconnecting in [34]sRetry$/);
  });

  it("retries the host from the pill", () => {
    render({ status: "reconnecting", retryAt: Date.now() + 4_000 });
    const retry = [...pill()!.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    act(() => retry!.click());
    expect(retryConnect).toHaveBeenCalledWith(BOX);
  });

  it("lets the pointer through the dim unless the pane asks it to block", () => {
    render({ status: "reconnecting" });
    expect(pill()!.parentElement!.className).not.toMatch(/pillDockBlocking/);
    render({ status: "reconnecting" }, true);
    expect(pill()!.parentElement!.className).toMatch(/pillDockBlocking/);
  });

  it("shows a pill without Retry while connecting", () => {
    render({ status: "connecting" });
    expect(banner()).toBeNull();
    expect(pill()?.textContent).toBe("Connecting…");
    expect(pill()?.querySelector("button")).toBeNull();
  });

  it.each([
    ["error", { status: "error", error: "ssh: connect to host box port 22: Connection refused" }],
    ["asleep", { status: "sleeping" }],
    ["not connected", { status: "disconnected" }],
  ] as const)("keeps the full banner when the host is %s", (_, status) => {
    render(status);
    expect(pill()).toBeNull();
    expect(banner()).not.toBeNull();
  });
});
