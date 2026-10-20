// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";
import { createTestRoot, type TestRoot } from "../../test-utils/react-root";

const orphanedAgentContexts = vi.fn(() => new Map());
vi.mock("../../lib/agent-context-repair", () => ({ orphanedAgentContexts }));

const { useAgentContextRepair } = await import("../useAgentContextRepair");

function Probe() {
  useAgentContextRepair();
  return null;
}

describe("useAgentContextRepair", () => {
  let root: TestRoot;

  beforeEach(() => {
    root = createTestRoot();
    root.render(createElement(Probe));
    orphanedAgentContexts.mockClear();
  });

  afterEach(() => root.unmount());

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
