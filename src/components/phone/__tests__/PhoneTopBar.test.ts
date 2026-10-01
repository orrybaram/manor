// @vitest-environment jsdom
/**
 * ADR-181 D3: the phone top bar's buttons only call the callbacks App.tsx
 * hands them — this pins the `data-testid`s ticket 9's E2E asserts on
 * (ADR-180 found a spec asserting nothing because a component moved and
 * took its class names with it) and that each button fires its own
 * callback and no other.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneTopBar } from "../PhoneTopBar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function click(testId: string): void {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PhoneTopBar", () => {
  it("renders the workspace name and every callback's testid", () => {
    act(() => {
      root.render(
        createElement(PhoneTopBar, {
          workspaceName: "my-workspace",
          onToggleDrawer: () => {},
          onOpenPaneSwitcher: () => {},
          onOpenPalette: () => {},
        }),
      );
    });

    expect(container.querySelector('[data-testid="phone-top-bar"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="phone-drawer-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="phone-pane-switcher-button"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="phone-palette-button"]')).not.toBeNull();
    expect(container.textContent).toContain("my-workspace");
  });

  it("fires only the callback its own button was clicked for", () => {
    const onToggleDrawer = vi.fn();
    const onOpenPaneSwitcher = vi.fn();
    const onOpenPalette = vi.fn();

    act(() => {
      root.render(
        createElement(PhoneTopBar, {
          workspaceName: "ws",
          onToggleDrawer,
          onOpenPaneSwitcher,
          onOpenPalette,
        }),
      );
    });

    click("phone-drawer-toggle");
    expect(onToggleDrawer).toHaveBeenCalledTimes(1);
    expect(onOpenPaneSwitcher).not.toHaveBeenCalled();
    expect(onOpenPalette).not.toHaveBeenCalled();

    click("phone-pane-switcher-button");
    expect(onOpenPaneSwitcher).toHaveBeenCalledTimes(1);

    click("phone-palette-button");
    expect(onOpenPalette).toHaveBeenCalledTimes(1);

    expect(onToggleDrawer).toHaveBeenCalledTimes(1);
    expect(onOpenPaneSwitcher).toHaveBeenCalledTimes(1);
  });
});

describe("PhoneTopBar — macOS traffic-light inset (ticket 4)", () => {
  function render(): void {
    act(() => {
      root.render(
        createElement(PhoneTopBar, {
          workspaceName: "ws",
          onToggleDrawer: () => {},
          onOpenPaneSwitcher: () => {},
          onOpenPalette: () => {},
        }),
      );
    });
  }

  function topBar(): Element | null {
    return container.querySelector('[data-testid="phone-top-bar"]');
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error test double for the preload bridge
    delete window.electronAPI;
  });

  it("sets data-mac-inset on the Electron desktop on macOS", () => {
    // @ts-expect-error test double for the preload bridge
    window.electronAPI = { platform: "electron" };
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });

    render();

    expect(topBar()?.getAttribute("data-mac-inset")).toBe("true");
  });

  it("omits data-mac-inset on the Electron desktop off macOS", () => {
    // @ts-expect-error test double for the preload bridge
    window.electronAPI = { platform: "electron" };
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });

    render();

    expect(topBar()?.hasAttribute("data-mac-inset")).toBe(false);
  });

  it("omits data-mac-inset in a browser, even on macOS", () => {
    // @ts-expect-error test double for the preload bridge
    window.electronAPI = { platform: "web" };
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });

    render();

    expect(topBar()?.hasAttribute("data-mac-inset")).toBe(false);
  });
});
