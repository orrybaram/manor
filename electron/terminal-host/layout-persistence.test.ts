import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { PaneNode } from "../../src/store/pane-tree";
import {
  LayoutPersistence,
  type PersistedLayout,
  type PersistedLayoutV1,
  type PersistedWorkspace,
  type PersistedWorkspaceV1,
  type PersistedPanel,
  type PersistedTab,
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

  /** Create a v2 workspace with a single panel wrapping the given tabs. */
  function makeV2Workspace(
    workspacePath: string,
    tabs: PersistedTab[],
    selectedTabId: string,
    pinnedTabIds: string[] = [],
  ): PersistedWorkspace {
    const panelId = `panel-${crypto.randomUUID()}`;
    return {
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
    };
  }

  describe("save and load", () => {
    it("saves layout to disk", () => {
      const layout: PersistedLayout = {
        version: 2,
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
        version: 2,
        workspaces: [
          makeV2Workspace("/project/main", [session], session.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
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
        version: 2,
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
        version: 2,
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
        version: 2,
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
        version: 2,
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

  describe("saveWorkspace", () => {
    it("adds workspace if layout doesn't exist yet", () => {
      const workspace = makeV2Workspace(
        "/project/main",
        [makeLeafTab("p1", "ds1")],
        "x",
      );

      persistence.saveWorkspace(workspace);

      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
    });

    it("upserts by workspacePath", () => {
      // Save initial
      persistence.saveWorkspace(
        makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
      );

      // Update same workspace
      persistence.saveWorkspace(
        makeV2Workspace(
          "/project/main",
          [makeLeafTab("p1", "ds1"), makeLeafTab("p2", "ds2")],
          "y",
        ),
      );

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(1);
      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels[0].tabs).toHaveLength(2);
    });

    it("doesn't clobber other workspaces", () => {
      persistence.saveWorkspace(
        makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
      );

      persistence.saveWorkspace(
        makeV2Workspace("/project/feature", [makeLeafTab("p2", "ds2")], "y"),
      );

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(2);
    });
  });

  describe("removeWorkspace", () => {
    it("removes a workspace", () => {
      const layout: PersistedLayout = {
        version: 2,
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
        version: 2,
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

  describe("reconcile", () => {
    it("marks panes as warm when daemon has the session", () => {
      const workspace = makeV2Workspace(
        "/project",
        [makeLeafTab("p1", "ds1")],
        "s1",
      );

      const aliveDaemonSessions = new Set(["ds1"]);
      const persistedSessions = new Set<string>();

      const plan = persistence.reconcile(
        workspace,
        aliveDaemonSessions,
        persistedSessions,
      );

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe("warm");
      expect(plan.actions[0].paneId).toBe("p1");
      if (plan.actions[0].type === "warm") {
        expect(plan.actions[0].daemonSessionId).toBe("ds1");
      }
    });

    it("marks panes as cold when daemon lost session but scrollback exists", () => {
      const workspace = makeV2Workspace(
        "/project",
        [makeLeafTab("p1", "ds1")],
        "s1",
      );

      const aliveDaemonSessions = new Set<string>(); // daemon lost it
      const persistedSessions = new Set(["ds1"]); // but scrollback exists

      const plan = persistence.reconcile(
        workspace,
        aliveDaemonSessions,
        persistedSessions,
      );

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe("cold");
      expect(plan.actions[0].paneId).toBe("p1");
    });

    it("marks panes as fresh when neither daemon nor scrollback has it", () => {
      const workspace = makeV2Workspace(
        "/project",
        [makeLeafTab("p1", "ds1")],
        "s1",
      );

      const aliveDaemonSessions = new Set<string>();
      const persistedSessions = new Set<string>();

      const plan = persistence.reconcile(
        workspace,
        aliveDaemonSessions,
        persistedSessions,
      );

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe("fresh");
      expect(plan.actions[0].paneId).toBe("p1");
    });

    it("handles split panes -- each pane gets its own action", () => {
      const workspace = makeV2Workspace(
        "/project",
        [makeSplitTab(["p1", "p2"], ["ds1", "ds2"])],
        "s1",
      );

      const aliveDaemonSessions = new Set(["ds1"]); // only ds1 alive
      const persistedSessions = new Set(["ds2"]); // ds2 has scrollback

      const plan = persistence.reconcile(
        workspace,
        aliveDaemonSessions,
        persistedSessions,
      );

      expect(plan.actions).toHaveLength(2);

      const warmAction = plan.actions.find((a) => a.paneId === "p1");
      const coldAction = plan.actions.find((a) => a.paneId === "p2");

      expect(warmAction?.type).toBe("warm");
      expect(coldAction?.type).toBe("cold");
    });

    it("handles multiple tabs in workspace", () => {
      const workspace = makeV2Workspace(
        "/project",
        [
          makeLeafTab("p1", "ds1"),
          makeLeafTab("p2", "ds2"),
          makeLeafTab("p3", "ds3"),
        ],
        "s1",
      );

      const aliveDaemonSessions = new Set(["ds1", "ds3"]);
      const persistedSessions = new Set(["ds2"]);

      const plan = persistence.reconcile(
        workspace,
        aliveDaemonSessions,
        persistedSessions,
      );

      expect(plan.actions).toHaveLength(3);
      expect(plan.actions.find((a) => a.paneId === "p1")?.type).toBe("warm");
      expect(plan.actions.find((a) => a.paneId === "p2")?.type).toBe("cold");
      expect(plan.actions.find((a) => a.paneId === "p3")?.type).toBe("warm");
    });

    it("passes lastCwd to cold and fresh actions", () => {
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

      const workspace = makeV2Workspace("/project", [session], "s1");

      // Neither alive nor persisted -> fresh
      const plan = persistence.reconcile(workspace, new Set(), new Set());

      expect(plan.actions[0].type).toBe("fresh");
      if (plan.actions[0].type === "fresh") {
        expect(plan.actions[0].cwd).toBe("/Users/test/code");
      }
    });
  });

  describe("getActiveSessionIds (ADR-117)", () => {
    it("returns empty set when no layout exists", () => {
      const ids = persistence.getActiveSessionIds();
      expect(ids.size).toBe(0);
    });

    it("returns all daemon session IDs from a single workspace", () => {
      const layout: PersistedLayout = {
        version: 2,
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
        version: 2,
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
        version: 2,
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
        version: 2,
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

  describe("v1 migration", () => {
    it("migrates v1 layout to v2 on load", () => {
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
      expect(loaded!.version).toBe(2);
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

    it("persists migrated v2 format back to disk", () => {
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
      expect(raw.version).toBe(2);
      expect(raw.workspaces[0].panelTree).toBeDefined();
      expect(raw.workspaces[0].panels).toBeDefined();
    });

    it("migrates v1 layout without pinnedTabIds", () => {
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
      expect(loaded!.version).toBe(2);
    });
  });
});
