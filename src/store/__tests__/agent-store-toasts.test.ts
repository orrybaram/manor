// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "../agent-store";
import { useAppStore, type WorkspaceLayout } from "../app-store";
import { useToastStore } from "../toast-store";
import { workspaceKey } from "../../lib/workspace-key";
import { makeAgent } from "../../test-utils/fixtures";

/** One panel; the first tab is selected and shows `visible`, the second `hidden`. */
function layout(visible: string, hidden: string): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: {
      p1: {
        id: "p1",
        pinnedTabIds: [],
        tabs: [visible, hidden].map((paneId, i) => ({
          id: `t${i}`,
          title: "Terminal",
          rootNode: { type: "leaf", paneId },
        })),
      },
    },
  };
}

const unseen = { responded: true, requires_input: false };

describe("agent-store toasts", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useAgentStore.setState({ agents: [] });
    useAppStore.setState({
      workspaceLayouts: { [workspaceKey("local", "/ws")]: layout("on-screen", "off-screen") },
      viewports: {},
      claims: {},
      activeWorkspacePath: "/ws",
      activeWorkspaceHostId: "local",
    });
  });

  it("does not toast 'Agent responded' for an agent whose pane is on screen", () => {
    const working = makeAgent({ id: "a1", paneId: "on-screen", lastAgentStatus: "working" });
    useAgentStore.getState().receiveAgentUpdate(working, { responded: false, requires_input: false });
    useAgentStore.getState().receiveAgentUpdate({ ...working, lastAgentStatus: "responded" }, unseen);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("does not toast a responded that main inferred (no unseen flag)", () => {
    const working = makeAgent({ id: "a3", paneId: "off-screen", lastAgentStatus: "working" });
    useAgentStore.getState().receiveAgentUpdate(working, { responded: false, requires_input: false });
    useAgentStore
      .getState()
      .receiveAgentUpdate({ ...working, lastAgentStatus: "responded" }, { responded: false, requires_input: false });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("toasts 'Agent responded' for an agent whose pane is off screen", () => {
    const working = makeAgent({ id: "a2", paneId: "off-screen", lastAgentStatus: "working" });
    useAgentStore.getState().receiveAgentUpdate(working, { responded: false, requires_input: false });
    useAgentStore.getState().receiveAgentUpdate({ ...working, lastAgentStatus: "responded" }, unseen);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["Agent responded"]);
  });
});
