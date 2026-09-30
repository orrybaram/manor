// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";

const orphanedAgentContexts = vi.fn(() => new Map());
vi.mock("../../lib/agent-context-repair", () => ({ orphanedAgentContexts }));

const { useAgentContextRepair } = await import("../useAgentContextRepair");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useAgentContextRepair();
  return null;
}

describe("useAgentContextRepair", () => {
  let root: Root;

  beforeEach(() => {
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    orphanedAgentContexts.mockClear();
  });

  afterEach(() => act(() => root.unmount()));

  it("does not run on unrelated store changes", () => {
    useAppStore.getState().setPaneTitle("pane-1", "⠂ Working");
    useAppStore.setState({ paneAgentStatus: {} });
    useAgentStore.setState({ unseenRespondedAgentIds: new Set() });
    useProjectStore.setState({ selectedProjectIndex: 3 });
    expect(orphanedAgentContexts).not.toHaveBeenCalled();
  });

  it("runs when agents, layouts or projects change", () => {
    useAgentStore.setState({ agents: [] });
    useAppStore.setState({ workspaceLayouts: {} });
    useProjectStore.setState({ projects: [] });
    expect(orphanedAgentContexts).toHaveBeenCalledTimes(3);
  });
});
