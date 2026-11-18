// @vitest-environment happy-dom
/**
 * A detached window holds several tabs: whatever the server's claims name it
 * holder of, and every tab it makes, which it claims before sending the
 * command so the tab never shows in the primary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab, WorkspaceLayout } from "../app-store";
import { workspaceKey } from "../../lib/workspace-key";

const WS = workspaceKey("local", "/ws");

function tab(id: string): Tab {
  return { id, title: id, rootNode: { type: "leaf", paneId: `pane-${id}` } };
}

function layout(...tabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: { p1: { id: "p1", pinnedTabIds: [], tabs } },
  };
}

type AppStoreModule = typeof import("../app-store");

const win = window as unknown as { electronAPI?: Record<string, unknown> };
let before: Record<string, unknown> | undefined;
/** Calls on the layout bridge, in the order they were made. */
let calls: string[];

/** A fresh store in a window opened holding `t1`, renderer id `me`. */
async function detachedStore(): Promise<AppStoreModule> {
  vi.resetModules();
  win.electronAPI = {
    ...before,
    rendererId: "me",
    platform: "electron",
    claim: { workspacePath: WS, tabId: "t1" },
    layout: {
      claimTab: vi.fn(async (_ws: string, tabId: string) => {
        calls.push(`claim ${tabId}`);
        return true;
      }),
      apply: vi.fn(async (_ws: string, command: { type: string; tab?: Tab }) => {
        calls.push(`apply ${command.type} ${command.tab?.id ?? ""}`.trim());
        return { version: 1 };
      }),
    },
  };
  const app = await import("../app-store");
  app.useAppStore.setState({
    workspaceLayouts: { [WS]: layout(tab("t0"), tab("t1"), tab("t2")) },
    viewports: {},
    claims: {},
    activeWorkspacePath: "/ws",
    activeWorkspaceHostId: "local",
  });
  return app;
}

beforeEach(() => {
  before = win.electronAPI;
  calls = [];
});

afterEach(() => {
  win.electronAPI = before;
});

describe("a detached window's tabs", () => {
  it("are the launch tab until the claims name the window", async () => {
    const app = await detachedStore();

    expect(app.selectOwnTabs(app.useAppStore.getState()).map((t) => t.id)).toEqual(["t1"]);
  });

  it("are every tab the claims name it holder of", async () => {
    const app = await detachedStore();
    app.useAppStore.setState({
      claims: {
        [WS]: [
          { windowId: "me", tabId: "t1" },
          { windowId: "me", tabId: "t2" },
          { windowId: "other", tabId: "t0" },
        ],
      },
    });

    const state = app.useAppStore.getState();
    expect(app.selectOwnTabs(state).map((t) => t.id)).toEqual(["t1", "t2"]);
    const panel = state.workspaceLayouts[WS]!.panels.p1;
    expect(app.selectVisibleTabs(state, WS, panel).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(app.selectOwnPanelId(state)).toBe("p1");
  });

  it("claim a new tab before sending the command that makes it", async () => {
    const app = await detachedStore();

    const made = app.useAppStore.getState().addTab();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls).toEqual([`claim ${made!.tabId}`, `apply new-tab ${made!.tabId}`]);
  });

  it("send a command that makes no tab at once, with no claim", async () => {
    const app = await detachedStore();

    app.useAppStore.getState().closeTab("t1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls).toEqual(["apply close-tab"]);
  });
});
