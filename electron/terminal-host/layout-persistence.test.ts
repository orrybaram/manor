import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { PaneNode } from "../../src/lib/layout/pane-tree";
import {
  workspaceKey,
  type WorkspaceKey,
  type WorkspaceKeyOwner,
} from "../../src/lib/workspace-key";
import {
  LayoutPersistence,
  LAYOUT_VERSION,
  type PersistedLayout,
  type PersistedLayoutV1,
  type PersistedLayoutV2,
  type PersistedWorkspace,
  type PersistedTab,
  migrateWorkspaceViewport,
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
    return migrateWorkspaceViewport({
      workspacePath: workspacePath as WorkspaceKey,
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
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
        workspaces: [
          makeV2Workspace("/project/main", [session], session.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(LAYOUT_VERSION);
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
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
        workspaces: [
          makeV2Workspace("/project/main", [s1, s2, s3], s2.id),
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      const panels = Object.values(loaded!.workspaces[0].panels);
      expect(panels[0].tabs).toHaveLength(3);
      // The selection is not on the tree any more (ADR-179 ticket 4); what
      // survives a save is the default viewport.
      expect(
        Object.values(loaded!.workspaces[0].defaultViewport.selectedTabIds),
      ).toEqual([s2.id]);
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
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
          makeV2Workspace("/project/feature", [makeLeafTab("p2", "ds2")], "y"),
        ],
      };
      persistence.save(layout);

      persistence.removeWorkspace("/project/feature" as WorkspaceKey);

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
    });

    it("no-op when workspace doesn't exist", () => {
      const layout: PersistedLayout = {
        version: LAYOUT_VERSION,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
        ],
      };
      persistence.save(layout);

      persistence.removeWorkspace("/nonexistent" as WorkspaceKey);

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
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
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

    it("ignores a legacy Home entry, whose sessions are being ended (ADR-197)", () => {
      persistence.save({
        version: LAYOUT_VERSION,
        workspaces: [
          makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x"),
          makeV2Workspace("__home__", [makeLeafTab("p2", "ds2")], "y"),
        ],
      });
      const ids = persistence.getActiveSessionIds();
      expect([...ids]).toEqual(["ds1"]);
    });

    it("collects session IDs from split panes", () => {
      const layout: PersistedLayout = {
        version: LAYOUT_VERSION,
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
        version: LAYOUT_VERSION,
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
        workspacePath: "/project/main" as WorkspaceKey,
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
        workspacePath: "/project/feature" as WorkspaceKey,
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

  describe("viewport migration (ADR-179 D3)", () => {
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

    it("strips the focus fields off the tree (ADR-179 ticket 4)", () => {
      // They are viewport, not structure: they live in `defaultViewport` and
      // in each renderer's own file, and nowhere else.
      const main = loadFixture().workspaces[0];
      expect(main.activePanelId).toBeUndefined();
      expect(main.panels["panel-a"].selectedTabId).toBeUndefined();
      expect(main.panels["panel-a"].tabs[0].focusedPaneId).toBeUndefined();
    });

    it("never drops a tab, a pin, a pane session or a browser pane", () => {
      const loaded = loadFixture();
      // Still keyed by bare path: the key migration (ADR-191) moves it on.
      expect(loaded.version).toBe(2);
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

    it("fills in a keyed (v3) workspace that has no defaultViewport, as v4", () => {
      const half = {
        ...V2_FIXTURE,
        version: 3,
        workspaces: [V2_FIXTURE.workspaces[1]],
      };
      fs.writeFileSync(layoutFile, JSON.stringify(half, null, 2));

      const loaded = persistence.load()!;
      const feature = loaded.workspaces[0];
      expect(feature.defaultViewport).toEqual({
        activePanelId: "panel-c",
        selectedTabIds: { "panel-c": "tab-4" },
        focusedPaneIds: { "tab-4": "pane-5" },
      });
      expect(loaded.version).toBe(LAYOUT_VERSION);
      expect(JSON.parse(fs.readFileSync(layoutFile, "utf-8")).version).toBe(
        LAYOUT_VERSION,
      );
    });

    it("reads a pre-ADR-191 v3 file (viewport split, bare paths) as unkeyed", () => {
      // Builds of ADR-179 cut before ADR-191 wrote version 3 with a
      // defaultViewport and bare-path keys; its key migration must still run.
      const early = {
        version: 3,
        workspaces: [makeV2Workspace("/project/main", [makeLeafTab("p1", "ds1")], "x")],
      };
      fs.writeFileSync(layoutFile, JSON.stringify(early, null, 2));

      expect(persistence.load()!.version).toBe(2);
      expect(persistence.needsWorkspaceKeyMigration()).toBe(true);
    });
  });

  describe("v1 migration", () => {
    it("migrates v1 layout to an unkeyed v2 with its viewport split out on load", () => {
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
      expect(Object.values(ws.defaultViewport.selectedTabIds)).toEqual([
        tab.id,
      ]);
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
      expect(raw.version).toBe(2);
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
      expect(loaded!.version).toBe(2);
    });
  });

  // ADR-191: workspaces are keyed by host plus path from version 3.
  describe("workspace keys (v3+)", () => {
    const SHARED = "/home/me/.manor/worktrees/app/feat";
    const LOCAL_ONLY = "/home/me/code/other";
    const box = workspaceKey("box", SHARED);

    /** A local and a remote project of the same repo at the same paths. */
    const owners: WorkspaceKeyOwner[] = [
      { hostId: "local", path: "/home/me/app", workspaces: [{ path: SHARED }] },
      {
        hostId: "box",
        path: "/srv/app",
        worktreeRoot: "/srv/worktrees/app",
        workspaces: [{ path: SHARED }],
      },
    ];

    function writeRaw(layout: object): void {
      fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2));
    }

    function readRaw(): PersistedLayout {
      return JSON.parse(fs.readFileSync(layoutFile, "utf-8"));
    }

    /** Write keyed workspaces as the server would; the last is last-active. */
    function saveKeyed(...workspaces: PersistedWorkspace[]): void {
      persistence.save({
        version: LAYOUT_VERSION,
        workspaces,
        lastActiveWorkspacePath: workspaces[workspaces.length - 1]?.workspacePath ?? null,
      });
    }

    function paneIdsOf(ws: PersistedWorkspace): string[] {
      return Object.values(ws.panels).flatMap((p) =>
        p.tabs.flatMap((t) => Object.keys(t.paneSessions)),
      );
    }

    it("keeps separate layouts for the same path on two hosts across a restart", () => {
      const localTab = makeLeafTab("local-pane", "ds-local");
      const boxTab = makeLeafTab("box-pane", "ds-box");
      saveKeyed(
        makeV2Workspace(SHARED, [localTab], localTab.id),
        makeV2Workspace(box, [boxTab], boxTab.id),
      );

      // A new instance reads what a relaunch would.
      const loaded = new LayoutPersistence(layoutFile).load()!;

      expect(loaded.version).toBe(LAYOUT_VERSION);
      const byKey = new Map<string, PersistedWorkspace>(loaded.workspaces.map((w) => [w.workspacePath, w]));
      expect(byKey.size).toBe(2);
      expect(paneIdsOf(byKey.get(SHARED)!)).toEqual(["local-pane"]);
      expect(paneIdsOf(byKey.get(box)!)).toEqual(["box-pane"]);
      expect(loaded.lastActiveWorkspacePath).toBe(box);
    });

    it("removes one host's layout without touching the other's", () => {
      const a = makeLeafTab("a", "ds-a");
      const b = makeLeafTab("b", "ds-b");
      saveKeyed(makeV2Workspace(SHARED, [a], a.id), makeV2Workspace(box, [b], b.id));

      persistence.removeWorkspace(box);

      expect(persistence.load()!.workspaces.map((w) => w.workspacePath)).toEqual([SHARED]);
    });

    it("migrates a v2 file once, each path to the host of the project that owns it", () => {
      const remoteOnly = "/srv/worktrees/app/fix";
      const t1 = makeLeafTab("p1", "ds1");
      const t2 = makeLeafTab("p2", "ds2");
      const t3 = makeLeafTab("p3", "ds3");
      writeRaw({
        version: 2,
        workspaces: [
          makeV2Workspace(SHARED, [t1], t1.id),
          makeV2Workspace(remoteOnly, [t2], t2.id),
          makeV2Workspace(LOCAL_ONLY, [t3], t3.id),
        ],
        lastActiveWorkspacePath: remoteOnly,
      });

      expect(persistence.needsWorkspaceKeyMigration()).toBe(true);
      persistence.migrateWorkspaceKeys(owners);

      const raw = readRaw();
      expect(raw.version).toBe(LAYOUT_VERSION);
      // A path both hosts have stays local; one only the box owns moves there;
      // one no project owns stays local. Nothing is dropped.
      expect(raw.workspaces.map((w) => w.workspacePath)).toEqual([
        SHARED,
        workspaceKey("box", remoteOnly),
        LOCAL_ONLY,
      ]);
      expect(raw.workspaces.map(paneIdsOf)).toEqual([["p1"], ["p2"], ["p3"]]);
      expect(raw.lastActiveWorkspacePath).toBe(workspaceKey("box", remoteOnly));
      expect(persistence.needsWorkspaceKeyMigration()).toBe(false);
    });

    it("keeps every path of a local-only file as it was", () => {
      const t1 = makeLeafTab("p1", "ds1");
      const t2 = makeLeafTab("p2", "ds2");
      writeRaw({
        version: 2,
        workspaces: [
          makeV2Workspace(SHARED, [t1], t1.id),
          makeV2Workspace(LOCAL_ONLY, [t2], t2.id),
        ],
        lastActiveWorkspacePath: "__home__",
      });

      persistence.migrateWorkspaceKeys([]);

      const raw = readRaw();
      expect(raw.version).toBe(LAYOUT_VERSION);
      expect(raw.workspaces.map((w) => w.workspacePath)).toEqual([SHARED, LOCAL_ONLY]);
      expect(raw.lastActiveWorkspacePath).toBe("__home__");
    });

    it("never migrates a keyed file again: a bare key there is local", () => {
      const onlyBox: WorkspaceKeyOwner[] = [{ hostId: "box", path: "/home/me/app" }];
      const t = makeLeafTab("p1", "ds1");
      saveKeyed(makeV2Workspace(SHARED, [t], t.id));

      persistence.migrateWorkspaceKeys(onlyBox);

      expect(persistence.load()!.workspaces[0].workspacePath).toBe(SHARED);
    });

    it("migrates a v1 file through v2 to v3", () => {
      const tab = makeLeafTab("p1", "ds1");
      const v1: PersistedLayoutV1 = {
        version: 1,
        workspaces: [{ workspacePath: "/srv/app", tabs: [tab], selectedTabId: tab.id }],
      };
      writeRaw(v1);

      persistence.migrateWorkspaceKeys(owners);

      const raw = readRaw();
      expect(raw.version).toBe(LAYOUT_VERSION);
      expect(raw.workspaces[0].workspacePath).toBe(workspaceKey("box", "/srv/app"));
    });

    it("asks for the projects only when the file needs migrating", async () => {
      const t = makeLeafTab("p1", "ds1");
      writeRaw({ version: 2, workspaces: [makeV2Workspace("/srv/app", [t], t.id)] });
      const ownersFn = vi.fn(async () => owners);

      await persistence.startWorkspaceKeyMigration(ownersFn);
      await persistence.whenReady();
      await persistence.startWorkspaceKeyMigration(ownersFn);

      expect(ownersFn).toHaveBeenCalledTimes(1);
      expect(persistence.load()!.workspaces[0].workspacePath).toBe(
        workspaceKey("box", "/srv/app"),
      );
    });

    it("keeps the file at v2 while a remote host can't say what it owns", async () => {
      const t = makeLeafTab("p1", "ds1");
      writeRaw({ version: 2, workspaces: [makeV2Workspace("/srv/app", [t], t.id)] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await persistence.startWorkspaceKeyMigration(async () => null);

      // Retried next launch, not guessed now: a guess at v3 is permanent.
      expect(readRaw().version).toBe(2);
      expect(readRaw().workspaces[0].workspacePath).toBe("/srv/app");
      warn.mockRestore();
    });

    it("never gives a bare entry to a host that already has its own layout", () => {
      const legacy = makeLeafTab("legacy", "ds1");
      const boxOwn = makeLeafTab("box-own", "ds2");
      writeRaw({
        version: 2,
        workspaces: [
          makeV2Workspace("/srv/app", [legacy], legacy.id),
          makeV2Workspace(workspaceKey("box", "/srv/app"), [boxOwn], boxOwn.id),
        ],
        lastActiveWorkspacePath: "/srv/app",
      });

      persistence.migrateWorkspaceKeys(owners);

      // Both kept, each under its own key: no collision, nothing dropped.
      const raw = readRaw();
      expect(raw.workspaces.map((w) => [w.workspacePath, paneIdsOf(w)])).toEqual([
        ["/srv/app", ["legacy"]],
        [workspaceKey("box", "/srv/app"), ["box-own"]],
      ]);
      expect(raw.lastActiveWorkspacePath).toBe("/srv/app");
    });

    // The re-review's scenario: the renderer's project list had the remote
    // project without its workspaces yet, while main's migration sees them.
    // The renderer's keys never depended on that list, so the two agree.
    it("keeps what the renderer wrote at v2 when main's owners differ from the renderer's", () => {
      const legacy = makeLeafTab("local-legacy", "ds1");
      const box = makeLeafTab("box-pane", "ds2");
      writeRaw({
        version: 2,
        workspaces: [
          // The local workspace, saved under its key: the bare path.
          makeV2Workspace(SHARED, [legacy], legacy.id),
          // The remote one, saved under its key while its project had no
          // workspaces loaded in the renderer.
          makeV2Workspace(workspaceKey("box", SHARED), [box], box.id),
        ],
      });
      // Main's owners: only the box lists the path, so a bare-path rule
      // alone would move the local layout onto the remote host.
      const mainOwners: WorkspaceKeyOwner[] = [
        { hostId: "local", path: "/home/me/app" },
        { hostId: "box", path: "/srv/app", workspaces: [{ path: SHARED }] },
      ];

      persistence.migrateWorkspaceKeys(mainOwners);

      const byKey = new Map<string, PersistedWorkspace>(
        readRaw().workspaces.map((w) => [w.workspacePath, w]),
      );
      expect(paneIdsOf(byKey.get(SHARED)!)).toEqual(["local-legacy"]);
      expect(paneIdsOf(byKey.get(workspaceKey("box", SHARED))!)).toEqual(["box-pane"]);
    });

    it("keeps the file at v2 when the projects can't be read", async () => {
      const t = makeLeafTab("p1", "ds1");
      writeRaw({ version: 2, workspaces: [makeV2Workspace("/srv/app", [t], t.id)] });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      await persistence.startWorkspaceKeyMigration(async () => {
        throw new Error("no projects");
      });

      expect(readRaw().version).toBe(2);
      error.mockRestore();
    });
  });
});
