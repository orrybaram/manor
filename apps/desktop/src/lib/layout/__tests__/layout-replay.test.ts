import { describe, expect, it } from "vitest";
import { applyLayoutCommand, type LayoutCommand } from "../commands";
import {
  bindPanelId,
  currentOrder,
  layoutReplay,
  mapUnderRoot,
  TARGET_FIRST_PANEL,
  type LayoutReplayInput,
} from "../layout-replay";
import { allPaneIds, type PaneNode } from "../pane-tree";
import type { PanelNode } from "../panel-tree";
import type { PersistedPaneSession } from "../protocol";
import {
  createSinglePanelLayout,
  layoutPaneIds,
  type Tab,
  type WorkspaceLayout,
} from "../workspace-layout";

const SRC = "/Users/me/.manor/worktrees/app/feat";
const DST = "/home/u/.manor/worktrees/app/feat";

const leaf = (paneId: string, extra: Partial<Extract<PaneNode, { type: "leaf" }>> = {}): PaneNode => ({
  type: "leaf",
  paneId,
  ...extra,
});
const tab = (id: string, title: string, rootNode: PaneNode): Tab => ({ id, title, rootNode });
const session = (lastCwd: string | null): PersistedPaneSession => ({
  daemonSessionId: "x",
  lastCwd,
  lastTitle: null,
});

/** Left: two tabs (one pinned, one a vertical split of a terminal and a file
 *  pane). Right, split horizontally 0.3/0.7 from the left, then the right
 *  split vertically 0.6: a browser tab on top, a terminal below. */
function sourceLayout(): WorkspaceLayout {
  const panelTree: PanelNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.3,
    first: { type: "leaf", panelId: "L" },
    second: {
      type: "split",
      direction: "vertical",
      ratio: 0.6,
      first: { type: "leaf", panelId: "RT" },
      second: { type: "leaf", panelId: "RB" },
    },
  };
  return {
    panelTree,
    panels: {
      L: {
        id: "L",
        tabs: [
          tab("t-pinned", "server", leaf("p-server")),
          tab("t-split", "work", {
            type: "split",
            direction: "vertical",
            ratio: 0.25,
            first: leaf("p-shell"),
            second: leaf("p-file", { contentType: "file", filePath: "src/app.ts" }),
          }),
        ],
        pinnedTabIds: ["t-pinned"],
      },
      RT: {
        id: "RT",
        tabs: [tab("t-web", "localhost:3000", leaf("p-web", { contentType: "browser", url: "http://localhost:3000/" }))],
        pinnedTabIds: [],
      },
      RB: { id: "RB", tabs: [tab("t-logs", "logs", leaf("p-logs"))], pinnedTabIds: [] },
    },
  };
}

const sessions: Record<string, PersistedPaneSession> = {
  "p-server": session(SRC),
  "p-shell": session(`${SRC}/packages/api`),
  "p-logs": session("/var/log"),
};

/** Run the replay's commands through the reducer, as the server would. */
function apply(commands: LayoutCommand[], target: WorkspaceLayout | null): WorkspaceLayout {
  // The server mints the first panel of a workspace it has never heard of.
  let layout = target ?? createSinglePanelLayout("panel-minted", [], []);
  for (const [i, raw] of commands.entries()) {
    // Bound as the caller binds it, once the first command made the panel.
    const command = bindPanelId(raw, TARGET_FIRST_PANEL, "panel-minted");
    const next = applyLayoutCommand({ layout, closedStack: [] }, command);
    // A reorder that finds the order right already is the one no-op allowed.
    if (command.type !== "reorder-tabs") {
      expect(next.layout, `command ${i} (${command.type}) changed nothing`).not.toBe(layout);
    }
    layout = next.layout;
  }
  return layout;
}

/** A layout without its ids: what a user would see. */
function shape(layout: WorkspaceLayout): unknown {
  const pane = (node: PaneNode): unknown =>
    node.type === "leaf"
      ? { ...node, paneId: undefined }
      : { direction: node.direction, ratio: node.ratio, first: pane(node.first), second: pane(node.second) };
  const panel = (node: PanelNode): unknown => {
    if (node.type === "split") {
      return { direction: node.direction, ratio: node.ratio, first: panel(node.first), second: panel(node.second) };
    }
    const p = layout.panels[node.panelId];
    return p.tabs.map((t) => ({
      title: t.title,
      pinned: p.pinnedTabIds.includes(t.id),
      root: pane(t.rootNode),
    }));
  };
  return panel(layout.panelTree);
}

