// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { makeAgent } from "../../../test-utils/fixtures";
import {
  createTestRoot,
  renderCounted,
  setPaneTitle,
  type TestRoot,
} from "../../../test-utils/react-root";

// The ports scanner reaches main over IPC; the palette only lists its ports.
vi.mock("../../ports/usePortsData", () => ({
  usePortsData: () => ({ ports: [] }),
}));

const { CommandPalette } = await import("../CommandPalette");
const { useAgentCommands } = await import("../useAgentCommands");

const PANE = "pane-1";
const agent = makeAgent({ paneId: PANE });
const noop = () => {};

function AgentLabels() {
  const { items } = useAgentCommands({
    onResumeAgent: noop,
    onViewAllAgents: noop,
    onClose: noop,
    onNewAgent: noop,
    scopeProjectId: null,
    enabled: true,
  });
  return items.map((i) => i.label).join("|");
}

describe("command palette agent commands", () => {
  let root: TestRoot;

  beforeEach(() => {
    useAppStore.setState({ paneTitle: { [PANE]: "⠂ Fix the build" }, paneAgentStatus: {} });
    useAgentStore.setState({ agents: [agent] });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("ignore spinner frames of the same title while open", () => {
    const list = renderCounted(root, createElement(AgentLabels));
    setPaneTitle(PANE, "⠐ Fix the build");
    expect(list.commits).toBe(1);
    expect(root.container.textContent).toContain("Fix the build");

    setPaneTitle(PANE, "⠐ Ship it");
    expect(list.commits).toBe(2);
    expect(root.container.textContent).toContain("Ship it");
  });

  it("do no work in a closed palette when agent titles, statuses or agents change", () => {
    const palette = renderCounted(
      root,
      createElement(CommandPalette, {
        open: false,
        onClose: noop,
        onResumeAgent: noop,
        onViewAllAgents: noop,
        onNewAgent: noop,
        onRunCommand: noop,
      }),
    );
    // Mounting can take more than one commit; count only what follows.
    const mounted = palette.commits;
    setPaneTitle(PANE, "⠐ Something else entirely");
    act(() =>
      useAppStore.setState({
        paneAgentStatus: {
          [PANE]: { status: "working", reason: "", kind: "claude" },
        },
      }),
    );
    act(() => useAgentStore.setState({ agents: [{ ...agent, name: "Renamed" }] }));
    expect(palette.commits).toBe(mounted);
  });
});
