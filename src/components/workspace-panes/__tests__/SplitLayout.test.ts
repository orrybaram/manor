// @vitest-environment jsdom
/**
 * ADR-181 D1: in phone mode a pane split stacks its two children as
 * `tab-styles` layers and shows only the one containing the tab's focused
 * pane — without changing the element tree, so no terminal ever remounts.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app-store` reads `window.electronAPI` at import time; jsdom's window has
// none, and the vitest setup only installs one when there is no window.
vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    isDetached: false,
  };
});

/** Mount / unmount counts per pane: the identity test's whole evidence. */
const lifecycle = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  unmounts: {} as Record<string, number>,
}));

vi.mock("../LeafPane", async () => {
  const { createElement: h, useEffect: useMountEffect } = await import("react");
  return {
    LeafPane: ({ paneId }: { paneId: string }) => {
      useMountEffect(() => {
        lifecycle.mounts[paneId] = (lifecycle.mounts[paneId] ?? 0) + 1;
        return () => {
          lifecycle.unmounts[paneId] = (lifecycle.unmounts[paneId] ?? 0) + 1;
        };
      }, [paneId]);
      return h("div", { "data-pane": paneId });
    },
  };
});

import { PaneLayout } from "../PaneLayout/PaneLayout";
import { useAppStore } from "../../../store/app-store";
import type { PaneNode } from "../../../lib/layout/pane-tree";
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
const TAB = "t1";

/** a | (b / c) — a two-level split. */
const ROOT: PaneNode = {
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first: { type: "leaf", paneId: "a" },
  second: {
    type: "split",
    direction: "vertical",
    ratio: 0.3,
    first: { type: "leaf", paneId: "b" },
    second: { type: "leaf", paneId: "c" },
  },
};

const LAYOUT: WorkspaceLayout = {
  panelTree: { type: "leaf", panelId: "p1" },
  panels: {
    p1: { id: "p1", tabs: [{ id: TAB, title: "t", rootNode: ROOT }], pinnedTabIds: [] },
  },
};

function focus(paneId: string | undefined): void {
  act(() => {
    useAppStore.setState({
      viewports: {
        [WS]: {
          activePanelId: "p1",
          selectedTabIds: { p1: TAB },
          focusedPaneIds: paneId ? { [TAB]: paneId } : {},
        },
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

function visibleLeaves(): string[] {
  return Array.from(container.querySelectorAll("[data-pane]"))
    .filter(isVisible)
    .map((el) => el.getAttribute("data-pane") ?? "");
}

function render(): void {
  act(() => {
    root.render(createElement(PaneLayout, { node: ROOT, workspacePath: WS }));
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
  focus("a");
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

describe("SplitLayout in phone mode", () => {
  it("shows exactly the focused leaf", () => {
    stubMatchMedia(true);
    render();
    expect(container.querySelectorAll("[data-pane]")).toHaveLength(3);
    expect(visibleLeaves()).toEqual(["a"]);
  });

  it("moves the visible leaf with focus, at any depth", () => {
    stubMatchMedia(true);
    render();
    focus("c");
    expect(visibleLeaves()).toEqual(["c"]);
    focus("b");
    expect(visibleLeaves()).toEqual(["b"]);
    focus("a");
    expect(visibleLeaves()).toEqual(["a"]);
  });

  it("falls back to the tab's first pane when nothing is focused", () => {
    stubMatchMedia(true);
    focus(undefined);
    render();
    expect(visibleLeaves()).toEqual(["a"]);
  });

  it("stacks both children over the full box, inheriting visibility", () => {
    stubMatchMedia(true);
    render();
    const split = container.firstElementChild as HTMLElement;
    expect(split.style.position).toBe("relative");
    const [first, divider, second] = Array.from(split.children) as HTMLElement[];
    for (const child of [first, second]) {
      expect(child.style.position).toBe("absolute");
      expect(child.style.inset).toMatch(/^0(px)?$/);
      expect(child.style.width).toBe("");
    }
    // `inherit`, never `visible`: a visible layer inside a hidden tab or
    // workspace must not paint itself back in (tab-styles.ts).
    expect(first.style.visibility).toBe("inherit");
    expect(second.style.visibility).toBe("hidden");
    expect(divider.style.display).toBe("none");
  });

  it("stays hidden inside a hidden ancestor", () => {
    stubMatchMedia(true);
    container.style.visibility = "hidden";
    render();
    expect(visibleLeaves()).toEqual([]);
  });
});

describe("SplitLayout identity (ADR-181 D1)", () => {
  it("never remounts a pane on focus switches or mode flips", () => {
    const mql = stubMatchMedia(true);
    render();
    expect(lifecycle.mounts).toEqual({ a: 1, b: 1, c: 1 });

    for (const pane of ["b", "c", "a", "c", "b"]) focus(pane);
    act(() => mql.set(false));
    focus("a");
    act(() => mql.set(true));
    focus("c");
    act(() => mql.set(false));

    expect(lifecycle.mounts).toEqual({ a: 1, b: 1, c: 1 });
    expect(lifecycle.unmounts).toEqual({});
  });
});

describe("SplitLayout in desk mode", () => {
  it("renders the ratio split with a divider, exactly as before", () => {
    stubMatchMedia(false);
    render();
    const split = container.firstElementChild as HTMLElement;
    expect(split.getAttribute("style")).toBeNull();
    const [first, divider, second] = Array.from(split.children) as HTMLElement[];
    expect(split.children).toHaveLength(3);
    expect(first.getAttribute("style")).toBe("width: 50%;");
    expect(divider.getAttribute("style")).toBeNull();
    expect(second.getAttribute("style")).toBe("width: 50%;");

    const inner = second.firstElementChild as HTMLElement;
    const [innerFirst, innerDivider, innerSecond] = Array.from(inner.children) as HTMLElement[];
    expect(innerFirst.getAttribute("style")).toBe("height: 30%;");
    expect(innerDivider.getAttribute("style")).toBeNull();
    expect(innerSecond.getAttribute("style")).toBe("height: 70%;");

    expect(visibleLeaves()).toEqual(["a", "b", "c"]);
  });

  it("leaves the DOM untouched on a focus change", () => {
    stubMatchMedia(false);
    render();
    const before = container.innerHTML;
    focus("c");
    expect(container.innerHTML).toBe(before);
  });
});
