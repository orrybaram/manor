// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type WorkspaceLayout } from "../../../store/app-store";
import { workspaceKey, type WorkspaceKey } from "../../../lib/workspace-key";

// Count renders of each workspace's panel tree without mounting terminals.
const renders: Record<string, number> = {};
vi.mock("../PanelLayout", () => ({
  PanelLayout: (props: { workspaceKey: WorkspaceKey }) => {
    renders[props.workspaceKey] = (renders[props.workspaceKey] ?? 0) + 1;
    return null;
  },
}));

const { WorkspaceStack } = await import("../WorkspaceStack");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = workspaceKey("local", "/ws/a");
const B = workspaceKey("local", "/ws/b");
const C = workspaceKey("local", "/ws/c");
const D = workspaceKey("local", "/ws/d");
const onNewAgent = () => {};

function layout(panelId: string): WorkspaceLayout {
  const paneId = `${panelId}-pane`;
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs: [{ id: `${panelId}-tab`, title: "T", rootNode: { type: "leaf", paneId } }],
        pinnedTabIds: [],
      },
    },
  };
}

function patchLayout(key: WorkspaceKey, change: Partial<WorkspaceLayout>) {
  act(() =>
    useAppStore.setState((s) => ({
      workspaceLayouts: {
        ...s.workspaceLayouts,
        [key]: { ...s.workspaceLayouts[key], ...change },
      },
    })),
  );
}

describe("WorkspaceStack render isolation", () => {
  let root: Root;
  const render = (visibleKey: WorkspaceKey | null) =>
    act(() => root.render(createElement(WorkspaceStack, { visibleKey, onNewAgent })));

  beforeEach(() => {
    for (const k of Object.keys(renders)) delete renders[k];
    useAppStore.setState({
      workspaceLayouts: { [A]: layout("pa"), [B]: layout("pb"), [C]: layout("pc") },
    });
    root = createRoot(document.createElement("div"));
    render(A);
  });

  afterEach(() => act(() => root.unmount()));

  it("re-renders only the workspace whose panel tree changed", () => {
    expect(renders).toEqual({ [A]: 1, [B]: 1, [C]: 1 });
    patchLayout(A, { panelTree: { type: "leaf", panelId: "pa2" } });
    expect(renders).toEqual({ [A]: 2, [B]: 1, [C]: 1 });
  });

  it("re-renders no tree for a change inside a workspace's panels", () => {
    patchLayout(B, {
      panels: {
        pb: { id: "pb", tabs: [], pinnedTabIds: ["pinned-elsewhere"] },
      },
    });
    expect(renders).toEqual({ [A]: 1, [B]: 1, [C]: 1 });
  });

  // App re-renders for many unrelated reasons; the stack must absorb them.
  it("re-renders no tree when its parent re-renders with the same props", () => {
    render(A);
    expect(renders).toEqual({ [A]: 1, [B]: 1, [C]: 1 });
  });

  it("re-renders only the two workspaces whose visibility flipped", () => {
    render(B);
    expect(renders).toEqual({ [A]: 2, [B]: 2, [C]: 1 });
  });

  it("mounts a new workspace without re-rendering the others", () => {
    act(() =>
      useAppStore.setState((s) => ({
        workspaceLayouts: { ...s.workspaceLayouts, [D]: layout("pd") },
      })),
    );
    expect(renders).toEqual({ [A]: 1, [B]: 1, [C]: 1, [D]: 1 });
  });
});
