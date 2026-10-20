import { describe, expect, it } from "vitest";
import { paneTitle, type PaneTitleState } from "../pane-title";
import type { PaneNode } from "../layout/pane-tree";
import type { WorkspaceLayout } from "../layout/workspace-layout";

function layoutWith(rootNode: PaneNode): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: {
      p1: { id: "p1", tabs: [{ id: "t1", title: "t", rootNode }], pinnedTabIds: [] },
    },
  };
}

function state(
  leaf: Extract<PaneNode, { type: "leaf" }>,
  patch: Partial<PaneTitleState> = {},
): PaneTitleState {
  return {
    paneTitle: {},
    paneCwd: {},
    paneLiveUrl: {},
    workspaceLayouts: { "/ws": layoutWith(leaf) },
    ...patch,
  };
}

const TERMINAL = { type: "leaf", paneId: "a" } as const;
const BROWSER = {
  type: "leaf",
  paneId: "a",
  contentType: "browser",
  url: "https://saved.example",
} as const;
const DIFF = { type: "leaf", paneId: "a", contentType: "diff" } as const;

const PINNED = [{ paneId: "a", name: "Reviewer", namePinned: true }];

describe("paneTitle", () => {
  it("names a diff pane Diff, whatever else it carries", () => {
    expect(paneTitle("a", state(DIFF, { paneTitle: { a: "x" } }), PINNED)).toBe("Diff");
  });

  it("prefers a pinned agent name for a terminal", () => {
    expect(paneTitle("a", state(TERMINAL, { paneTitle: { a: "zsh" } }), PINNED)).toBe(
      "Reviewer",
    );
  });

  it("ignores an agent name that is not pinned", () => {
    const agents = [{ paneId: "a", name: "auto", namePinned: false }];
    expect(paneTitle("a", state(TERMINAL, { paneTitle: { a: "zsh" } }), agents)).toBe("zsh");
  });

  it("shows a browser's page title, never a pinned agent name", () => {
    expect(
      paneTitle("a", state(BROWSER, { paneTitle: { a: "Example" } }), PINNED),
    ).toBe("Example");
  });

  it("falls back to a browser's live url, then its saved one, without the scheme", () => {
    expect(
      paneTitle("a", state(BROWSER, { paneLiveUrl: { a: "http://live.example/x" } }), []),
    ).toBe("live.example/x");
    expect(paneTitle("a", state(BROWSER), [])).toBe("saved.example");
  });

  it("shortens a user@host:path shell title to the path's last segment", () => {
    expect(
      paneTitle("a", state(TERMINAL, { paneTitle: { a: "me@box:~/code/manor/" } }), []),
    ).toBe("manor");
  });

  it("falls back to the cwd's last segment, then Terminal", () => {
    expect(paneTitle("a", state(TERMINAL, { paneCwd: { a: "/Users/me/proj" } }), [])).toBe(
      "proj",
    );
    expect(paneTitle("a", state(TERMINAL), [])).toBe("Terminal");
  });
});
