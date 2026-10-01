/**
 * Who sees which tab (ADR-179 D4).
 *
 * Three renderers, one claim list, three different answers — and the third is
 * the one the ADR insists on: a browser sees the whole workspace, because a
 * claim is about a desktop window's chrome and not about what exists.
 */

import { describe, expect, it } from "vitest";
import {
  hiddenTabIdsIn,
  holdsClaim,
  isTabVisible,
  sameClaims,
  visibleTabsFor,
  type LayoutClaim,
} from "../visible-tabs";
import type { Tab, WorkspaceLayout } from "../workspace-layout";

function tab(id: string): Tab {
  return { id, title: id, rootNode: { type: "leaf", paneId: `pane-${id}` } };
}

const PANEL = { tabs: [tab("tab-1"), tab("tab-2"), tab("tab-3")] };

function layout(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: { "panel-1": { id: "panel-1", tabs: PANEL.tabs, pinnedTabIds: [] } },
  };
}

const CLAIMS: LayoutClaim[] = [{ windowId: "7", tabId: "tab-2" }];

describe("visibleTabsFor", () => {
  it("hides a claimed tab from the primary", () => {
    const tabs = visibleTabsFor(PANEL, CLAIMS, "electron", null);

    expect(tabs.map((t) => t.id)).toEqual(["tab-1", "tab-3"]);
  });

  it("shows a claiming window its one tab and nothing else", () => {
    const tabs = visibleTabsFor(PANEL, CLAIMS, "electron", "tab-2");

    expect(tabs.map((t) => t.id)).toEqual(["tab-2"]);
  });

  it("shows a browser every tab, claims and all", () => {
    const tabs = visibleTabsFor(PANEL, CLAIMS, "web", null);

    expect(tabs.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
  });

  it("shows everything when nobody is holding anything", () => {
    expect(visibleTabsFor(PANEL, [], "electron", null)).toHaveLength(3);
  });

  it("answers an empty list for a panel that is not there", () => {
    expect(visibleTabsFor(null, CLAIMS, "electron", null)).toEqual([]);
  });
});

describe("hiddenTabIdsIn", () => {
  it("is the claimed tabs, for the primary", () => {
    expect([...hiddenTabIdsIn(layout(), CLAIMS, "electron", null)]).toEqual([
      "tab-2",
    ]);
  });

  it("is empty for a browser and for a claiming window", () => {
    // A claiming window's hidden set is derived from its own viewport by
    // `reconcileViewport`, which is the only place that needs it.
    expect(hiddenTabIdsIn(layout(), CLAIMS, "web", null).size).toBe(0);
    expect(hiddenTabIdsIn(layout(), CLAIMS, "electron", "tab-2").size).toBe(0);
  });
});

describe("isTabVisible", () => {
  it("is what the two list functions are built from", () => {
    expect(isTabVisible("tab-2", CLAIMS, "electron", null)).toBe(false);
    expect(isTabVisible("tab-1", CLAIMS, "electron", "tab-2")).toBe(false);
    expect(isTabVisible("tab-2", CLAIMS, "electron", "tab-2")).toBe(true);
    expect(isTabVisible("tab-2", CLAIMS, "web", null)).toBe(true);
  });
});

describe("holdsClaim", () => {
  it("is how a window learns its claim was taken by another one", () => {
    expect(holdsClaim(CLAIMS, "7", "tab-2")).toBe(true);
    expect(holdsClaim(CLAIMS, "8", "tab-2")).toBe(false);
    expect(holdsClaim(CLAIMS, null, "tab-2")).toBe(false);
  });
});

describe("sameClaims", () => {
  it("is the half of the broadcast guard that versions cannot answer", () => {
    expect(sameClaims(CLAIMS, [{ windowId: "7", tabId: "tab-2" }])).toBe(true);
    expect(sameClaims(CLAIMS, [{ windowId: "8", tabId: "tab-2" }])).toBe(false);
    expect(sameClaims(CLAIMS, [])).toBe(false);
  });
});
