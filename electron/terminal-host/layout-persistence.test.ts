import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import {
  LayoutPersistence,
  type PersistedLayout,
  type PersistedLayoutV1,
  type PersistedLayoutV2,
  type PersistedWorkspace,
  type PersistedTab,
  migrateWorkspaceV2toV3,
} from "./layout-persistence";

describe("LayoutPersistence", () => {
  let tmpDir: string;
  let layoutFile: string;
  let persistence: LayoutPersistence;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-layout-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    layoutFile = path.join(tmpDir, "layout.json");
    persistence = new LayoutPersistence(layoutFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeLeafTab(
    paneId: string,
    daemonSessionId: string,
  ): PersistedTab {
    return {
      id: `session-${crypto.randomUUID()}`,
      title: "Terminal",
      rootNode: { type: "leaf", paneId },
      focusedPaneId: paneId,
      paneSessions: {
        [paneId]: { daemonSessionId, lastCwd: "/tmp", lastTitle: null },
      },
    };
  }

  function makeSplitTab(
    paneIds: [string, string],
    daemonSessionIds: [string, string],
  ): PersistedTab {
    const rootNode: PaneNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: paneIds[0] },
      second: { type: "leaf", paneId: paneIds[1] },
    };
    return {
      id: `session-${crypto.randomUUID()}`,
      title: "Terminal",
      rootNode,
      focusedPaneId: paneIds[0],
      paneSessions: {
        [paneIds[0]]: {
          daemonSessionId: daemonSessionIds[0],
          lastCwd: "/tmp",
          lastTitle: null,
        },
        [paneIds[1]]: {
          daemonSessionId: daemonSessionIds[1],
          lastCwd: "/home",
          lastTitle: null,
        },
      },
    };
  }

  /** Create a workspace with a single panel wrapping the given tabs. */
  function makeV2Workspace(
    workspacePath: string,
    tabs: PersistedTab[],
    selectedTabId: string,
    pinnedTabIds: string[] = [],
  ): PersistedWorkspace {
    const panelId = `panel-${crypto.randomUUID()}`;
    return migrateWorkspaceV2toV3({
      workspacePath,
      panelTree: { type: "leaf", panelId },
      panels: {
        [panelId]: {
          id: panelId,
          tabs,
          selectedTabId,
          pinnedTabIds,
        },
      },
      activePanelId: panelId,
    });
  }

  describe("save and load", () => {
    it("saves layout to disk", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
        ],
      };

      persistence.save(layout);
      expect(fs.existsSync(layoutFile)).toBe(true);
    });

    it("load returns null when file doesn't exist", () => {
      const result = persistence.load();
      expect(result).toBeNull();
    });

    it("roundtrips a single-pane layout", () => {
      const session = makeLeafTab("p1", "ds1");
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [session], session.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(3);
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels).toHaveLength(1);
      expect(panels[0].tabs).toHaveLength(1);
      expect(panels[0].tabs[0].rootNode.type).toBe("leaf");
    });

    it("roundtrips a split-pane layout", () => {
      const session = makeSplitTab(["p1", "p2"], ["ds1", "ds2"]);
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [session], session.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      const panels = Object.values(loaded!.workspaces[0].panels);
      const loadedTab = panels[0].tabs[0];
      expect(loadedTab.rootNode.type).toBe("split");
      if (loadedTab.rootNode.type === "split") {
        expect(loadedTab.rootNode.first.type).toBe("leaf");
        expect(loadedTab.rootNode.second.type).toBe("leaf");
      }

      expect(loadedTab.paneSessions["p1"].daemonSessionId).toBe("ds1");
      expect(loadedTab.paneSessions["p2"].daemonSessionId).toBe("ds2");
    });

    it("roundtrips multiple workspaces", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
          makeV2Workspace("/project/feature", [makeLeafTab("p2", "ds2")], "y"),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(2);
    });

    it("roundtrips multiple tabs per workspace", () => {
      const s1 = makeLeafTab("p1", "ds1");
      const s2 = makeLeafTab("p2", "ds2");
      const s3 = makeSplitTab(["p3", "p4"], ["ds3", "ds4"]);

      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [s1, s2, s3], s2.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels[0].tabs).toHaveLength(3);
      expect(panels[0].selectedTabId).toBe(s2.id);
    });

    it("preserves lastCwd in pane sessions", () => {
      const session: PersistedTab = {
        id: "s1",
        title: "Term",
        rootNode: { type: "leaf", paneId: "p1" },
        focusedPaneId: "p1",
        paneSessions: {
          p1: {
            daemonSessionId: "ds1",
            lastCwd: "/Users/test/code",
            lastTitle: null,
          },
        },
      };

      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project", [session], "s1"),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();
      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels[0].tabs[0].paneSessions.p1.lastCwd).toBe(
        "/Users/test/code",
      );
    });
  });

  describe("removeWorkspace", () => {
    it("removes a workspace", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
          makeV2Workspace("/project/feature", [makeLeafTab("p2", "ds2")], "y"),
        ],
      };
      persistence.save(layout);

      persistence.removeWorkspace("/project/feature");

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
    });

    it("no-op when workspace doesn't exist", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
        ],
      };
      persistence.save(layout);

      persistence.removeWorkspace("/nonexistent");

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(1);
    });
  });

  describe("getActiveSessionIds (ADR-117)", () => {
    it("returns empty set when no layout exists", () => {
      const ids = persistence.getActiveSessionIds();
      expect(ids.size).toBe(0);
    });

    it("returns all daemon session IDs from a single workspace", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace(
            "/project/main",
            [makeLeafTab("p1", "ds1"), makeLeafTab("p2", "ds2")],
            "x",
          ),
        ],
      };
      persistence.save(layout);
      const ids = persistence.getActiveSessionIds();
      expect(ids.has("ds1")).toBe(true);
      expect(ids.has("ds2")).toBe(true);
      expect(ids.size).toBe(2);
    });

    it("collects session IDs across multiple workspaces", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
          makeV2Workspace("/project/feature", [makeLeafTab("p2", "ds2")], "y"),
        ],
      };
      persistence.save(layout);
      const ids = persistence.getActiveSessionIds();
      expect(ids.has("ds1")).toBe(true);
      expect(ids.has("ds2")).toBe(true);
      expect(ids.size).toBe(2);
    });

    it("collects session IDs from split panes", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace(
            "/project/main",
            [makeSplitTab(["p1", "p2"], ["ds1", "ds2"])],
            "x",
          ),
        ],
      };
      persistence.save(layout);
      const ids = persistence.getActiveSessionIds();
      expect(ids.has("ds1")).toBe(true);
      expect(ids.has("ds2")).toBe(true);
      expect(ids.size).toBe(2);
    });

    it("does not include session IDs absent from the layout", () => {
      const layout: PersistedLayout = {
        version: 3,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
        ],
      };
      persistence.save(layout);
      const ids = persistence.getActiveSessionIds();
      expect(ids.has("ds-orphaned")).toBe(false);
      expect(ids.size).toBe(1);
    });
  });

  /**
   * A real v2 file, captured before ADR-179: two workspaces, a pinned tab, a
   * two-panel arrangement and a browser pane. The migration runs once on real
   * users' files, so the fixture is the shape of one rather than a minimum.
   */
  const V2_FIXTURE: PersistedLayoutV2 = {
    version: 2,
    lastActiveWorkspacePath: "/project/main",
    workspaces: [
      {
        workspacePath: "/project/main",
        panelTree: {
          type: "split",
          direction: "vertical",
          ratio: 0.6,
          first: { type: "leaf", panelId: "panel-a" },
          second: { type: "leaf", panelId: "panel-b" },
        },
        panels: {
          "panel-a": {
            id: "panel-a",
            tabs: [
              {
                id: "tab-1",
                title: "Terminal",
                rootNode: {
                  type: "split",
                  direction: "horizontal",
                  ratio: 0.5,
                  first: { type: "leaf", paneId: "pane-1" },
                  second: {
                    type: "leaf",
                    paneId: "pane-2",
                    contentType: "browser",
                    url: "http://localhost:3000",
                  },
                },
                focusedPaneId: "pane-2",
                paneSessions: {
                  "pane-1": {
                    daemonSessionId: "pane-1",
                    lastCwd: "/project/main",
                    lastTitle: "zsh",
                  },
                },
              },
              {
                id: "tab-2",
                title: "Agent",
                rootNode: { type: "leaf", paneId: "pane-3" },
                focusedPaneId: "pane-3",
                paneSessions: {
                  "pane-3": {
                    daemonSessionId: "pane-3",
                    lastCwd: "/project/main",
                    lastTitle: null,
                  },
                },
              },
            ],
            selectedTabId: "tab-2",
            pinnedTabIds: ["tab-2"],
          },
          "panel-b": {
            id: "panel-b",
            tabs: [
              {
                id: "tab-3",
                title: "Diff",
                rootNode: { type: "leaf", paneId: "pane-4", contentType: "diff" },
                focusedPaneId: "pane-4",
                paneSessions: {},
              },
            ],
            selectedTabId: "tab-3",
            pinnedTabIds: [],
          },
        },
        activePanelId: "panel-b",
      },
      {
        workspacePath: "/project/feature",
        panelTree: { type: "leaf", panelId: "panel-c" },
        panels: {
          "panel-c": {
            id: "panel-c",
            tabs: [
              {
                id: "tab-4",
                title: "Terminal",
                rootNode: { type: "leaf", paneId: "pane-5" },
                focusedPaneId: "pane-5",
                paneSessions: {
                  "pane-5": {
                    daemonSessionId: "pane-5",
                    lastCwd: "/project/feature",
                    lastTitle: null,
                  },
                },
              },
            ],
            selectedTabId: "tab-4",
            pinnedTabIds: [],
          },
        },
        activePanelId: "panel-c",
      },
    ],
  };

  describe("v2 -> v3 migration (ADR-179 D3)", () => {
    function loadFixture(): PersistedLayout {
      fs.writeFileSync(layoutFile, JSON.stringify(V2_FIXTURE, null, 2));
      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      return loaded!;
    }

    it("copies the focus fields into defaultViewport", () => {
      const main = loadFixture().workspaces[0];

      expect(main.defaultViewport).toEqual({
        activePanelId: "panel-b",
        selectedTabIds: { "panel-a": "tab-2", "panel-b": "tab-3" },
        focusedPaneIds: {
          "tab-1": "pane-2",
          "tab-2": "pane-3",
          "tab-3": "pane-4",
        },
      });
    });

    it("leaves the focus fields on the tree for now", () => {
      // Ticket 4 strips them; until then a v2-era renderer still reads them.
      const main = loadFixture().workspaces[0];
      expect(main.activePanelId).toBe("panel-b");
      expect(main.panels["panel-a"].selectedTabId).toBe("tab-2");
      expect(main.panels["panel-a"].tabs[0].focusedPaneId).toBe("pane-2");
    });

    it("never drops a tab, a pin, a pane session or a browser pane", () => {
      const loaded = loadFixture();
      expect(loaded.version).toBe(3);
      expect(loaded.workspaces.map((w) => w.workspacePath)).toEqual([
        "/project/main",
        "/project/feature",
      ]);
      expect(loaded.lastActiveWorkspacePath).toBe("/project/main");

      const main = loaded.workspaces[0];
      expect(Object.keys(main.panels).sort()).toEqual(["panel-a", "panel-b"]);
      expect(main.panels["panel-a"].tabs.map((t) => t.id)).toEqual([
        "tab-1",
        "tab-2",
      ]);
      expect(main.panels["panel-a"].pinnedTabIds).toEqual(["tab-2"]);
      expect(main.panels["panel-a"].tabs[0].paneSessions["pane-1"].lastCwd).toBe(
        "/project/main",
      );

      const browserPane = main.panels["panel-a"].tabs[0].rootNode;
      expect(browserPane.type).toBe("split");
      if (browserPane.type === "split") {
        expect(browserPane.second).toEqual({
          type: "leaf",
          paneId: "pane-2",
          contentType: "browser",
          url: "http://localhost:3000",
        });
      }
      expect(main.panelTree).toEqual(V2_FIXTURE.workspaces[0].panelTree);
    });

    it("is idempotent -- a second load changes nothing", () => {
      const first = loadFixture();
      const afterFirstWrite = fs.readFileSync(layoutFile, "utf-8");

      const second = new LayoutPersistence(layoutFile).load();

      expect(second).toEqual(first);
      expect(fs.readFileSync(layoutFile, "utf-8")).toBe(afterFirstWrite);
    });

    it("fills in a v3 workspace that has no defaultViewport", () => {
      const half = {
        ...V2_FIXTURE,
        version: 3,
        workspaces: [V2_FIXTURE.workspaces[1]],
      };
      fs.writeFileSync(layoutFile, JSON.stringify(half, null, 2));

      const feature = persistence.load()!.workspaces[0];
      expect(feature.defaultViewport).toEqual({
        activePanelId: "panel-c",
        selectedTabIds: { "panel-c": "tab-4" },
        focusedPaneIds: { "tab-4": "pane-5" },
      });
    });
  });

  describe("v1 migration", () => {
    it("migrates v1 layout through to v3 on load", () => {
      const tab = makeLeafTab("p1", "ds1");
      const v1Layout: PersistedLayoutV1 = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [tab],
            selectedTabId: tab.id,
            pinnedTabIds: ["pin1"],
          },
        ],
      };

      // Write v1 format directly to disk
      fs.writeFileSync(layoutFile, JSON.stringify(v1Layout, null, 2));

      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(3);
      expect(loaded!.workspaces).toHaveLength(1);

      const ws = loaded!.workspaces[0];
      expect(ws.workspacePath).toBe("/project/main");
      expect(ws.panelTree.type).toBe("leaf");

      const panels = Object.values(ws.panels);
      expect(panels).toHaveLength(1);
      expect(panels[0].tabs).toHaveLength(1);
      expect(panels[0].selectedTabId).toBe(tab.id);
      expect(panels[0].pinnedTabIds).toEqual(["pin1"]);
    });

    it("persists the migrated format back to disk", () => {
      const tab = makeLeafTab("p1", "ds1");
      const v1Layout: PersistedLayoutV1 = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [tab],
            selectedTabId: tab.id,
          },
        ],
      };

      fs.writeFileSync(layoutFile, JSON.stringify(v1Layout, null, 2));

      // First load triggers migration
      persistence.load();

      // Second load should read v2 directly (no migration needed)
      const raw = JSON.parse(fs.readFileSync(layoutFile, "utf-8"));
      expect(raw.version).toBe(3);
      expect(raw.workspaces[0].panelTree).toBeDefined();
      expect(raw.workspaces[0].panels).toBeDefined();
    });

    it("migrates a v1 layout without pinnedTabIds", () => {
      const tab = makeLeafTab("p1", "ds1");
      const v1Layout: PersistedLayoutV1 = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [tab],
            selectedTabId: tab.id,
          },
        ],
      };

      fs.writeFileSync(layoutFile, JSON.stringify(v1Layout, null, 2));

      const loaded = persistence.load();
      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels[0].pinnedTabIds).toEqual([]);
    });

    it("migrates v1 with no version field", () => {
      const tab = makeLeafTab("p1", "ds1");
      const noVersionLayout = {
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [tab],
            selectedTabId: tab.id,
          },
        ],
      };

      fs.writeFileSync(layoutFile, JSON.stringify(noVersionLayout, null, 2));

      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(3);
    });
  });
});
