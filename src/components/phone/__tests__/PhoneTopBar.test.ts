// @vitest-environment jsdom
/**
 * ADR-181 D3: the phone top bar's buttons only call the callbacks
 * `PhoneChrome` hands them — this pins the `data-testid`s the phone E2E
 * asserts on (ADR-180 found a spec asserting nothing because a component
 * moved and took its class names with it) and that each button fires its
 * own callback and no other. The workspace name it reads from the stores.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app-store`/`project-store` read `window.electronAPI` at import time;
// jsdom's window has none, and the vitest setup only installs one when there
// is no window.
vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
  };
});

import { PhoneTopBar } from "../PhoneTopBar";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { HOME_PATH } from "../../../lib/home";

const WS = "/repo/worktrees/my-workspace";

function seedProjects(workspace: { name?: string; branch?: string }): void {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        workspaces: [{ path: WS, ...workspace }],
      } as unknown as ProjectInfo,
    ],
  });
}

const CALLBACKS = {
  onToggleDrawer: () => {},
  onOpenPaneSwitcher: () => {},
  onOpenPalette: () => {},
};

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
    seedProjects({ name: "my-workspace" });
    useAppStore.setState({ activeWorkspacePath: WS });
    act(() => {
      root.render(createElement(PhoneTopBar, CALLBACKS));
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

describe("PhoneTopBar — workspace name", () => {
  function name(): string | null | undefined {
    act(() => {
      root.render(createElement(PhoneTopBar, CALLBACKS));
    });
    return container.querySelector('[data-testid="phone-top-bar"]')?.textContent;
  }

  it("labels Home as Home", () => {
    useAppStore.setState({ activeWorkspacePath: HOME_PATH });
    expect(name()).toBe("Home");
  });

  it("falls back from the name to the branch to the last path segment", () => {
    useAppStore.setState({ activeWorkspacePath: WS });
    seedProjects({ branch: "feat/x" });
    expect(name()).toBe("feat/x");
    seedProjects({});
    expect(name()).toBe("my-workspace");
  });
});

describe("PhoneTopBar — macOS traffic-light inset", () => {
  function render(): void {
    act(() => {
      root.render(
        createElement(PhoneTopBar, CALLBACKS),
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
