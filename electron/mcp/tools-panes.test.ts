import { describe, it, expect } from "vitest";
import { formatLayoutSnapshot } from "./tools-panes";
import type { LayoutSnapshot } from "../../src/store/layout-snapshot";

describe("formatLayoutSnapshot", () => {
  it("reports no tabs for an empty workspace", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: null,
      focusedPaneId: null,
      tabs: [],
    };
    expect(formatLayoutSnapshot(snapshot)).toBe("/ws\n  (no tabs)");
  });

  // The bug this ADR fixes: three tabs in one panel printed `[focused]` thrice.
  it("prints exactly one [active] and one [focused] across three tabs", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: "t2",
      focusedPaneId: "p2",
      tabs: [
        {
          tabId: "t1",
          title: "One",
          focusedPaneId: "p1",
          panes: [{ paneId: "p1", contentType: "terminal" }],
        },
        {
          tabId: "t2",
          title: "Two",
          focusedPaneId: "p2",
          panes: [{ paneId: "p2", contentType: "terminal" }],
        },
        {
          tabId: "t3",
          title: "Three",
          focusedPaneId: "p3",
          panes: [{ paneId: "p3", contentType: "terminal" }],
        },
      ],
    };

    const output = formatLayoutSnapshot(snapshot);
    expect(output.match(/\[active\]/g)).toHaveLength(1);
    expect(output.match(/\[focused\]/g)).toHaveLength(1);
    expect(output).toContain("  Two (tabId: t2) [active]");
    expect(output).toContain("    - terminal (paneId: p2) [focused]");
    expect(output).toContain("  One (tabId: t1)\n");
  });

  it("appends the url for browser panes", () => {
    const snapshot: LayoutSnapshot = {
      workspacePath: "/ws",
      activeTabId: "t1",
      focusedPaneId: "p1",
      tabs: [
        {
          tabId: "t1",
          title: "One",
          focusedPaneId: "p1",
          panes: [
            {
              paneId: "p1",
              contentType: "browser",
              url: "https://example.com",
            },
          ],
        },
      ],
    };

    expect(formatLayoutSnapshot(snapshot)).toBe(
      "/ws\n  One (tabId: t1) [active]\n" +
        "    - browser (paneId: p1) https://example.com [focused]",
    );
  });
});
