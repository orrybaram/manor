import { describe, it, expect, vi } from "vitest";
import { useAppStore } from "../app-store";

// A layout file written by a newer build keeps selection outside the
// workspace entry (`defaultViewport` / `viewport.json`), so an entry can
// arrive with no `activePanelId`, `selectedTabId` or tab `focusedPaneId`.
// Restoring it verbatim left `addTab` with no panel to target: every "new
// terminal" action silently did nothing.

const WS_PATH = "/test/stripped-selection";

describe("restoring a workspace whose selection ids are missing", () => {
  it("falls back to the first panel, tab and pane so new tabs still open", async () => {
    vi.mocked(window.electronAPI.layout.load).mockResolvedValueOnce({
      version: 2,
      workspaces: [
        {
          workspacePath: WS_PATH,
          panelTree: { type: "leaf", panelId: "panel-1" },
          panels: {
            "panel-1": {
              id: "panel-1",
              tabs: [
                {
                  id: "tab-1",
                  title: "Terminal",
                  rootNode: { type: "leaf", paneId: "pane-1" },
                  paneSessions: {},
                },
              ],
              pinnedTabIds: [],
            },
          },
        },
      ],
    } as never);

    await useAppStore.getState().loadPersistedLayout();
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
    expect(layout.activePanelId).toBe("panel-1");
    expect(layout.panels["panel-1"].selectedTabId).toBe("tab-1");
    expect(layout.panels["panel-1"].tabs[0].focusedPaneId).toBe("pane-1");

    const created = useAppStore.getState().addTab();
    expect(created).not.toBeNull();
    const panel =
      useAppStore.getState().workspaceLayouts[WS_PATH].panels["panel-1"];
    expect(panel.tabs).toHaveLength(2);
    expect(panel.selectedTabId).toBe(created?.tabId);
  });
});
