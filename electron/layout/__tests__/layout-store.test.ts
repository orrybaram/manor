/**
 * `LayoutStore` — the Manor server's layout authority (ADR-179 D1/D3).
 *
 * The four properties worth pinning: a command bumps the version and reaches
 * every renderer, commands on one workspace never interleave, a closed
 * *terminal* pane (and only a terminal pane) ends its session, and what the
 * PTY stream says about a pane reaches the file without waking a renderer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { LayoutStore, type LayoutClaim } from "../layout-store";
import {
  LayoutPersistence,
  type PersistedLayout,
  type PersistedLayoutV2,
} from "../../terminal-host/layout-persistence";
import type { LocalBackend } from "../../backend/local-backend";
import type { WorkspaceLayout } from "../../../src/lib/layout/workspace-layout";
import type { Tab } from "../../../src/lib/layout/workspace-layout";

const WS = "/project/main";

interface Broadcast {
  workspacePath: string;
  version: number;
  layout: WorkspaceLayout;
  claims: LayoutClaim[];
}

function leafTab(id: string, paneId: string, title = "Terminal"): Tab {
  return { id, title, rootNode: { type: "leaf", paneId }, focusedPaneId: paneId };
}

/** A v2 file with one workspace, one panel, one split tab and a diff pane. */
function v2File(): PersistedLayoutV2 {
  return {
    version: 2,
    lastActiveWorkspacePath: WS,
    workspaces: [
      {
        workspacePath: WS,
        panelTree: { type: "leaf", panelId: "panel-1" },
        panels: {
          "panel-1": {
            id: "panel-1",
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
                    paneId: "pane-diff",
                    contentType: "diff",
                  },
                },
                focusedPaneId: "pane-1",
                paneSessions: {
                  "pane-1": {
                    daemonSessionId: "pane-1",
                    lastCwd: "/project/main",
                    lastTitle: null,
                  },
                },
              },
            ],
            selectedTabId: "tab-1",
            pinnedTabIds: [],
          },
        },
        activePanelId: "panel-1",
      },
    ],
  };
}

