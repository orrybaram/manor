// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShallow } from "zustand/react/shallow";
import {
  useAppStore,
  selectWorkspaceKeys,
  type WorkspaceLayout as Layout,
} from "../../../store/app-store";
import { workspaceKey, type WorkspaceKey } from "../../../lib/workspace-key";
import { createTestRoot, type TestRoot } from "../../../test-utils/react-root";

// Count renders of each workspace's panel tree without mounting terminals.
const renders: Record<string, number> = {};
vi.mock("../PanelLayout", () => ({
  PanelLayout: (props: { workspaceKey: WorkspaceKey }) => {
    renders[props.workspaceKey] = (renders[props.workspaceKey] ?? 0) + 1;
    return null;
  },
}));

const { WorkspaceLayout } = await import("../WorkspaceLayout");

const A = workspaceKey("local", "/ws/a");
const B = workspaceKey("local", "/ws/b");
const onNewAgent = () => {};

function layout(panelId: string): Layout {
  const paneId = `${panelId}-pane`;
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs: [{ id: `${panelId}-tab`, title: "T", rootNode: { type: "leaf", paneId }, focusedPaneId: paneId }],
        selectedTabId: `${panelId}-tab`,
        pinnedTabIds: [],
      },
    },
    activePanelId: panelId,
  };
}

// Same subscription as App: only the keys, each workspace selects its own tree.
function Stack() {
  const keys = useAppStore(useShallow(selectWorkspaceKeys));
  return keys.map((key) =>
    createElement(WorkspaceLayout, { key, workspaceKey: key, visible: key === A, onNewAgent }),
  );
}

describe("WorkspaceLayout render isolation", () => {
  let root: TestRoot;

  beforeEach(() => {
    for (const k of Object.keys(renders)) delete renders[k];
    useAppStore.setState({ workspaceLayouts: { [A]: layout("pa"), [B]: layout("pb") } });
    root = createTestRoot();
    root.render(createElement(Stack));
  });

  afterEach(() => root.unmount());

  it("re-renders only the workspace whose panel tree changed", () => {
    expect(renders).toEqual({ [A]: 1, [B]: 1 });
    act(() =>
      useAppStore.setState((s) => ({
        workspaceLayouts: {
          ...s.workspaceLayouts,
          [A]: { ...s.workspaceLayouts[A], panelTree: { type: "leaf", panelId: "pa2" } },
        },
      })),
    );
    expect(renders).toEqual({ [A]: 2, [B]: 1 });
  });

  it("does not re-render any tree for a change inside a workspace's panels", () => {
    act(() =>
      useAppStore.setState((s) => ({
        workspaceLayouts: {
          ...s.workspaceLayouts,
          [B]: { ...s.workspaceLayouts[B], activePanelId: "other" },
        },
      })),
    );
    expect(renders).toEqual({ [A]: 1, [B]: 1 });
  });
});
