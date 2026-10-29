// @vitest-environment happy-dom
/**
 * What "on screen" means for a toast's subject, answered from the stores:
 * the primary's own selection, every tab a detached window claims, the
 * active workspace, an agent through its pane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../agent-store";
import { useAppStore, type Tab, type WorkspaceLayout } from "../app-store";
import { isSubjectOnScreen, wireToastSubjects } from "../toast-subjects";
import { toast } from "../../toast";
import { toastStore } from "../../toast/toast-store";
import { workspaceKey } from "../../lib/workspace-key";
import { makeAgent } from "../../test-utils/fixtures";

const WS = workspaceKey("local", "/ws");
const OTHER = workspaceKey("local", "/other");

function tab(id: string, paneId: string): Tab {
  return { id, title: id, rootNode: { type: "leaf", paneId } };
}

/** One panel of `tabs`; the first is selected unless a viewport says otherwise. */
function layout(...tabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: { p1: { id: "p1", pinnedTabIds: [], tabs } },
  };
}

function select(tabId: string): void {
  useAppStore.setState({
    viewports: {
      [WS]: { activePanelId: "p1", selectedTabIds: { p1: tabId }, focusedPaneIds: {} },
    },
  });
}

const present = () => toastStore.getState().toasts.filter((t) => !t.leaving);

let unwire: () => void = () => {};

beforeEach(() => {
  toastStore.setState({ toasts: [] });
  useAgentStore.setState({ agents: [] });
  useAppStore.setState({
    workspaceLayouts: {
      [WS]: layout(tab("t0", "shown"), tab("t1", "behind"), tab("t2", "popped")),
      [OTHER]: layout(tab("o0", "other-shown"), tab("o1", "other-popped")),
    },
    viewports: {},
    // Two detached windows: one holds t2 here, one o1 in a workspace the
    // primary is not even looking at.
    claims: {
      [WS]: [{ windowId: "win-2", tabId: "t2" }],
      [OTHER]: [{ windowId: "win-3", tabId: "o1" }],
    },
    activeWorkspacePath: "/ws",
    activeWorkspaceHostId: "local",
  });
  unwire = wireToastSubjects();
});

afterEach(() => unwire());

describe("isSubjectOnScreen", () => {
  it("a pane: the selected tab here, or any tab a detached window claims", () => {
    expect(isSubjectOnScreen({ pane: "shown" })).toBe(true);
    expect(isSubjectOnScreen({ pane: "behind" })).toBe(false);
    expect(isSubjectOnScreen({ pane: "popped" })).toBe(true);
    expect(isSubjectOnScreen({ pane: "other-popped" })).toBe(true);
    // Another workspace's unclaimed tabs are not rendered anywhere.
    expect(isSubjectOnScreen({ pane: "other-shown" })).toBe(false);
  });

  it("an agent: wherever its pane is; nowhere without one", () => {
    useAgentStore.setState({
      agents: [
        makeAgent({ id: "a-shown", paneId: "shown" }),
        makeAgent({ id: "a-behind", paneId: "behind" }),
        makeAgent({ id: "a-popped", paneId: "popped" }),
        makeAgent({ id: "a-none", paneId: null }),
      ],
    });
    expect(isSubjectOnScreen({ agent: "a-shown" })).toBe(true);
    expect(isSubjectOnScreen({ agent: "a-behind" })).toBe(false);
    expect(isSubjectOnScreen({ agent: "a-popped" })).toBe(true);
    expect(isSubjectOnScreen({ agent: "a-none" })).toBe(false);
    expect(isSubjectOnScreen({ agent: "unknown" })).toBe(false);
  });

  it("a workspace: the active one, by key or path; never on Home", () => {
    expect(isSubjectOnScreen({ workspace: WS })).toBe(true);
    expect(isSubjectOnScreen({ workspace: "/ws" })).toBe(true);
    expect(isSubjectOnScreen({ workspace: OTHER })).toBe(false);
    useAppStore.setState({ activeWorkspacePath: null });
    expect(isSubjectOnScreen({ workspace: WS })).toBe(false);
  });
});

describe("toasts about a subject", () => {
  it("never appear while it is on screen", () => {
    toast.info("done", { about: { pane: "shown" } });
    toast.info("done", { about: { pane: "popped" } });
    expect(present()).toEqual([]);
  });

  it("retract when the user selects the tab holding it", () => {
    toast.info("done", { about: { pane: "behind" }, duration: "sticky" });
    expect(present()).toHaveLength(1);
    select("t1");
    expect(present()).toEqual([]);
  });

  it("retract when a detached window claims the tab holding it", () => {
    toast.info("done", { about: { pane: "behind" }, duration: "sticky" });
    useAppStore.setState({
      claims: { [WS]: [{ windowId: "win-2", tabId: "t1" }] },
    });
    expect(present()).toEqual([]);
  });

  it("retract when the workspace becomes the active one", () => {
    toast.info("ready", { about: { workspace: OTHER }, duration: "sticky" });
    useAppStore.setState({ activeWorkspacePath: "/other" });
    expect(present()).toEqual([]);
  });

  it("about an agent retract when its pane appears in the list on screen", () => {
    toast.info("hi", { about: { agent: "late" }, duration: "sticky" });
    expect(present()).toHaveLength(1);
    // The agent row arrives after the toast, already in a visible pane.
    useAgentStore.setState({ agents: [makeAgent({ id: "late", paneId: "shown" })] });
    expect(present()).toEqual([]);
  });

  it("stay when something unrelated in the store changes", () => {
    toast.info("done", { about: { pane: "behind" }, duration: "sticky" });
    useAppStore.setState({ paneTitle: { behind: "vim" } });
    expect(present()).toHaveLength(1);
  });
});

describe("in a detached window", () => {
  it("its own claim is on screen there, and so is every other window's", async () => {
    vi.resetModules();
    // The claim is read once, at import: a fresh store, booted holding t1.
    const win = window as unknown as { electronAPI?: Record<string, unknown> };
    const before = win.electronAPI;
    win.electronAPI = { ...before, claim: { workspacePath: WS, tabId: "t1" } };
    try {
      const app = await import("../app-store");
      app.useAppStore.setState({
        workspaceLayouts: useAppStore.getState().workspaceLayouts,
        viewports: {},
        claims: {
          [WS]: [
            { windowId: "me", tabId: "t1" },
            { windowId: "win-2", tabId: "t2" },
          ],
        },
        activeWorkspacePath: "/ws",
        activeWorkspaceHostId: "local",
      });
      // What `isSubjectOnScreen` asks of a pane (and of an agent's pane).
      const onScreen = app.selectOnScreenPaneIds(app.useAppStore.getState());
      expect(onScreen.has("behind")).toBe(true);
      expect(onScreen.has("popped")).toBe(true);
      // The primary's selection is its own: this window cannot see it.
      expect(onScreen.has("shown")).toBe(false);
    } finally {
      win.electronAPI = before;
    }
  });
});