describe("LayoutStore", () => {
  let tmpDir: string;
  let layoutFile: string;
  let persistence: LayoutPersistence;
  let broadcasts: Broadcast[];
  let kill: ReturnType<typeof vi.fn>;
  let store: LayoutStore;

  function makeStore(): LayoutStore {
    return new LayoutStore(
      persistence,
      (workspacePath, version, layout, claims) =>
        broadcasts.push({ workspacePath, version, layout, claims }),
      { pty: { kill } } as unknown as Pick<LocalBackend, "pty">,
    );
  }

  function readFile(): PersistedLayout {
    return JSON.parse(fs.readFileSync(layoutFile, "utf-8"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = path.join(os.tmpdir(), `manor-layout-store-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    layoutFile = path.join(tmpDir, "layout.json");
    persistence = new LayoutPersistence(layoutFile);
    broadcasts = [];
    kill = vi.fn().mockResolvedValue(undefined);
    store = makeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("load", () => {
    it("migrates a v2 file into memory as v3", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();

      const entry = store.get(WS);
      expect(entry).not.toBeNull();
      expect(entry!.version).toBe(0);
      expect(entry!.layout.panels["panel-1"].tabs.map((t) => t.id)).toEqual([
        "tab-1",
      ]);
      expect(entry!.defaultViewport).toEqual({
        activePanelId: "panel-1",
        selectedTabIds: { "panel-1": "tab-1" },
        focusedPaneIds: { "tab-1": "pane-1" },
      });
      // Per-tab in the file, one map per workspace in memory.
      expect(entry!.paneSessions["pane-1"].lastCwd).toBe("/project/main");
      expect(readFile().version).toBe(3);
    });

    it("a second load of the migrated file is a no-op", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      const afterFirst = fs.readFileSync(layoutFile, "utf-8");

      const second = makeStore();
      second.load();

      expect(second.getAll()).toEqual(store.getAll());
      expect(fs.readFileSync(layoutFile, "utf-8")).toBe(afterFirst);
    });

    it("an absent file leaves an empty store", () => {
      store.load();
      expect(store.getAll()).toEqual({});
    });
  });

  describe("apply", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
    });

    it("bumps the version and broadcasts the reduced layout", async () => {
      const result = await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "1" },
      );

      expect(result).toEqual({ version: 1 });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].workspacePath).toBe(WS);
      expect(broadcasts[0].version).toBe(1);
      expect(broadcasts[0].claims).toEqual([]);
      expect(
        broadcasts[0].layout.panels["panel-1"].tabs.map((t) => t.id),
      ).toEqual(["tab-1", "tab-2"]);
      // The broadcast *is* the store's state; no second reducer anywhere.
      expect(broadcasts[0].layout).toBe(store.get(WS)!.layout);
    });

    it("serializes two rapid applies", async () => {
      const first = store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "1" },
      );
      const second = store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-3", "pane-3") },
        { kind: "bridge", id: "web" },
      );

      expect(await first).toEqual({ version: 1 });
      expect(await second).toEqual({ version: 2 });
      expect(broadcasts.map((b) => b.version)).toEqual([1, 2]);
      expect(
        store.get(WS)!.layout.panels["panel-1"].tabs.map((t) => t.id),
      ).toEqual(["tab-1", "tab-2", "tab-3"]);
    });

    it("kills a closed terminal pane exactly once", async () => {
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-1" },
        { kind: "window", id: "1" },
      );

      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("pane-1");
      expect(store.get(WS)!.paneSessions["pane-1"]).toBeUndefined();
    });

    it("never kills a closed diff pane", async () => {
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-diff" },
        { kind: "window", id: "1" },
      );

      expect(kill).not.toHaveBeenCalled();
      expect(store.get(WS)!.version).toBe(1);
    });

    it("fills the reopen stack's metadata from the server, not the sender", async () => {
      // No `paneMetadata` on the command at all: the url and content type come
      // from the tree, the cwd from `paneSessions` (ADR-179 D3).
      await store.apply(
        WS,
        {
          type: "split-pane",
          paneId: "pane-1",
          direction: "horizontal",
          newPaneId: "pane-web",
          contentType: "browser",
          url: "http://localhost:3000",
        },
        { kind: "window", id: "1" },
      );
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-web" },
        { kind: "window", id: "1" },
      );
      await store.apply(
        WS,
        { type: "reopen-closed-pane", newTabId: "tab-restored" },
        { kind: "window", id: "1" },
      );

      const tab = store.get(WS)!.layout.panels["panel-1"].tabs[0];
      const restored = JSON.stringify(tab.rootNode);
      expect(restored).toContain("pane-web");
      expect(restored).toContain("browser");
    });

    it("creates the workspace when it has never heard of it", async () => {
      const result = await store.apply(
        "/project/brand-new",
        { type: "new-tab", tab: leafTab("tab-9", "pane-9") },
        { kind: "route", id: "cli" },
      );

      expect(result).toEqual({ version: 1 });
      const entry = store.get("/project/brand-new")!;
      const panels = Object.values(entry.layout.panels);
      expect(panels).toHaveLength(1);
      expect(panels[0].tabs.map((t) => t.id)).toEqual(["tab-9"]);
    });

    it("a stale command is a no-op, not an error or a version bump", async () => {
      const result = await store.apply(
        WS,
        { type: "close-tab", tabId: "tab-gone" },
        { kind: "window", id: "1" },
      );

      expect(result).toEqual({ version: 0 });
      expect(broadcasts).toHaveLength(0);
    });

    it("refuses a command it does not have", async () => {
      const result = await store.apply(
        WS,
        { type: "teleport-pane" } as never,
        { kind: "bridge", id: "web" },
      );

      expect(result).toEqual({
        error: expect.stringContaining("teleport-pane"),
      });
      expect(broadcasts).toHaveLength(0);
    });

    it("set-pane-title moves no furniture and wakes no renderer", async () => {
      const result = await store.apply(
        WS,
        { type: "set-pane-title", paneId: "pane-1", title: "build" },
        { kind: "window", id: "1" },
      );

      expect(result).toEqual({ version: 0 });
      expect(broadcasts).toHaveLength(0);
      expect(store.get(WS)!.paneSessions["pane-1"].lastTitle).toBe("build");
    });

    it("set-pane-title opens a session entry for a pane that has none", async () => {
      // The diff pane has no daemon session and no `paneSessions` row yet.
      await store.apply(
        WS,
        { type: "set-pane-title", paneId: "pane-diff", title: "Diff" },
        { kind: "window", id: "1" },
      );
      await store.apply(
        WS,
        { type: "set-pane-title", paneId: "pane-gone", title: "nowhere" },
        { kind: "window", id: "1" },
      );

      expect(store.get(WS)!.paneSessions["pane-diff"]).toMatchObject({
        daemonSessionId: "pane-diff",
        lastTitle: "Diff",
      });
      expect(store.get(WS)!.paneSessions["pane-gone"]).toBeUndefined();
    });
  });

  describe("persistence", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
    });

    it("debounces the write and includes the new tab once it lands", async () => {
      const before = fs.readFileSync(layoutFile, "utf-8");
      await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "1" },
      );

      expect(fs.readFileSync(layoutFile, "utf-8")).toBe(before);

      vi.advanceTimersByTime(300);

      const panels = readFile().workspaces[0].panels;
      expect(panels["panel-1"].tabs.map((t) => t.id)).toEqual([
        "tab-1",
        "tab-2",
      ]);
    });

    it("flush writes the pending change immediately", async () => {
      await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "1" },
      );

      store.flush();

      expect(readFile().workspaces[0].panels["panel-1"].tabs).toHaveLength(2);
      // Nothing pending: a second flush must not rewrite the file.
      const after = fs.readFileSync(layoutFile, "utf-8");
      store.flush();
      expect(fs.readFileSync(layoutFile, "utf-8")).toBe(after);
    });

    it("writes paneSessions back under the tab that holds the pane", async () => {
      await store.apply(
        WS,
        {
          type: "extract-pane-to-tab",
          paneId: "pane-1",
          newTabId: "tab-extracted",
        },
        { kind: "window", id: "1" },
      );
      store.flush();

      const tabs = readFile().workspaces[0].panels["panel-1"].tabs;
      const extracted = tabs.find((t) => t.id === "tab-extracted")!;
      expect(Object.keys(extracted.paneSessions)).toEqual(["pane-1"]);
      expect(tabs.find((t) => t.id === "tab-1")!.paneSessions).toEqual({});
    });

    it("remove drops the workspace from memory and from the file", () => {
      store.remove(WS);

      expect(store.get(WS)).toBeNull();
      expect(readFile().workspaces).toEqual([]);
    });
  });

  describe("onPtyEvent", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
    });

    it("folds cwd and agent status into paneSessions without broadcasting", () => {
      store.onPtyEvent({ type: "cwd", sessionId: "pane-1", cwd: "/tmp/other" });
      store.onPtyEvent({
        type: "agentStatus",
        sessionId: "pane-1",
        agent: {
          kind: "claude",
          status: "busy",
          processName: "claude",
          since: 1,
          title: "refactoring",
        },
      });

      const session = store.get(WS)!.paneSessions["pane-1"];
      expect(session.lastCwd).toBe("/tmp/other");
      expect(session.lastTitle).toBe("refactoring");
      expect(session.lastAgentStatus?.status).toBe("busy");
      // Every renderer already receives the PTY event itself (D3).
      expect(broadcasts).toHaveLength(0);

      store.flush();
      const persisted =
        readFile().workspaces[0].panels["panel-1"].tabs[0].paneSessions;
      expect(persisted["pane-1"].lastCwd).toBe("/tmp/other");
    });

    it("ignores output and events for panes it does not have", () => {
      store.onPtyEvent({ type: "data", sessionId: "pane-1", data: "hi" });
      store.onPtyEvent({ type: "cwd", sessionId: "pane-nope", cwd: "/tmp" });

      expect(store.get(WS)!.paneSessions["pane-1"].lastCwd).toBe(
        "/project/main",
      );
    });
  });

  describe("reportViewport", () => {
    it("keeps the last report as the workspace's default viewport", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();

      store.reportViewport(WS, "window-1", {
        activePanelId: "panel-1",
        selectedTabIds: { "panel-1": "tab-1" },
        focusedPaneIds: { "tab-1": "pane-diff" },
      });
      store.flush();

      expect(readFile().workspaces[0].defaultViewport.focusedPaneIds).toEqual({
        "tab-1": "pane-diff",
      });
    });
  });

  describe("ensure", () => {
    it("hands back a fresh single-panel layout the first time", () => {
      const entry = store.ensure("/project/unseen");
      const panelIds = Object.keys(entry.layout.panels);

      expect(panelIds).toHaveLength(1);
      expect(entry.layout.panelTree).toEqual({
        type: "leaf",
        panelId: panelIds[0],
      });
      expect(entry.layout.activePanelId).toBe(panelIds[0]);
      expect(entry.version).toBe(0);
      expect(store.ensure("/project/unseen").layout).toBe(entry.layout);
    });
  });
});
