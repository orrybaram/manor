/**
 * A window that holds a tab, and what happens when it stops holding it
 * (ADR-179 D4).
 *
 * The claim arrives on the launch argument, so it is read once at import
 * time — which is why this file imports a *fresh* `app-store` with
 * `window.electronAPI.claim` set, instead of poking at the one every other
 * store test shares.
 *
 * The behaviour under test is the ADR's named risk: "a claim that outlives its
 * window is a tab nobody can see". The window is the one that has to notice,
 * and the only thing it has to go on is a `layout.changed` whose `claims` no
 * longer name it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FAKE_RENDERER_ID,
  broadcastLayout,
  clearLayoutListeners,
  layoutServer,
  reportedViewports,
  resetFakeLayoutServer,
  seedLayout,
  settled,
} from "./fake-layout-server";
import type { Tab, WorkspaceLayout } from "../app-store";

const WS_PATH = "/test/workspace";
const CLAIMED = "tab-2";

function tab(id: string, paneId: string): Tab {
  return { id, title: id, rootNode: { type: "leaf", paneId } };
}

function layout(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [tab("tab-1", "pane-1"), tab(CLAIMED, "pane-2")],
        pinnedTabIds: [],
      },
    },
  };
}

const api = (): Record<string, unknown> =>
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;

/**
 * A store that booted as a detached window holding {@link CLAIMED}.
 *
 * `resetModules` is what makes the claim take: the store reads it once, at
 * import time, exactly as a real detached renderer does.
 */
async function claimingStore(closeSelf: () => void) {
  // The module this replaces would otherwise go on answering broadcasts.
  clearLayoutListeners();
  vi.resetModules();
  api().claim = { workspacePath: WS_PATH, tabId: CLAIMED };
  api().window = { closeSelf };
  const fresh = await import("../app-store");
  fresh.useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout() },
    layoutVersions: {},
    claims: {},
    viewports: {},
  });
  return fresh;
}

/** A broadcast at `version` saying who holds {@link CLAIMED}. */
function claimsBroadcast(
  version: number,
  holder: string | null,
  tabs = layout(),
): void {
  broadcastLayout(WS_PATH, tabs, version, undefined, {
    claims: holder ? [{ windowId: holder, tabId: CLAIMED }] : [],
  });
}

describe("a window that holds a claim", () => {
  beforeEach(() => {
    resetFakeLayoutServer();
    seedLayout(WS_PATH, layout());
    api().claim = null;
  });

  it("shows its one tab, and leaves the claim itself to main", async () => {
    const fresh = await claimingStore(vi.fn());
    claimsBroadcast(1, null);
    await settled();

    // Main knows the claim from the launch argument; the report is only what
    // makes it take effect (ADR-182 D9), so nothing in it names the tab.
    expect(reportedViewports.length).toBeGreaterThan(0);
    for (const { viewport } of reportedViewports) {
      expect(viewport).not.toHaveProperty("claim");
    }
    expect(layoutServer().claimsFor(WS_PATH)).toEqual([
      { windowId: FAKE_RENDERER_ID, tabId: CLAIMED },
    ]);
    // And it shows that tab, not the panel's first one.
    expect(
      fresh.selectSelectedTabId(fresh.useAppStore.getState(), "panel-1"),
    ).toBe(CLAIMED);
  });

  it("waits for its first claim rather than closing on the boot broadcast", async () => {
    const closeSelf = vi.fn();
    await claimingStore(closeSelf);

    // The broadcast that arrives before this window's report has nobody
    // holding the tab — which is not the same as having lost it.
    claimsBroadcast(1, null);

    expect(closeSelf).not.toHaveBeenCalled();
  });

  it("closes itself when another window takes the tab", async () => {
    const closeSelf = vi.fn();
    await claimingStore(closeSelf);

    claimsBroadcast(1, FAKE_RENDERER_ID);
    expect(closeSelf).not.toHaveBeenCalled();

    // Claims are exclusive and the newcomer wins (D4).
    claimsBroadcast(2, "another-window");

    expect(closeSelf).toHaveBeenCalled();
  });

  it("closes itself when the tab it holds is closed elsewhere", async () => {
    const closeSelf = vi.fn();
    await claimingStore(closeSelf);
    claimsBroadcast(1, FAKE_RENDERER_ID);

    const withoutClaimed: WorkspaceLayout = {
      panelTree: { type: "leaf", panelId: "panel-1" },
      panels: {
        "panel-1": {
          id: "panel-1",
          tabs: [tab("tab-1", "pane-1")],
          pinnedTabIds: [],
        },
      },
    };
    claimsBroadcast(2, null, withoutClaimed);

    expect(closeSelf).toHaveBeenCalled();
  });
});
