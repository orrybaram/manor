import { describe, it, expect } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneId,
  selectSelectedTabId,
} from "../app-store";
import {
  resetFakeLayoutServer,
  seedLayout,
  settled,
} from "./fake-layout-server";

// The selection is viewport (ADR-179 D3): a workspace can arrive from the
// server with no viewport of this renderer's and a default viewport naming
// nothing. Restoring it without a selection used to leave `addTab` with no
// panel to target, so every "new terminal" action silently did nothing.

const WS_PATH = "/test/stripped-selection";

describe("restoring a workspace with no selection to restore", () => {
  it("falls back to the first panel, tab and pane so new tabs still open", async () => {
    resetFakeLayoutServer();
    seedLayout(WS_PATH, {
      panelTree: { type: "leaf", panelId: "panel-1" },
      panels: {
        "panel-1": {
          id: "panel-1",
          tabs: [
            {
              id: "tab-1",
              title: "Terminal",
              rootNode: { type: "leaf", paneId: "pane-1" },
            },
          ],
          pinnedTabIds: [],
        },
      },
    });
    useAppStore.setState({
      workspaceLayouts: {},
      mountedWorkspaces: {},
      layoutVersions: {},
      viewports: {},
      claims: {},
      activeWorkspacePath: null,
      activeWorkspaceHostId: "local",
    });

    await useAppStore.getState().loadPersistedLayout();
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    const state = useAppStore.getState();
    expect(selectActivePanelId(state)).toBe("panel-1");
    expect(selectSelectedTabId(state, "panel-1")).toBe("tab-1");
    expect(selectFocusedPaneId(state, "tab-1")).toBe("pane-1");

    const created = useAppStore.getState().addTab();
    expect(created).not.toBeNull();
    // The tab arrives with the server's broadcast (ADR-182 D9).
    await settled();
    const after = useAppStore.getState();
    expect(after.workspaceLayouts[WS_PATH].panels["panel-1"].tabs).toHaveLength(2);
    expect(selectSelectedTabId(after, "panel-1")).toBe(created?.tabId);
  });
});