function input(target: LayoutReplayInput["target"]): LayoutReplayInput {
  return { source: sourceLayout(), paneSessions: sessions, sourceRoot: SRC, targetRoot: DST, target };
}

describe("layoutReplay", () => {
  it("rebuilds the panels, splits, ratios, tabs, pins, file and browser panes in a target with no layout", () => {
    const replay = layoutReplay(input(null));
    expect(replay.commands[0]).toMatchObject({ type: "new-tab" });
    expect(replay.commands[0]).not.toHaveProperty("panelId");
    expect(shape(apply(replay.commands, null))).toEqual(shape(sourceLayout()));
  });

  it("mints every pane, tab and panel id fresh, and maps each source pane to its new one", () => {
    const replay = layoutReplay(input(null));
    const built = apply(replay.commands, null);
    const source = sourceLayout();
    const oldIds = [
      ...layoutPaneIds(source),
      ...Object.keys(source.panels),
      ...Object.values(source.panels).flatMap((p) => p.tabs.map((t) => t.id)),
    ];
    const newIds = [
      ...layoutPaneIds(built),
      ...Object.keys(built.panels),
      ...Object.values(built.panels).flatMap((p) => p.tabs.map((t) => t.id)),
    ];
    for (const id of oldIds) expect(newIds).not.toContain(id);
    expect(Object.keys(replay.paneIds).sort()).toEqual([...layoutPaneIds(source)].sort());
    expect(new Set(Object.values(replay.paneIds))).toEqual(layoutPaneIds(built));
  });

  it("maps a terminal's cwd under the source root to the target root, and leaves the root and outside paths to the default", () => {
    const { paneIds, cwds } = layoutReplay(input(null));
    expect(cwds).toEqual({ [paneIds["p-shell"]]: `${DST}/packages/api` });
  });

  it("keeps the target's tabs (a running Setup tab) and puts the replay after them", () => {
    const setup = createSinglePanelLayout("T", [tab("t-setup", "Setup", leaf("p-setup"))], []);
    const replay = layoutReplay(input({ layout: setup, paneSessions: { "p-setup": session(DST) } }));
    const built = apply(replay.commands, setup);
    const first = built.panels.T;
    expect(first.tabs.map((t) => t.title)).toEqual(["server", "Setup", "work"]);
    expect(first.pinnedTabIds).toEqual([first.tabs[0].id]);
    expect(Object.keys(built.panels)).toHaveLength(3);
  });

  it("replaces a lone default tab that never started", () => {
    const fresh = createSinglePanelLayout("T", [tab("t-default", "Terminal", leaf("p-default"))], []);
    const replay = layoutReplay(input({ layout: fresh, paneSessions: {} }));
    expect(shape(apply(replay.commands, fresh))).toEqual(shape(sourceLayout()));
  });

  it("keeps a default-looking tab whose shell has started", () => {
    const used = createSinglePanelLayout("T", [tab("t-default", "Terminal", leaf("p-default"))], []);
    const replay = layoutReplay(input({ layout: used, paneSessions: { "p-default": session(DST) } }));
    const built = apply(replay.commands, used);
    expect(built.panels.T.tabs.map((t) => t.title)).toEqual(["server", "Terminal", "work"]);
  });

  it("moves an absolute file path under the source root", () => {
    const source = createSinglePanelLayout(
      "L",
      [tab("t", "f", leaf("p", { contentType: "file", filePath: `${SRC}/README.md` }))],
      [],
    );
    const replay = layoutReplay({ source, paneSessions: {}, sourceRoot: SRC, targetRoot: DST, target: null });
    const built = apply(replay.commands, null);
    const root = Object.values(built.panels)[0].tabs[0].rootNode;
    expect(root).toMatchObject({ contentType: "file", filePath: `${DST}/README.md` });
  });

  describe("held tabs", () => {
    const replayAll = (held: string[], target: WorkspaceLayout | null = null) => {
      const replay = layoutReplay({
        ...input(target && { layout: target, paneSessions: {} }),
        heldPaneIds: new Set(held),
      });
      const restored = apply(replay.commands, target);
      return { replay, restored, built: apply(replay.heldCommands, restored) };
    };

    it("leaves a held pane's tab out of the restore, then puts it back in its place", () => {
      const { replay, restored, built } = replayAll(["p-file"]);
      expect(layoutPaneIds(restored).has(replay.paneIds["p-file"])).toBe(false);
      expect(layoutPaneIds(restored).has(replay.paneIds["p-server"])).toBe(true);
      expect(shape(built)).toEqual(shape(sourceLayout()));
      expect(replay.heldCommands.filter((c) => c.type === "new-tab")).toHaveLength(1);
    });

    it("puts a held pinned tab back pinned, ahead of the rest", () => {
      const { built } = replayAll(["p-server"]);
      expect(shape(built)).toEqual(shape(sourceLayout()));
    });

    it("opens a panel holding only held tabs with a placeholder the held batch closes", () => {
      const { replay, restored, built } = replayAll(["p-web", "p-server", "p-shell"]);
      const titles = Object.values(restored.panels).map((p) => p.tabs.map((t) => t.title));
      expect(titles).toEqual([["Terminal"], ["Terminal"], ["logs"]]);
      expect(shape(built)).toEqual(shape(sourceLayout()));
      expect(replay.heldCommands.filter((c) => c.type === "close-tab")).toHaveLength(2);
    });

    it("gives a held pane no cwd", () => {
      const { replay } = replayAll(["p-shell"]);
      expect(replay.cwds).toEqual({});
    });

    it("replaces the target's default tab once the first panel has a tab, held or not", () => {
      const fresh = createSinglePanelLayout("T", [tab("t-default", "Terminal", leaf("p-default"))], []);
      const { restored, built } = replayAll(["p-server", "p-shell"], fresh);
      expect(restored.panels.T.tabs.map((t) => t.title)).toEqual(["Terminal"]);
      expect(shape(built)).toEqual(shape(sourceLayout()));
    });

    it("keeps the target's tabs ahead of a held tab put back", () => {
      const setup = createSinglePanelLayout("T", [tab("t-setup", "Setup", leaf("p-setup"))], []);
      const { built } = replayAll(["p-shell"], setup);
      expect(built.panels.T.tabs.map((t) => t.title)).toEqual(["server", "Setup", "work"]);
    });
  });

  it("keeps the source's pin order when a held tab sits between pinned ones", () => {
    const source = createSinglePanelLayout(
      "L",
      [tab("a", "a", leaf("pa")), tab("b", "b", leaf("pb")), tab("c", "c", leaf("pc")), tab("d", "d", leaf("pd"))],
      ["a", "b", "c"],
    );
    const replay = layoutReplay({
      source,
      paneSessions: {},
      sourceRoot: SRC,
      targetRoot: DST,
      target: null,
      heldPaneIds: new Set(["pb"]),
    });
    const built = apply(replay.heldCommands, apply(replay.commands, null));
    const panel = Object.values(built.panels)[0];
    const titleOf = (id: string) => panel.tabs.find((t) => t.id === id)!.title;
    expect(panel.tabs.map((t) => t.title)).toEqual(["a", "b", "c", "d"]);
    expect(panel.pinnedTabIds.map(titleOf)).toEqual(["a", "b", "c"]);
  });

  describe("again, after a failure", () => {
    it("builds on what the last replay left, making nothing twice", () => {
      const first = layoutReplay({ ...input(null), heldPaneIds: new Set(["p-web"]) });
      // The restore landed; the held batch never ran.
      const partial = apply(first.commands, null);
      const record = {
        tabIds: first.record.tabIds,
        panelIds: Object.fromEntries(
          Object.entries(first.record.panelIds).map(([k, v]) => [k, v === TARGET_FIRST_PANEL ? "panel-minted" : v]),
        ),
        placeholderTabIds: first.placeholderTabIds,
      };
      expect(first.placeholderTabIds).toHaveLength(1);
      const again = layoutReplay({
        ...input({ layout: partial, paneSessions: {} }),
        heldPaneIds: new Set(["p-web"]),
        previous: record,
      });
      expect(again.commands).toEqual([]);
      const built = apply(again.heldCommands, partial);
      // The placeholder the first run opened for the web panel is closed now.
      expect(shape(built)).toEqual(shape(sourceLayout()));
    });

    it("makes again what the target lost since", () => {
      const first = layoutReplay(input(null));
      const built = apply(first.commands, null);
      const logs = Object.values(built.panels).find((p) => p.tabs.some((t) => t.title === "logs"))!;
      const without = apply(
        [{ type: "close-tab", tabId: logs.tabs[0].id }],
        built,
      );
      const record = {
        tabIds: first.record.tabIds,
        panelIds: Object.fromEntries(
          Object.entries(first.record.panelIds).map(([k, v]) => [k, v === TARGET_FIRST_PANEL ? "panel-minted" : v]),
        ),
      };
      const again = layoutReplay({ ...input({ layout: without, paneSessions: {} }), previous: record });
      expect(shape(apply(again.commands, without))).toEqual(shape(sourceLayout()));
    });
  });

  it("counts a target tab of the same title and shape as the source's, with no record", () => {
    const built = apply(layoutReplay(input(null)).commands, null);
    const again = layoutReplay(input({ layout: built, paneSessions: {} }));
    expect(again.commands).toEqual([]);
    expect(again.heldCommands).toEqual([]);
  });

  it("does not count a tab whose title or panes differ", () => {
    const own = createSinglePanelLayout(
      "T",
      [tab("o1", "server", leaf("x", { contentType: "browser", url: "http://a/" })), tab("o2", "logs", leaf("y"))],
      [],
    );
    const replay = layoutReplay(input({ layout: own, paneSessions: { y: session(DST) } }));
    const built = apply(replay.commands, own);
    const titles = Object.values(built.panels).flatMap((p) => p.tabs.map((t) => t.title));
    // "logs" is counted as the source's; "server" is a browser here, not a terminal.
    expect(titles.filter((t) => t === "logs")).toHaveLength(1);
    expect(titles.filter((t) => t === "server")).toHaveLength(2);
    // The panel "logs" had needs opening for nothing: no placeholder is left.
    expect(titles).not.toContain("Terminal");
  });

  describe("currentOrder", () => {
    const layout = createSinglePanelLayout(
      "P",
      [tab("a", "a", leaf("1")), tab("x", "x", leaf("2")), tab("b", "b", leaf("3"))],
      ["b"],
    );
    it("orders the tabs the panel has, extras after, pins first", () => {
      expect(currentOrder(layout, "P", ["gone", "a", "b"])).toEqual(["b", "a", "x"]);
    });
    it("is null when the order is right already, or the panel is gone", () => {
      expect(currentOrder(layout, "Q", ["a"])).toBeNull();
      const right = createSinglePanelLayout("P", [tab("a", "a", leaf("1"))], []);
      expect(currentOrder(right, "P", ["a"])).toBeNull();
    });
  });

  it("answers nothing for a layout with no tabs", () => {
    const empty = createSinglePanelLayout("L", [], []);
    expect(
      layoutReplay({ source: empty, paneSessions: {}, sourceRoot: SRC, targetRoot: DST, target: null }).commands,
    ).toEqual([]);
  });

  it("drops a source panel that holds no tab", () => {
    const source = sourceLayout();
    source.panels.RB = { ...source.panels.RB, tabs: [] };
    const built = apply(layoutReplay({ ...input(null), source }).commands, null);
    expect(allPaneIds(Object.values(built.panels)[0].tabs[0].rootNode)).toHaveLength(1);
    expect(Object.keys(built.panels)).toHaveLength(2);
  });
});

describe("mapUnderRoot", () => {
  it("maps the root, a path under it, and nothing else", () => {
    expect(mapUnderRoot(SRC, SRC, DST)).toBe(DST);
    expect(mapUnderRoot(`${SRC}/a/b`, `${SRC}/`, DST)).toBe(`${DST}/a/b`);
    expect(mapUnderRoot(`${SRC}-other`, SRC, DST)).toBeNull();
    expect(mapUnderRoot("C:\\src\\app\\lib", "C:\\src\\app", DST)).toBe(`${DST}/lib`);
  });
});
