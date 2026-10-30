import { describe, expect, it } from "vitest";
import { workspaceRecreator, type HostLayout } from "./workspace-recreator";
import type { RecreateContext } from "./workspace-host-move";
import { applyLayoutCommand, type LayoutCommand } from "../../src/lib/layout/commands";
import type { LayoutEntry, PersistedPaneSession } from "../../src/lib/layout/protocol";
import {
  createSinglePanelLayout,
  layoutPaneIds,
  type Tab,
  type WorkspaceLayout,
} from "../../src/lib/layout/workspace-layout";
import { workspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";

const SRC = "/Users/me/.manor/worktrees/app/feat";
const DST = "/home/u/.manor/worktrees/app/feat";
const SOURCE_KEY = workspaceKey("local", SRC);
const TARGET_KEY = workspaceKey("box", DST);

const MOVE: RecreateContext = {
  sourceProjectId: "src",
  sourceHostId: "local",
  sourcePath: SRC,
  sourceKey: SOURCE_KEY,
  targetProjectId: "dst",
  targetHostId: "box",
  targetPath: DST,
  targetKey: TARGET_KEY,
  branch: "feat",
};

interface Queued {
  paneId: string;
  text: string;
  kind: string;
  opts?: unknown;
}

/** One host's layout store: the reducer over its entries, and its pending queue. */
function fakeHost(entries: Record<string, LayoutEntry> = {}) {
  const queued: Queued[] = [];
  const applied: LayoutCommand[] = [];
  const layout: HostLayout = {
    async read(key) {
      return entries[key] ?? null;
    },
    async apply(key, command) {
      applied.push(command);
      const entry =
        entries[key] ??
        (entries[key] = {
          version: 0,
          layout: createSinglePanelLayout("panel-minted", [], []),
          defaultViewport: { activePanelId: "panel-minted", selectedTabIds: {}, focusedPaneIds: {} },
          paneSessions: {},
          claims: [],
        });
      const before = layoutPaneIds(entry.layout);
      entry.layout = applyLayoutCommand({ layout: entry.layout, closedStack: [] }, command).layout;
      entry.version += 1;
      return { version: entry.version, addedPaneIds: [...layoutPaneIds(entry.layout)].filter((p) => !before.has(p)) };
    },
    async queue(paneId, text, kind, opts) {
      queued.push({ paneId, text, kind, ...(opts ? { opts } : {}) });
    },
  };
  return { layout, entries, queued, applied };
}

function entry(layout: WorkspaceLayout, paneSessions: Record<string, PersistedPaneSession> = {}): LayoutEntry {
  return {
    version: 1,
    layout,
    defaultViewport: { activePanelId: Object.keys(layout.panels)[0], selectedTabIds: {}, focusedPaneIds: {} },
    paneSessions,
    claims: [],
  };
}

const tab = (id: string, title: string, paneId: string): Tab => ({
  id,
  title,
  rootNode: { type: "leaf", paneId },
});

function sourceEntry(): LayoutEntry {
  return entry(
    {
      panelTree: {
        type: "split",
        direction: "horizontal",
        ratio: 0.4,
        first: { type: "leaf", panelId: "A" },
        second: { type: "leaf", panelId: "B" },
      },
      panels: {
        A: { id: "A", tabs: [tab("t1", "api", "p1"), tab("t2", "web", "p2")], pinnedTabIds: [] },
        B: { id: "B", tabs: [tab("t3", "logs", "p3")], pinnedTabIds: [] },
      },
    },
    { p1: { daemonSessionId: "p1", lastCwd: `${SRC}/api server`, lastTitle: null } },
  );
}

function hosts(source: ReturnType<typeof fakeHost>, target: ReturnType<typeof fakeHost>) {
  return {
    layout: (hostId: string) => (hostId === "local" ? source.layout : target.layout),
  };
}

const planOf = (key: WorkspaceKey) => ({ projectId: "src", hostId: "local", path: SRC, key });

describe("workspaceRecreator: restore", () => {
  it("plans a restore for a source with tabs, and nothing for one without", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const recreator = workspaceRecreator(hosts(source, fakeHost()));
    expect(await recreator.plan(planOf(SOURCE_KEY))).toEqual([{ id: "restore" }]);

    const empty = fakeHost({ [SOURCE_KEY]: entry(createSinglePanelLayout("A", [], [])) });
    expect(await workspaceRecreator(hosts(empty, fakeHost())).plan(planOf(SOURCE_KEY))).toEqual([]);
    expect(await workspaceRecreator(hosts(fakeHost(), fakeHost())).plan(planOf(SOURCE_KEY))).toEqual([]);
  });

  it("rebuilds the layout in a target with none, binding the panel the server makes", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    const begun: number[] = [];
    await workspaceRecreator(hosts(source, target)).run(MOVE, (i) => begun.push(i));

    expect(begun).toEqual([0]);
    const built = target.entries[TARGET_KEY].layout;
    expect(built.panelTree).toMatchObject({ type: "split", direction: "horizontal", ratio: 0.4 });
    const panels = Object.values(built.panels).map((p) => p.tabs.map((t) => t.title));
    expect(panels).toEqual([["api", "web"], ["logs"]]);
    expect(built.panels["panel-minted"]).toBeDefined();
    // The source is read, never written.
    expect(source.applied).toEqual([]);
  });

  it("queues a cd to each moved cwd, quoted, before the tab exists", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    await workspaceRecreator(hosts(source, target)).run(MOVE, () => {});
    expect(target.queued).toEqual([
      { paneId: expect.any(String), text: `cd '${DST}/api server'`, kind: "shell" },
    ]);
    const api = Object.values(target.entries[TARGET_KEY].layout.panels)
      .flatMap((p) => p.tabs)
      .find((t) => t.title === "api")!;
    expect(api.rootNode).toMatchObject({ paneId: target.queued[0].paneId });
  });

  it("fails the step when the target refuses a command", async () => {
    const source = fakeHost({ [SOURCE_KEY]: sourceEntry() });
    const target = fakeHost();
    target.layout.apply = async () => ({ error: "Workspace was removed" });
    await expect(workspaceRecreator(hosts(source, target)).run(MOVE, () => {})).rejects.toThrow(
      /Workspace was removed/,
    );
  });
});
