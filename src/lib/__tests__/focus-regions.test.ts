// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  currentRegion,
  cycleRegion,
  focusRegion,
  isNavRegionFocused,
} from "../focus-regions";
import { useAppStore } from "../../store/app-store";

/**
 * jsdom does no layout, so every element reports zero client rects. Treat an
 * element as rendered unless it (or an ancestor) carries `hidden`.
 */
const originalGetClientRects = Element.prototype.getClientRects;
beforeAll(() => {
  Element.prototype.getClientRects = function (this: Element) {
    const length = this.closest("[hidden]") ? 0 : 1;
    return { length, item: () => null } as unknown as DOMRectList;
  };
});
afterAll(() => {
  Element.prototype.getClientRects = originalGetClientRects;
});

interface DomOptions {
  sidebar?: boolean;
  selectedTab?: boolean;
  statusButton?: boolean;
  hiddenTabbar?: boolean;
}

/** A minimal app shell with the four regions. */
function renderDom({
  sidebar = true,
  selectedTab = true,
  statusButton = true,
  hiddenTabbar = false,
}: DomOptions = {}) {
  document.body.innerHTML = `
    ${
      sidebar
        ? `<div data-focus-region="sidebar">
             <div data-sidebar-row tabindex="0" id="row-home">Home</div>
             <div data-sidebar-row tabindex="0" data-workspace-path="/a" id="row-a">a</div>
             <div data-sidebar-row tabindex="0" data-workspace-path="/b" id="row-b">b</div>
           </div>`
        : ""
    }
    <div id="panel">
      <div data-focus-region="tabbar" ${hiddenTabbar ? "hidden" : ""}>
        <div role="tab" tabindex="0" data-tab-id="t1" aria-selected="${selectedTab}" id="tab-1">t1</div>
      </div>
      <div data-focus-region="pane"><textarea id="term"></textarea></div>
    </div>
    <div data-focus-region="statusbar">
      <span>Home</span>
      ${statusButton ? `<button id="status-btn">About</button>` : ""}
    </div>
  `;
}

const activeId = () => (document.activeElement as HTMLElement | null)?.id;

beforeEach(() => {
  useAppStore.setState({
    activeWorkspacePath: "/b",
    workspaceLayouts: {},
    paneFocusNonce: 0,
  });
  renderDom();
});

describe("currentRegion / isNavRegionFocused", () => {
  it("reports the region around the focused element", () => {
    document.getElementById("row-a")!.focus();
    expect(currentRegion()).toBe("sidebar");
    expect(isNavRegionFocused()).toBe(true);
  });

  it("treats the pane as not a nav region", () => {
    document.getElementById("term")!.focus();
    expect(currentRegion()).toBe("pane");
    expect(isNavRegionFocused()).toBe(false);
  });

  it("is null outside every region", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(currentRegion()).toBeNull();
    expect(isNavRegionFocused()).toBe(false);
  });
});

describe("focusRegion", () => {
  it("focuses the active workspace row in the sidebar", () => {
    expect(focusRegion("sidebar")).toBe(true);
    expect(activeId()).toBe("row-b");
  });

  it("prefers an aria-current row", () => {
    document.getElementById("row-a")!.setAttribute("aria-current", "true");
    useAppStore.setState({ activeWorkspacePath: null });
    focusRegion("sidebar");
    expect(activeId()).toBe("row-a");
  });

  it("falls back to the first row when nothing is active", () => {
    useAppStore.setState({ activeWorkspacePath: "/elsewhere" });
    focusRegion("sidebar");
    expect(activeId()).toBe("row-home");
  });

  it("focuses the selected tab", () => {
    expect(focusRegion("tabbar")).toBe(true);
    expect(activeId()).toBe("tab-1");
  });

  it("focuses the status bar's first focusable", () => {
    expect(focusRegion("statusbar")).toBe(true);
    expect(activeId()).toBe("status-btn");
  });

  it("asks the active pane to take focus", () => {
    document.getElementById("row-a")!.focus();
    expect(focusRegion("pane")).toBe(true);
    expect(useAppStore.getState().paneFocusNonce).toBe(1);
    // Focus left the sidebar so the terminal's guard doesn't hold it there.
    expect(isNavRegionFocused()).toBe(false);
  });

  it("returns false for a missing region", () => {
    renderDom({ sidebar: false });
    expect(focusRegion("sidebar")).toBe(false);
  });

  it("returns false when the region has no target", () => {
    renderDom({ selectedTab: false });
    expect(focusRegion("tabbar")).toBe(false);
  });

  it("returns false for a hidden region", () => {
    renderDom({ hiddenTabbar: true });
    expect(focusRegion("tabbar")).toBe(false);
  });
});

describe("cycleRegion", () => {
  it("walks sidebar → tabbar → pane → statusbar → sidebar", () => {
    document.getElementById("row-a")!.focus();
    expect(cycleRegion(1)).toBe("tabbar");
    expect(activeId()).toBe("tab-1");
    expect(cycleRegion(1)).toBe("pane");
    // The pane is focused by its own effect; stand in for it here.
    document.getElementById("term")!.focus();
    expect(cycleRegion(1)).toBe("statusbar");
    expect(activeId()).toBe("status-btn");
    expect(cycleRegion(1)).toBe("sidebar");
    expect(activeId()).toBe("row-b");
  });

  it("walks backwards with -1", () => {
    document.getElementById("term")!.focus();
    expect(cycleRegion(-1)).toBe("tabbar");
    expect(cycleRegion(-1)).toBe("sidebar");
    expect(cycleRegion(-1)).toBe("statusbar");
  });

  it("skips regions with nothing to focus", () => {
    renderDom({ selectedTab: false, statusButton: false });
    document.getElementById("term")!.focus();
    expect(cycleRegion(1)).toBe("sidebar");
    expect(cycleRegion(1)).toBe("pane");
  });

  it("skips regions that aren't rendered", () => {
    renderDom({ sidebar: false });
    document.getElementById("status-btn")!.focus();
    expect(cycleRegion(1)).toBe("tabbar");
    expect(cycleRegion(-1)).toBe("statusbar");
  });

  it("starts at the ends from outside every region", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(cycleRegion(1)).toBe("sidebar");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(cycleRegion(-1)).toBe("statusbar");
  });

  it("returns null when no other region can take focus", () => {
    document.body.innerHTML = `<div data-focus-region="statusbar"><button id="only">x</button></div>`;
    document.getElementById("only")!.focus();
    expect(cycleRegion(1)).toBeNull();
    expect(activeId()).toBe("only");
  });
});
