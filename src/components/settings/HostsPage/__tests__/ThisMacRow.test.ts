// @vitest-environment jsdom
/**
 * ADR-233 D2: This Mac is a host row too. Its switch is remote control:
 * turning it on is confirmed first, turning it off is immediate, and the row
 * says in words whether devices reach This Mac.
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
  (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.22.1";
});

import type { RemoteControlStatus } from "../../../../electron.d";
import { useRemoteControlStore } from "../../../../store/remote-control-store";
import { SettingsJumpContext } from "../../SettingsModal/settings-nav";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { ThisMacRow } from "../ThisMacRow";

function status(over: Partial<RemoteControlStatus> = {}): RemoteControlStatus {
  return {
    enabled: false,
    devices: [],
    relay: { state: "stopped", url: null, error: null },
    relayOrigin: null,
    relayAppUrl: null,
    encryptionAvailable: true,
    relayViewers: 0,
    relayNotice: null,
    ...over,
  };
}

const running = { state: "running", url: "wss://relay", error: null } as RemoteControlStatus["relay"];
const device = { id: "d1", label: "Phone" } as RemoteControlStatus["devices"][number];

describe("ThisMacRow", () => {
  let container: HTMLDivElement;
  let root: Root;
  const turnOn = vi.fn(() => Promise.resolve());
  const turnOff = vi.fn(() => Promise.resolve());
  const resetRelayAddress = vi.fn(() => Promise.resolve());

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const flush = () => act(async () => {});

  /** Renders the row with `over` as its status, opened by a jump unless `open` is false. */
  async function render(over: Partial<RemoteControlStatus> = {}, open = true) {
    useRemoteControlStore.setState({
      status: status(over),
      busy: false,
      error: null,
      turnOn,
      turnOff,
      resetRelayAddress,
    });
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            SettingsJumpContext.Provider,
            { value: open ? "host-local" : null },
            createElement(ThisMacRow),
          ),
        ),
      );
    });
    await flush();
  }

  beforeEach(() => {
    turnOn.mockClear();
    turnOff.mockClear();
    resetRelayAddress.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("starts collapsed, and opens by a jump to host-local", async () => {
    await render({}, false);
    expect(q("host-row-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(q("remote-control-switch")).toBeNull();
    click(q("host-row-toggle"));
    await flush();
    expect(q("remote-control-switch")).not.toBeNull();
  });

  it.each([
    [{}, "Local · Manor 0.22.1 · devices off"],
    [{ enabled: true, relay: running }, "Local · Manor 0.22.1 · devices reach it while Manor is open"],
    [
      { enabled: true, relay: { state: "failed", url: null, error: "refused" } },
      "Local · Manor 0.22.1 · can't reach the relay",
    ],
  ] as [Partial<RemoteControlStatus>, string][])(
    "says in words whether devices reach This Mac (%o)",
    async (over, line) => {
      await render(over, false);
      expect(q("host-row-status")?.textContent).toBe(line);
    },
  );

  it("turns on only once the relay is confirmed", async () => {
    await render();
    expect(q("remote-relay-card")?.textContent).toContain("Remote control is off");
    click(q("remote-control-switch"));
    await flush();
    expect(turnOn).not.toHaveBeenCalled();
    const confirm = q("remote-relay-confirm");
    expect(confirm).not.toBeNull();
    const turnOnButton = Array.from(confirm?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "Turn on",
    );
    click(turnOnButton ?? null);
    await flush();
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it("turns off straight away", async () => {
    await render({ enabled: true, relay: running });
    expect(q("remote-relay-card")?.textContent).toContain("Remote control is on");
    click(q("remote-control-switch"));
    await flush();
    expect(q("remote-relay-confirm")).toBeNull();
    expect(turnOff).toHaveBeenCalledTimes(1);
  });

  it("offers Try again when the relay gave up", async () => {
    await render({ enabled: true, relay: { state: "failed", url: null, error: "refused" } });
    expect(q("remote-relay-card")?.textContent).toContain("Can't reach the relay");
    click(q("remote-relay-retry"));
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it("locks the switch where secrets can't be encrypted, and says why", async () => {
    await render({ encryptionAvailable: false });
    expect((q("remote-control-switch") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("cannot encrypt stored secrets");
  });

  it("resets pairing keys only with devices, after confirming", async () => {
    await render();
    expect(q("remote-relay-reset")).toBeNull();
    await render({ devices: [device] });
    click(q("remote-relay-reset"));
    await flush();
    const confirm = q("remote-relay-reset-confirm");
    expect(confirm).not.toBeNull();
    const reset = Array.from(confirm?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent !== "Cancel",
    );
    click(reset ?? null);
    await flush();
    expect(resetRelayAddress).toHaveBeenCalledTimes(1);
  });
});
