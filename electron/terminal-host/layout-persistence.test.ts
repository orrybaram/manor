import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { PaneNode } from "../../src/store/pane-tree";
import {
  LayoutPersistence,
  type PersistedLayout,
  type PersistedWorkspace,
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

  describe("save and load", () => {
    it("saves layout to disk", () => {
      const layout: PersistedLayout = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [makeLeafTab("p1", "ds1")],
            selectedTabId: "doesn't matter for save",
          },
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
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [session],
            selectedTabId: session.id,
          },
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(1);
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
      expect(loaded!.workspaces[0].tabs).toHaveLength(1);
      expect(loaded!.workspaces[0].tabs[0].rootNode.type).toBe("leaf");
    });

    it("roundtrips a split-pane layout", () => {
      const session = makeSplitTab(["p1", "p2"], ["ds1", "ds2"]);
      const layout: PersistedLayout = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [session],
            selectedTabId: session.id,
          },
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      const loadedTab = loaded!.workspaces[0].tabs[0];
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
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [makeLeafTab("p1", "ds1")],
            selectedTabId: "x",
          },
          {
            workspacePath: "/project/feature",
            tabs: [makeLeafTab("p2", "ds2")],
            selectedTabId: "y",
          },
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(2);
    });

    it("roundtrips multiple sessions per workspace (tabs)", () => {
      const s1 = makeLeafTab("p1", "ds1");
      const s2 = makeLeafTab("p2", "ds2");
      const s3 = makeSplitTab(["p3", "p4"], ["ds3", "ds4"]);

      const layout: PersistedLayout = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [s1, s2, s3],
            selectedTabId: s2.id,
          },
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();

      expect(loaded!.workspaces[0].tabs).toHaveLength(3);
      expect(loaded!.workspaces[0].selectedTabId).toBe(s2.id);
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
        version: 1,
        workspaces: [
          {
            workspacePath: "/project",
            tabs: [session],
            selectedTabId: "s1",
          },
        ],
      };

      persistence.save(layout);
      const loaded = persistence.load();
      expect(loaded!.workspaces[0].tabs[0].paneSessions.p1.lastCwd).toBe(
        "/Users/test/code",
      );
    });
  });

  describe("saveWorkspace", () => {
    it("adds workspace if layout doesn't exist yet", () => {
      const workspace: PersistedWorkspace = {
        workspacePath: "/project/main",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "x",
      };

      persistence.saveWorkspace(workspace);

      const loaded = persistence.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].workspacePath).toBe("/project/main");
    });

    it("upserts by workspacePath", () => {
      // Save initial
      persistence.saveWorkspace({
        workspacePath: "/project/main",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "x",
      });

      // Update same workspace
      persistence.saveWorkspace({
        workspacePath: "/project/main",
        tabs: [makeLeafTab("p1", "ds1"), makeLeafTab("p2", "ds2")],
        selectedTabId: "y",
      });

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(1);
      expect(loaded!.workspaces[0].tabs).toHaveLength(2);
    });

    it("doesn't clobber other workspaces", () => {
      persistence.saveWorkspace({
        workspacePath: "/project/main",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "x",
      });

      persistence.saveWorkspace({
        workspacePath: "/project/feature",
        tabs: [makeLeafTab("p2", "ds2")],
        selectedTabId: "y",
      });

      const loaded = persistence.load();
      expect(loaded!.workspaces).toHaveLength(2);
    });
  });

  describe("removeWorkspace", () => {
    it("removes a workspace", () => {
      const layout: PersistedLayout = {
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [makeLeafTab("p1", "ds1")],
            selectedTabId: "x",
          },
          {
            workspacePath: "/project/feature",
            tabs: [makeLeafTab("p2", "ds2")],
            selectedTabId: "y",
          },
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
        version: 1,
        workspaces: [
          {
            workspacePath: "/project/main",
            tabs: [makeLeafTab("p1", "ds1")],
            selectedTabId: "x",
          },
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
      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "s1",
      };

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
      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "s1",
      };

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
      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [makeLeafTab("p1", "ds1")],
        selectedTabId: "s1",
      };

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

    it("handles split panes — each pane gets its own action", () => {
      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [makeSplitTab(["p1", "p2"], ["ds1", "ds2"])],
        selectedTabId: "s1",
      };

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

    it("handles multiple sessions (tabs) in workspace", () => {
      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [
          makeLeafTab("p1", "ds1"),
          makeLeafTab("p2", "ds2"),
          makeLeafTab("p3", "ds3"),
        ],
        selectedTabId: "s1",
      };

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

      const workspace: PersistedWorkspace = {
        workspacePath: "/project",
        tabs: [session],
        selectedTabId: "s1",
      };

      // Neither alive nor persisted → fresh
      const plan = persistence.reconcile(workspace, new Set(), new Set());

      expect(plan.actions[0].type).toBe("fresh");
      if (plan.actions[0].type === "fresh") {
        expect(plan.actions[0].cwd).toBe("/Users/test/code");
      }
    });
  });
});
