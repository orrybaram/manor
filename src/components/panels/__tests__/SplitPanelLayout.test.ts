// @vitest-environment jsdom
/**
 * ADR-181 D1: in phone mode a panel split stacks its two children as
 * `tab-styles` layers and shows only the one containing the active panel —
 * without changing the element tree, so no panel (and none of its terminals)
 * ever remounts.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app-store` reads `window.electronAPI` at import time; jsdom's window has
// none, and the vitest setup only installs one when there is no window.
vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
  };
});

/** Mount / unmount counts per panel: the identity test's whole evidence. */
const lifecycle = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  unmounts: {} as Record<string, number>,
}));

vi.mock("../LeafPanel", async () => {
  const { createElement: h, useEffect } = await import("react");
  return {
    LeafPanel: ({ panelId }: { panelId: string }) => {
      useEffect(() => {
        lifecycle.mounts[panelId] = (lifecycle.mounts[panelId] ?? 0) + 1;
        return () => {
          lifecycle.unmounts[panelId] = (lifecycle.unmounts[panelId] ?? 0) + 1;
        };
      }, [panelId]);
      return h("div", { "data-panel": panelId });
    },
  };
});

import { PanelLayout } from "../PanelLayout";
import { useAppStore } from "../../../store/app-store";
import type { PanelNode } from "../../../lib/layout/panel-tree";
import type { WorkspaceLayout } from "../../../lib/layout/workspace-layout";

class FakeMediaQueryList {
  matches: boolean;
  private listeners = new Set<() => void>();
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(type: string, listener: () => void): void {
    if (type === "change") this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    if (type === "change") this.listeners.delete(listener);
  }
  set(matches: boolean): void {
    this.matches = matches;
    this.listeners.forEach((listener) => listener());
  }
}

function stubMatchMedia(phone: boolean): FakeMediaQueryList {
  const mql = new FakeMediaQueryList(phone);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return mql;
}

const WS = "/ws";

/** p1 | (p2 / p3) — a two-level panel split. */
const TREE: PanelNode = {
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first: { type: "leaf", panelId: "p1" },
  second: {
    type: "split",
    direction: "vertical",
    ratio: 0.3,
    first: { type: "leaf", panelId: "p2" },
    second: { type: "leaf", panelId: "p3" },
  },
};

const LAYOUT: WorkspaceLayout = {
  panelTree: TREE,
  panels: {
    p1: { id: "p1", tabs: [], pinnedTabIds: [] },
    p2: { id: "p2", tabs: [], pinnedTabIds: [] },
    p3: { id: "p3", tabs: [], pinnedTabIds: [] },
  },
};

function activate(panelId: string | null): void {
  act(() => {
    useAppStore.setState({
      viewports: {
        [WS]: { activePanelId: panelId, selectedTabIds: {}, focusedPaneIds: {} },
      },
    });
  });
}

/** Effective visibility: nearest ancestor that sets it decides. */
function isVisible(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = (n as HTMLElement).style?.visibility;
    if (v === "hidden") return false;
    if (v === "visible") return true;
  }
  return true;
}

function visiblePanels(): string[] {
  return Array.from(container.querySelectorAll("[data-panel]"))
    .filter(isVisible)
    .map((el) => el.getAttribute("data-panel") ?? "");
}

function render(): void {
  act(() => {
    root.render(
      createElement(PanelLayout, { node: TREE, workspacePath: WS, onNewAgent: () => {} }),
    );
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const k of Object.keys(lifecycle.mounts)) delete lifecycle.mounts[k];
  for (const k of Object.keys(lifecycle.unmounts)) delete lifecycle.unmounts[k];
  useAppStore.setState({
    activeWorkspacePath: WS,
    workspaceLayouts: { [WS]: LAYOUT },
  });
  activate("p1");
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

describe("SplitPanelLayout in phone mode", () => {
  it("shows exactly the active panel, and moves with it", () => {
    stubMatchMedia(true);
    render();
    expect(container.querySelectorAll("[data-panel]")).toHaveLength(3);
    expect(visiblePanels()).toEqual(["p1"]);
    activate("p3");
    expect(visiblePanels()).toEqual(["p3"]);
    activate("p2");
    expect(visiblePanels()).toEqual(["p2"]);
  });

  it("falls back to the leftmost panel when the viewport names none", () => {
    stubMatchMedia(true);
    activate(null);
    render();
    expect(visiblePanels()).toEqual(["p1"]);
  });

  it("stacks both children and hides the divider", () => {
    stubMatchMedia(true);
    render();
    const split = container.firstElementChild as HTMLElement;
    expect(split.style.position).toBe("relative");
    const [first, divider, second] = Array.from(split.children) as HTMLElement[];
    expect(first.style.position).toBe("absolute");
    expect(first.style.visibility).toBe("inherit");
    expect(second.style.position).toBe("absolute");
    expect(second.style.visibility).toBe("hidden");
    expect(divider.style.display).toBe("none");
  });
});

describe("SplitPanelLayout identity (ADR-181 D1)", () => {
  it("never remounts a panel on focus switches or mode flips", () => {
    const mql = stubMatchMedia(true);
    render();
    expect(lifecycle.mounts).toEqual({ p1: 1, p2: 1, p3: 1 });

    for (const panel of ["p2", "p3", "p1", "p3"]) activate(panel);
    act(() => mql.set(false));
    activate("p2");
    act(() => mql.set(true));
    activate("p1");
    act(() => mql.set(false));

    expect(lifecycle.mounts).toEqual({ p1: 1, p2: 1, p3: 1 });
    expect(lifecycle.unmounts).toEqual({});
  });
});

describe("SplitPanelLayout in desk mode", () => {
  it("renders the ratio split with a divider, exactly as before", () => {
    stubMatchMedia(false);
    render();
    const split = container.firstElementChild as HTMLElement;
    expect(split.getAttribute("style")).toBeNull();
    expect(split.children).toHaveLength(3);
    const [first, divider, second] = Array.from(split.children) as HTMLElement[];
    expect(first.getAttribute("style")).toBe("width: 50%;");
    expect(divider.getAttribute("style")).toBeNull();
    expect(second.getAttribute("style")).toBe("width: 50%;");

    const inner = second.firstElementChild as HTMLElement;
    const [innerFirst, innerDivider, innerSecond] = Array.from(inner.children) as HTMLElement[];
    expect(innerFirst.getAttribute("style")).toBe("height: 30%;");
    expect(innerDivider.getAttribute("style")).toBeNull();
    expect(innerSecond.getAttribute("style")).toBe("height: 70%;");

    expect(visiblePanels()).toEqual(["p1", "p2", "p3"]);
  });
});
