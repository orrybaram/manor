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
    agents: { onUpdate: () => () => {} },
  };
  // `useLayoutMode` reads the phone media query; jsdom has none. The top
  // bar only ever renders on a phone.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  // Radix's popper measures its content.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

import { PhoneTopBar } from "../PhoneTopBar";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { HOME_PATH } from "../../../lib/home";
import { useAgentStore } from "../../../store/agent-store";
import {
  readChatView,
  writeChatView,
} from "../ChatPane/chat-view";
import { usePaneChatViewStore } from "../ChatPane/usePaneChatView";
import type { AgentInfo } from "../../../electron.d";

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

/** Clicks an element by testid, wherever it is — the menu is portaled. */
function click(testId: string): void {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no ${testId}`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Opens the overflow menu, or closes it when it is open. */
function openMenu(): void {
  click("phone-overflow-button");
}

function byTestId(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`);
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
    expect(container.querySelector('[data-testid="phone-overflow-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="phone-palette-button"]')).toBeNull();
    expect(container.textContent).toContain("my-workspace");
  });

  it("fires only the callback its own button was clicked for", () => {
    const onToggleDrawer = vi.fn();
    const onOpenPalette = vi.fn();

    act(() => {
      root.render(
        createElement(PhoneTopBar, {
          onToggleDrawer,
          onOpenPalette,
        }),
      );
    });

    click("phone-drawer-toggle");
    expect(onToggleDrawer).toHaveBeenCalledTimes(1);
    expect(onOpenPalette).not.toHaveBeenCalled();

    openMenu();
    expect(byTestId("phone-overflow-menu")).not.toBeNull();
    expect(onOpenPalette).not.toHaveBeenCalled();
    click("phone-overflow-palette");
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    // An item closes the menu.
    expect(byTestId("phone-overflow-menu")).toBeNull();

    expect(onToggleDrawer).toHaveBeenCalledTimes(1);
  });
});

describe("PhoneTopBar — overflow menu's view item", () => {
  const WS_PATH = "/repo/chat-ws";
  const PANE = "pane-chat";

  function seedPane(contentType?: "diff" | "browser"): void {
    useAppStore.setState({
      activeWorkspacePath: WS_PATH,
      activeWorkspaceHostId: "local",
      activeSurface: "workspace",
      viewports: {},
      workspaceLayouts: {
        [WS_PATH]: {
          panelTree: { type: "leaf", panelId: "panel-1" },
          panels: {
            "panel-1": {
              id: "panel-1",
              pinnedTabIds: [],
              tabs: [
                {
                  id: "tab-1",
                  title: "Claude",
                  rootNode: {
                    type: "leaf",
                    paneId: PANE,
                    ...(contentType && { contentType }),
                  },
                },
              ],
            },
          },
        },
      },
    } as never);
  }

  function seedAgent(agent: Partial<AgentInfo> | null): void {
    useAgentStore.setState({
      agents: agent
        ? [
            {
              id: "agent-1",
              paneId: PANE,
              status: "active",
              agentKind: "claude",
              transcriptPath: "/tmp/t.jsonl",
              createdAt: 1,
              ...agent,
            } as unknown as AgentInfo,
          ]
        : [],
    });
  }

  function renderBar(): void {
    act(() => {
      root.render(createElement(PhoneTopBar, CALLBACKS));
    });
  }

  beforeEach(() => {
    localStorage.clear();
    usePaneChatViewStore.setState({ views: {} });
  });

  afterEach(() => {
    // Leave no open menu portaled into the next test.
    act(() => {
      root.render(createElement("div"));
    });
    useAgentStore.setState({ agents: [] });
  });

  it("is offered only when the focused pane has a chat", () => {
    seedPane();
    seedAgent(null);
    renderBar();
    openMenu();
    expect(byTestId("phone-overflow-palette")).not.toBeNull();
    expect(byTestId("phone-overflow-view")).toBeNull();
    click("phone-overflow-button");

    // Not Claude: no chat.
    seedAgent({ agentKind: "codex" } as Partial<AgentInfo>);
    openMenu();
    expect(byTestId("phone-overflow-view")).toBeNull();
    click("phone-overflow-button");

    // No transcript yet: no chat.
    seedAgent({ transcriptPath: "" });
    openMenu();
    expect(byTestId("phone-overflow-view")).toBeNull();
    click("phone-overflow-button");

    seedAgent({});
    openMenu();
    expect(byTestId("phone-overflow-view")?.textContent).toBe("Show terminal");
  });

  it("is not offered for a diff or browser pane", () => {
    seedAgent({});
    for (const kind of ["diff", "browser"] as const) {
      seedPane(kind);
      renderBar();
      openMenu();
      expect(byTestId("phone-overflow-view")).toBeNull();
      click("phone-overflow-button");
    }
  });

  it("flips the pane's shared view and closes the menu", () => {
    seedPane();
    seedAgent({});
    renderBar();

    openMenu();
    click("phone-overflow-view");
    expect(usePaneChatViewStore.getState().views[PANE]).toBe("terminal");
    expect(readChatView(PANE)).toBe("terminal");
    expect(byTestId("phone-overflow-menu")).toBeNull();

    openMenu();
    expect(byTestId("phone-overflow-view")?.textContent).toBe("Show chat");
    click("phone-overflow-view");
    expect(usePaneChatViewStore.getState().views[PANE]).toBe("chat");
  });

  it("starts from the view this browser remembers", () => {
    writeChatView(PANE, "terminal");
    seedPane();
    seedAgent({});
    renderBar();
    openMenu();
    expect(byTestId("phone-overflow-view")?.textContent).toBe("Show chat");
  });
});

describe("PhoneTopBar — workspace name", () => {
  function name(): string | null | undefined {
    act(() => {
      root.render(createElement(PhoneTopBar, CALLBACKS));
    });
    return container.querySelector('[data-testid="phone-top-bar"]')?.textContent;
  }

  it("labels Home as Dashboard", () => {
    useAppStore.setState({ activeWorkspacePath: HOME_PATH });
    expect(name()).toBe("Dashboard");
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
