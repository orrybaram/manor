// @vitest-environment happy-dom
import { act, createElement, Profiler, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectAgentRollup, type AgentRollupSources } from "../agent-rollup";
import { selectPaneAgentIndex, useAgentStore } from "../agent-store";
import { selectVisiblePaneIds, useAppStore, type WorkspaceLayout } from "../app-store";
import { useWorkspaceAgentStatus } from "../../hooks/useWorkspaceAgentStatus";
import { useTabAgentStatus } from "../../hooks/useTabAgentStatus";
import { workspaceKey } from "../../lib/workspace-key";
import { makeAgent } from "../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../test-utils/react-root";
import type { AgentInfo, AgentStatus, PaneAgentStatus } from "../../electron.d";

function live(status: AgentStatus): PaneAgentStatus {
  return { status, reason: "test", kind: "claude" };
}

/** A layout with one panel holding one tab per pane id; the first is selected. */
function layout(...paneIds: string[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    panels: {
      p1: {
        id: "p1",
        pinnedTabIds: [],
        tabs: paneIds.map((paneId, i) => ({
          id: `t${i}`,
          title: "Terminal",
          rootNode: { type: "leaf", paneId },
        })),
      },
    },
  };
}

function sources(overrides: {
  paneAgentStatus?: Record<string, PaneAgentStatus>;
  agents?: AgentInfo[];
  unseenResponded?: string[];
  unseenInput?: string[];
  /** Panes of an active workspace whose selected tab shows the first one. */
  activeLayout?: string[];
}): AgentRollupSources {
  const active = overrides.activeLayout;
  return {
    app: {
      paneAgentStatus: overrides.paneAgentStatus ?? {},
      workspaceLayouts: active ? { [workspaceKey("local", "/active")]: layout(...active) } : {},
      // No viewport: each panel shows its first tab (ADR-179 D3).
      viewports: {},
      claims: {},
      activeWorkspacePath: active ? "/active" : null,
      activeWorkspaceHostId: "local",
    },
    agents: {
      agents: overrides.agents ?? [],
      unseenRespondedAgentIds: new Set(overrides.unseenResponded),
      unseenInputAgentIds: new Set(overrides.unseenInput),
    },
  };
}

describe("selectAgentRollup", () => {
  it("gives no status and pulse for no panes, or panes with no status", () => {
    expect(selectAgentRollup(sources({}), [])).toEqual({ status: null, pulse: true });
    expect(selectAgentRollup(sources({}), ["p1", "p2"])).toEqual({ status: null, pulse: true });
  });

  it("ignores idle panes", () => {
    const s = sources({ paneAgentStatus: { p1: live("idle") } });
    expect(selectAgentRollup(s, ["p1"]).status).toBeNull();
  });

  it("picks the highest priority status regardless of pane order", () => {
    const s = sources({
      paneAgentStatus: { p1: live("responded"), p2: live("requires_input") },
      agents: [makeAgent({ id: "a1", paneId: "p1" }), makeAgent({ id: "a2", paneId: "p2" })],
    });
    expect(selectAgentRollup(s, ["p1", "p2"]).status).toBe("requires_input");
    expect(selectAgentRollup(s, ["p2", "p1"]).status).toBe("requires_input");
  });

  it("prefers an unseen pane on a priority tie", () => {
    const s = sources({
      paneAgentStatus: { p1: live("responded"), p2: live("responded") },
      agents: [makeAgent({ id: "seen", paneId: "p1" }), makeAgent({ id: "unseen", paneId: "p2" })],
      unseenResponded: ["unseen"],
    });
    expect(selectAgentRollup(s, ["p1", "p2"])).toEqual({ status: "responded", pulse: true });
  });

  it("does not pulse when every winning agent has been seen", () => {
    const s = sources({
      paneAgentStatus: { p1: live("requires_input"), p2: live("requires_input") },
      agents: [makeAgent({ id: "a1", paneId: "p1" }), makeAgent({ id: "a2", paneId: "p2" })],
    });
    expect(selectAgentRollup(s, ["p1", "p2"])).toEqual({ status: "requires_input", pulse: false });
  });

  it("pulses a status with no agent row yet", () => {
    const s = sources({ paneAgentStatus: { p1: live("working") } });
    expect(selectAgentRollup(s, ["p1"])).toEqual({ status: "working", pulse: true });
  });

  it("maps a pane to the newest agent row when history rows share it", () => {
    const s = sources({
      paneAgentStatus: { p1: live("responded") },
      // `agents` is newest first.
      agents: [makeAgent({ id: "new", paneId: "p1" }), makeAgent({ id: "old", paneId: "p1" })],
      unseenResponded: ["old"],
    });
    expect(selectAgentRollup(s, ["p1"]).pulse).toBe(false);
  });

  it("never pulses a pane that is on screen", () => {
    const unseen = {
      paneAgentStatus: { p1: live("responded") },
      agents: [makeAgent({ id: "a1", paneId: "p1" })],
      unseenResponded: ["a1"],
    };
    expect(selectAgentRollup(sources(unseen), ["p1"]).pulse).toBe(true);
    expect(selectAgentRollup(sources({ ...unseen, activeLayout: ["p1"] }), ["p1"])).toEqual({
      status: "responded",
      pulse: false,
    });

    const noRow = sources({ paneAgentStatus: { p1: live("responded") }, activeLayout: ["p1"] });
    expect(selectAgentRollup(noRow, ["p1"]).pulse).toBe(false);
  });

  it("prefers an off-screen unseen pane over an on-screen one on a tie", () => {
    const s = sources({
      paneAgentStatus: { p1: live("responded"), p2: live("responded") },
      agents: [makeAgent({ id: "a1", paneId: "p1" }), makeAgent({ id: "a2", paneId: "p2" })],
      unseenResponded: ["a1", "a2"],
      // p1 is the selected tab, p2 a hidden one.
      activeLayout: ["p1", "p2"],
    });
    expect(selectAgentRollup(s, ["p1", "p2"]).pulse).toBe(true);
  });
});

