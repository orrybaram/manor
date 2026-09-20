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

import {
  LayoutStore,
  REOPEN_GRACE_MS,
  type LayoutBroadcast,
} from "../layout-store";
import {
  LayoutPersistence,
  type PersistedLayout,
  type PersistedLayoutV2,
} from "../../terminal-host/layout-persistence";
import type { LocalBackend } from "../../backend/local-backend";
import type { Tab } from "../../../src/lib/layout/workspace-layout";

const WS = "/project/main";

function leafTab(id: string, paneId: string, title = "Terminal"): Tab {
  return { id, title, rootNode: { type: "leaf", paneId } };
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
  let broadcasts: LayoutBroadcast[];
  let kill: ReturnType<typeof vi.fn>;
  let store: LayoutStore;

  function makeStore(primaryId = "primary"): LayoutStore {
    return new LayoutStore(
      persistence,
      (payload) => {
        broadcasts.push(payload);
      },
      { pty: { kill } } as unknown as Pick<LocalBackend, "pty">,
      (rendererId) => rendererId === primaryId,
    );
  }

  /** A window's viewport report, optionally holding one tab (ADR-179 D4). */
  function report(windowId: string, claim?: string): void {
    store.reportViewport(
      WS,
      { kind: "window", id: windowId },
      {
        activePanelId: "panel-1",
        selectedTabIds: { "panel-1": "tab-1" },
        focusedPaneIds: { "tab-1": "pane-1" },
        ...(claim !== undefined && { claim }),
      },
    );
  }

  /** The most recent broadcast — `Array.prototype.at` is out of this lib. */
  function lastBroadcast(): LayoutBroadcast {
    return broadcasts[broadcasts.length - 1];
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
      // v3 strips the focus fields from the tree (ADR-179 ticket 4): they
      // live in `defaultViewport` and in each renderer's own file.
      const savedPanel = readFile().workspaces[0].panels["panel-1"];
      expect(savedPanel.selectedTabId).toBeUndefined();
      expect(savedPanel.tabs[0].focusedPaneId).toBeUndefined();
      expect(readFile().workspaces[0].activePanelId).toBeUndefined();
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

    it("kills a closed terminal pane exactly once, after the grace", async () => {
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-1" },
        { kind: "window", id: "1" },
      );

      // Still warm: the whole point of the grace is that a reopen can have
      // this shell back (ticket 10). The row stays in memory for that, but
      // the snapshot only lists panes the tree holds (ticket 4).
      expect(kill).not.toHaveBeenCalled();
      expect(store.get(WS)!.paneSessions["pane-1"]).toBeUndefined();
      expect(broadcasts[0].restored).toBeUndefined();

      vi.advanceTimersByTime(REOPEN_GRACE_MS);

      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("pane-1");

      vi.advanceTimersByTime(REOPEN_GRACE_MS);
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it("drops the pending command of a pane that leaves the tree", async () => {
      // Queued for a pane nothing ever mounted — closed from another window,
      // say. Without this the line would be typed into whatever pane next
      // happened to reuse the id (ADR-179 ticket 11).
      store.pendingCommands.set("pane-1", "pnpm dev");

      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-1" },
        { kind: "window", id: "1" },
      );

      expect(store.pendingCommands.take("pane-1")).toBeNull();
    });

    it("never kills a closed diff pane", async () => {
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-diff" },
        { kind: "window", id: "1" },
      );

      vi.advanceTimersByTime(REOPEN_GRACE_MS);

      expect(kill).not.toHaveBeenCalled();
      expect(store.get(WS)!.version).toBe(1);
      expect(store.get(WS)!.paneSessions["pane-diff"]).toBeUndefined();
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

  /**
   * The reopen grace (ADR-179 ticket 10).
   *
   * "Reopen closed pane" is an undo, so the session a close ends has to still
   * be there to be undone — the shell, its scrollback, its cwd. The kill is
   * therefore scheduled, a reopen cancels it, and what the server knows about
   * the panes that came back rides along on that one broadcast.
   */
  describe("the reopen grace", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
    });

    async function close(paneId: string): Promise<void> {
      await store.apply(
        WS,
        { type: "close-pane", paneId },
        { kind: "window", id: "1" },
      );
    }

    async function reopen(): Promise<void> {
      await store.apply(
        WS,
        { type: "reopen-closed-pane", newTabId: "tab-restored" },
        { kind: "window", id: "1" },
      );
    }

    it("a reopen inside the grace cancels the kill and hands the session back", async () => {
      store.onPtyEvent({ type: "cwd", sessionId: "pane-1", cwd: "/tmp/deep" });
      await store.apply(
        WS,
        { type: "set-pane-title", paneId: "pane-1", title: "build" },
        { kind: "window", id: "1" },
      );

      await close("pane-1");
      vi.advanceTimersByTime(REOPEN_GRACE_MS - 1);
      await reopen();
      vi.advanceTimersByTime(REOPEN_GRACE_MS * 2);

      expect(kill).not.toHaveBeenCalled();
      const restored = lastBroadcast().restored;
      expect(restored).toEqual({
        "pane-1": {
          daemonSessionId: "pane-1",
          lastCwd: "/tmp/deep",
          lastTitle: "build",
        },
      });
      // And the pane is back in the tree with the same id, so the renderer
      // reattaches the shell rather than spawning one.
      expect(store.get(WS)!.paneSessions["pane-1"].lastCwd).toBe("/tmp/deep");
      expect(
        JSON.stringify(store.get(WS)!.layout.panels["panel-1"].tabs[0]),
      ).toContain("pane-1");
    });

    it("a reopen after the grace comes back fresh", async () => {
      await close("pane-1");
      vi.advanceTimersByTime(REOPEN_GRACE_MS);
      expect(kill).toHaveBeenCalledTimes(1);

      await reopen();

      expect(kill).toHaveBeenCalledTimes(1);
      expect(lastBroadcast().restored).toBeUndefined();
    });

    it("a reopened tab takes back every pane it had", async () => {
      // Closing the tab closes both its panes; only the terminal one has a
      // session to wait out a grace.
      await store.apply(
        WS,
        { type: "close-tab", tabId: "tab-1" },
        { kind: "window", id: "1" },
      );
      await reopen();
      vi.advanceTimersByTime(REOPEN_GRACE_MS * 2);

      expect(kill).not.toHaveBeenCalled();
      expect(Object.keys(lastBroadcast().restored ?? {})).toEqual(["pane-1"]);
    });

    it("flush runs every pending kill, once", async () => {
      await close("pane-1");

      store.flush();

      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("pane-1");

      vi.advanceTimersByTime(REOPEN_GRACE_MS);
      expect(kill).toHaveBeenCalledTimes(1);
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
          status: "working",
          processName: "claude",
          since: 1,
          title: "refactoring",
        },
      });

      const session = store.get(WS)!.paneSessions["pane-1"];
      expect(session.lastCwd).toBe("/tmp/other");
      expect(session.lastTitle).toBe("refactoring");
      expect(session.lastAgentStatus?.status).toBe("working");
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

      store.reportViewport(
        WS,
        { kind: "window", id: "window-1" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-diff" },
        },
      );
      store.flush();

      expect(readFile().workspaces[0].defaultViewport.focusedPaneIds).toEqual({
        "tab-1": "pane-diff",
      });
    });

    it("prefers the primary window's own report", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();

      // A second window reports first; with no primary report yet it stands
      // in, and it stops standing in the moment the primary speaks.
      store.reportViewport(
        WS,
        { kind: "window", id: "other" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-diff" },
        },
      );
      expect(store.primaryViewport(WS)?.focusedPaneIds).toEqual({
        "tab-1": "pane-diff",
      });

      report("primary");
      expect(store.primaryViewport(WS)?.focusedPaneIds).toEqual({
        "tab-1": "pane-1",
      });

      // And a later report from the other window does not take it back.
      store.reportViewport(
        WS,
        { kind: "window", id: "other" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-diff" },
        },
      );
      expect(store.primaryViewport(WS)?.focusedPaneIds).toEqual({
        "tab-1": "pane-1",
      });
    });

    it("stands in for the primary only when a window reported it", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();

      store.reportViewport(
        WS,
        { kind: "bridge", id: "phone" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-diff" },
        },
      );
      expect(store.primaryViewport(WS)).toBeNull();

      store.reportViewport(
        WS,
        { kind: "window", id: "window-1" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-1" },
        },
      );
      expect(store.primaryViewport(WS)?.focusedPaneIds).toEqual({
        "tab-1": "pane-1",
      });
    });
  });

  describe("claims (D4)", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      broadcasts = [];
    });

    it("records a window's claim and broadcasts it at the same version", () => {
      report("window-2", "tab-1");

      expect(store.claimsFor(WS)).toEqual([
        { windowId: "window-2", tabId: "tab-1" },
      ]);
      expect(broadcasts).toHaveLength(1);
      // Nothing structural happened: the tree and its version are untouched,
      // which is why a renderer's guard compares `(version, claims)`.
      expect(lastBroadcast().version).toBe(0);
      expect(lastBroadcast().layout).toBe(store.get(WS)!.layout);
      expect(lastBroadcast().claims).toEqual([
        { windowId: "window-2", tabId: "tab-1" },
      ]);
    });

    it("repeats itself silently — a report per keystroke is normal", () => {
      report("window-2", "tab-1");
      report("window-2", "tab-1");

      expect(broadcasts).toHaveLength(1);
    });

    it("keeps a claiming window out of the default viewport", () => {
      report("primary");
      const primaryDefault = store.get(WS)!.defaultViewport;

      store.reportViewport(
        WS,
        { kind: "window", id: "window-2" },
        {
          activePanelId: "panel-1",
          selectedTabIds: { "panel-1": "tab-1" },
          focusedPaneIds: { "tab-1": "pane-diff" },
          claim: "tab-1",
        },
      );

      // A workspace of one tab is exactly what the next renderer must not be
      // handed, so a claiming report leaves the default alone.
      expect(store.get(WS)!.defaultViewport).toEqual(primaryDefault);
      expect(store.primaryViewport(WS)).toEqual(primaryDefault);
    });

    it("ignores a claim from a bridge socket", () => {
      store.reportViewport(
        WS,
        { kind: "bridge", id: "phone" },
        {
          activePanelId: "panel-1",
          selectedTabIds: {},
          focusedPaneIds: {},
          claim: "tab-1",
        },
      );

      expect(store.claimsFor(WS)).toEqual([]);
      expect(broadcasts).toHaveLength(0);
    });

    it("releases a claim when the window reports without one", () => {
      report("window-2", "tab-1");
      broadcasts = [];

      report("window-2");

      expect(store.claimsFor(WS)).toEqual([]);
      expect(lastBroadcast().claims).toEqual([]);
    });

    it("releases a claim when the window dies", () => {
      report("window-2", "tab-1");
      broadcasts = [];

      store.releaseWindow("window-2");

      expect(store.claimsFor(WS)).toEqual([]);
      expect(lastBroadcast().claims).toEqual([]);
      // A window that never claimed anything says nothing on the way out.
      broadcasts = [];
      store.releaseWindow("window-3");
      expect(broadcasts).toHaveLength(0);
    });

    it("gives the tab to the second window that claims it", () => {
      report("window-2", "tab-1");
      report("window-3", "tab-1");

      expect(store.claimsFor(WS)).toEqual([
        { windowId: "window-3", tabId: "tab-1" },
      ]);
      // The loser hears about it on a broadcast that no longer names it, and
      // closes itself — today's behaviour when a tab is torn off twice.
      expect(lastBroadcast().claims).toEqual([
        { windowId: "window-3", tabId: "tab-1" },
      ]);
    });

    it("drops a claim on a tab that leaves the tree", async () => {
      report("window-2", "tab-1");
      broadcasts = [];

      await store.apply(
        WS,
        { type: "close-tab", tabId: "tab-1" },
        { kind: "window", id: "primary" },
      );

      expect(store.claimsFor(WS)).toEqual([]);
      expect(lastBroadcast().claims).toEqual([]);
      expect(lastBroadcast().version).toBe(1);
    });

    it("keeps a claim on a tab that does not exist yet", async () => {
      // "Move pane to new window" claims the tab its command is about to
      // create, and the window reports before or after the tree catches up.
      report("window-2", "tab-later");
      await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "primary" },
      );

      expect(store.claimsFor(WS)).toEqual([
        { windowId: "window-2", tabId: "tab-later" },
      ]);
    });

    it("rides on every structural broadcast", async () => {
      report("window-2", "tab-1");
      await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "window", id: "primary" },
      );

      expect(lastBroadcast().claims).toEqual([
        { windowId: "window-2", tabId: "tab-1" },
      ]);
      expect(store.get(WS)!.claims).toEqual([
        { windowId: "window-2", tabId: "tab-1" },
      ]);
    });

    it("forgets the claims of a workspace that is going away", () => {
      report("window-2", "tab-1");
      store.remove(WS);

      expect(store.claimsFor(WS)).toEqual([]);
    });
  });

  describe("remove", () => {
    it("ends the pending kills of a workspace that is going away", async () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      await store.apply(
        WS,
        { type: "close-pane", paneId: "pane-1" },
        { kind: "window", id: "1" },
      );
      expect(kill).not.toHaveBeenCalled();

      // A removed worktree is a directory about to be deleted; a shell left
      // warm inside it for ten seconds is an orphan (ticket 10's report).
      store.remove(WS);

      expect(kill).toHaveBeenCalledWith("pane-1");
      expect(store.get(WS)).toBeNull();
    });

    it("leaves another workspace's pending kills alone", async () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      await store.apply(
        "/project/other",
        { type: "new-tab", tab: leafTab("tab-o", "pane-o") },
        { kind: "window", id: "1" },
      );
      await store.apply(
        "/project/other",
        { type: "close-pane", paneId: "pane-o" },
        { kind: "window", id: "1" },
      );

      store.remove(WS);

      expect(kill).not.toHaveBeenCalled();
    });

    /**
     * Without this a popout whose worktree was just deleted never hears its
     * claim is gone: `remove` used to leave silently, so `checkOwnClaim`
     * never sees a broadcast to react to and the window sits on a splash
     * (ticket 6's report).
     */
    it("broadcasts the dropped claim so a popout on the removed workspace closes", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      report("popout-1", "tab-1");
      const versionBefore = store.get(WS)!.version;
      broadcasts.length = 0;

      store.remove(WS);

      expect(broadcasts).toHaveLength(1);
      expect(lastBroadcast()).toMatchObject({
        workspacePath: WS,
        version: versionBefore,
        claims: [],
      });
    });

    it("broadcasts nothing when nobody held a claim on the removed workspace", () => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
      broadcasts.length = 0;

      store.remove(WS);

      expect(broadcasts).toEqual([]);
    });
  });

  describe("the broadcast", () => {
    beforeEach(() => {
      fs.writeFileSync(layoutFile, JSON.stringify(v2File(), null, 2));
      store.load();
    });

    it("carries the sender's origin and the command's selection hint", async () => {
      await store.apply(
        WS,
        { type: "new-tab", tab: leafTab("tab-2", "pane-2") },
        { kind: "bridge", id: "phone-7" },
      );

      const sent = lastBroadcast();
      expect(sent.origin).toEqual({ kind: "bridge", id: "phone-7" });
      expect(sent.hint).toEqual({
        selectTab: { panelId: "panel-1", tabId: "tab-2" },
        focusPane: { tabId: "tab-2", paneId: "pane-2" },
      });
    });

    it("omits the hint for a command that implies no selection", async () => {
      await store.apply(
        WS,
        { type: "update-split-ratio", firstPaneId: "pane-1", ratio: 0.7 },
        { kind: "window", id: "1" },
      );

      expect(lastBroadcast().hint).toBeUndefined();
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
      expect(entry.defaultViewport.activePanelId).toBe(panelIds[0]);
      expect(entry.version).toBe(0);
      expect(store.ensure("/project/unseen").layout).toBe(entry.layout);
    });
  });
});
