// @vitest-environment jsdom
/**
 * ADR-181 D3/D4/ticket 5: the pane switcher lists the active workspace's
 * panels → tabs → panes in layout order and moves the viewport through the
 * existing `focusPane` action on a tap — no new state (ADR-179 D3).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app-store`/`agent-store` read `window.electronAPI` at import time; jsdom's
// window has none, and the vitest setup only installs one when there is no
// window.
vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
    agents: { onUpdate: () => {} },
  };
});

import { PaneSwitcherSheet } from "../PaneSwitcherSheet";
import { useAppStore, selectFocusedPaneOfActiveTab } from "../../../store/app-store";
import { emptyViewport, reconcileViewport } from "../../../lib/layout/viewport";
import type { WorkspaceLayout } from "../../../lib/layout/workspace-layout";

const WS = "/ws";
const PANEL_1 = "p1";
const PANEL_2 = "p2";
const TAB_1 = "t1";
const TAB_2 = "t2";

/** Panel 1 has one plain pane ("a"); panel 2 has a split tab ("b" | "c"). */
const LAYOUT: WorkspaceLayout = {
  panelTree: {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: { type: "leaf", panelId: PANEL_1 },
    second: { type: "leaf", panelId: PANEL_2 },
  },
  panels: {
    [PANEL_1]: {
      id: PANEL_1,
      tabs: [{ id: TAB_1, title: "a", rootNode: { type: "leaf", paneId: "a" } }],
      pinnedTabIds: [],
    },
    [PANEL_2]: {
      id: PANEL_2,
      tabs: [
        {
          id: TAB_2,
          title: "bc",
          rootNode: {
            type: "split",
            direction: "vertical",
            ratio: 0.5,
            first: { type: "leaf", paneId: "b" },
            second: { type: "leaf", paneId: "c" },
          },
        },
      ],
      pinnedTabIds: [],
    },
  },
};

function seedStore(): void {
  useAppStore.setState({
    activeWorkspacePath: WS,
    workspaceLayouts: { [WS]: LAYOUT },
    viewports: { [WS]: reconcileViewport(LAYOUT, emptyViewport()) },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seedStore();
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

function render(onOpenChange: (open: boolean) => void = () => {}): void {
  act(() => {
    root.render(createElement(PaneSwitcherSheet, { open: true, onOpenChange }));
  });
}

// Radix `Dialog.Portal` renders into `document.body`, not `container`.
function rows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('[data-testid="pane-switcher-row"]'));
}

describe("PaneSwitcherSheet", () => {
  it("lists every pane of the active workspace, in layout order", () => {
    render();

    expect(document.body.querySelector('[data-testid="pane-switcher"]')).not.toBeNull();
    expect(rows().map((r) => r.getAttribute("data-pane-id"))).toEqual(["a", "b", "c"]);
  });

  it("marks the pane the viewport currently focuses", () => {
    // Focus pane "b" before rendering.
    act(() => {
      useAppStore.getState().focusPane("b");
    });
    render();

    const current = selectFocusedPaneOfActiveTab(useAppStore.getState());
    expect(current).toBe("b");

    const bRow = rows().find((r) => r.getAttribute("data-pane-id") === "b");
    expect(bRow?.getAttribute("aria-current")).toBe("true");

    const aRow = rows().find((r) => r.getAttribute("data-pane-id") === "a");
    expect(aRow?.hasAttribute("aria-current")).toBe(false);
  });

  it("tapping a row moves the viewport through focusPane and closes the sheet", () => {
    const onOpenChange = vi.fn();
    render(onOpenChange);

    const cRow = rows().find((r) => r.getAttribute("data-pane-id") === "c")!;
    act(() => {
      cRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const state = useAppStore.getState();
    expect(state.viewports[WS]?.activePanelId).toBe(PANEL_2);
    expect(state.viewports[WS]?.selectedTabIds[PANEL_2]).toBe(TAB_2);
    expect(state.viewports[WS]?.focusedPaneIds[TAB_2]).toBe("c");
    expect(selectFocusedPaneOfActiveTab(state)).toBe("c");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