describe("selectPaneAgentIndex", () => {
  it("builds the pane-to-agent lookup once per agents list", () => {
    const agents = [makeAgent({ id: "a1", paneId: "p1" })];
    const index = selectPaneAgentIndex({ agents });
    expect(index.get("p1")).toBe("a1");
    expect(selectPaneAgentIndex({ agents })).toBe(index);
    expect(selectPaneAgentIndex({ agents: [...agents] })).not.toBe(index);
  });
});

describe("selectVisiblePaneIds", () => {
  it("builds the on-screen set once per layout, viewport and active workspace", () => {
    const keyA = workspaceKey("local", "/a");
    const workspaceLayouts = {
      [keyA]: layout("a1", "a2"),
      [workspaceKey("local", "/b")]: layout("b1"),
    };
    const onA = {
      workspaceLayouts,
      viewports: {},
      activeWorkspacePath: "/a",
      activeWorkspaceHostId: "local",
    };
    const ids = selectVisiblePaneIds(onA);
    expect([...ids]).toEqual(["a1"]);
    expect(selectVisiblePaneIds({ ...onA })).toBe(ids);
    expect([...selectVisiblePaneIds({ ...onA, activeWorkspacePath: "/b" })]).toEqual(["b1"]);
    expect(
      selectVisiblePaneIds({
        ...onA,
        workspaceLayouts: { ...workspaceLayouts, [keyA]: layout("a1", "a2") },
      }),
    ).not.toBe(ids);
    // Selecting another tab is a viewport change, and changes what is on screen.
    expect([
      ...selectVisiblePaneIds({
        ...onA,
        viewports: {
          [keyA]: { activePanelId: "p1", selectedTabIds: { p1: "t1" }, focusedPaneIds: {} },
        },
      }),
    ]).toEqual(["a2"]);
  });
});

describe("useAgentRollup through the status hooks", () => {
  const keyA = workspaceKey("local", "/a");
  const keyB = workspaceKey("local", "/b");
  let root: TestRoot;
  let commits: Record<string, number>;

  function counted(id: string, element: ReactElement): ReactElement {
    return createElement(
      Profiler,
      { id, onRender: () => (commits[id] = (commits[id] ?? 0) + 1) },
      element,
    );
  }

  function WorkspaceDot({ wsKey }: { wsKey: typeof keyA }) {
    const { status, pulse } = useWorkspaceAgentStatus(wsKey);
    return `${status ?? "none"}:${pulse}`;
  }

  function TabDot({ tabId }: { tabId: string }) {
    const { status } = useTabAgentStatus(tabId);
    return status ?? "none";
  }

  function setPaneStatus(paneId: string, status: AgentStatus) {
    act(() =>
      useAppStore.setState((s) => ({
        paneAgentStatus: { ...s.paneAgentStatus, [paneId]: live(status) },
      })),
    );
  }

  beforeEach(() => {
    commits = {};
    useAppStore.setState({
      workspaceLayouts: { [keyA]: layout("a1", "a2"), [keyB]: layout("b1") },
      activeWorkspacePath: "/a",
      activeWorkspaceHostId: "local",
      paneAgentStatus: {},
      paneTitle: {},
    });
    useAgentStore.setState({
      agents: [],
      unseenRespondedAgentIds: new Set(),
      unseenInputAgentIds: new Set(),
    });
    root = createTestRoot();
    root.render(
      createElement(
        "div",
        null,
        counted("A", createElement(WorkspaceDot, { wsKey: keyA })),
        counted("B", createElement(WorkspaceDot, { wsKey: keyB })),
        counted("t0", createElement(TabDot, { tabId: "t0" })),
        counted("t1", createElement(TabDot, { tabId: "t1" })),
      ),
    );
  });

  afterEach(() => root.unmount());

  it("re-renders only the rows and tabs whose rollup changed", () => {
    expect(commits).toEqual({ A: 1, B: 1, t0: 1, t1: 1 });

    setPaneStatus("a2", "working");
    expect(commits).toEqual({ A: 2, B: 1, t0: 1, t1: 2 });
    expect(root.container.textContent).toBe("working:true" + "none:true" + "none" + "working");
  });

  it("does not re-render when a change leaves the rollup as it was", () => {
    setPaneStatus("a2", "requires_input");
    const before = { ...commits };

    // A lower-priority status under a dot already showing requires_input.
    setPaneStatus("a1", "working");
    expect(commits.A).toBe(before.A);
    expect(commits.B).toBe(before.B);
    expect(commits.t1).toBe(before.t1);

    // Store changes the rollup cannot depend on.
    act(() => useAppStore.getState().setPaneTitle("a1", "Fix the build"));
    expect(commits).toEqual({ ...before, t0: before.t0 + 1 });
  });

  it("re-renders a row when its pulse changes", () => {
    act(() => useAgentStore.setState({ agents: [makeAgent({ id: "agent-b", paneId: "b1" })] }));
    setPaneStatus("b1", "responded");
    expect(root.container.textContent).toContain("responded:false");
    const before = commits.B;

    act(() => useAgentStore.setState({ unseenRespondedAgentIds: new Set(["agent-b"]) }));
    expect(commits.B).toBe(before + 1);
    expect(root.container.textContent).toContain("responded:true");
  });
});
