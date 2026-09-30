// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useAgentDisplay } from "../useAgentDisplay";
import { usePaneHeaderTitle } from "../usePaneHeaderTitle";
import { useAgentCommands } from "../../components/command-palette/useAgentCommands";
import type { AgentInfo } from "../../electron.d";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANE = "pane-1";

const agent: AgentInfo = {
  id: "agent-1",
  agentSessionId: "session-1",
  name: null,
  status: "active",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  completedAt: null,
  activatedAt: null,
  projectId: "p1",
  projectName: "Project",
  hostId: "local",
  workspacePath: "/ws",
  cwd: "/ws",
  agentKind: "claude",
  agentCommand: null,
  paneId: PANE,
  lastAgentStatus: null,
  resumedAt: null,
};

const setTitle = (title: string) =>
  act(() => useAppStore.getState().setPaneTitle(PANE, title));

let root: Root;
let renders = 0;
let last: unknown;

function mount(useProbe: () => unknown) {
  function Probe() {
    renders++;
    last = useProbe();
    return null;
  }
  act(() => root.render(createElement(Probe)));
}

beforeEach(() => {
  renders = 0;
  last = undefined;
  useAppStore.setState({ paneTitle: { [PANE]: "⠂ Fix the build" }, paneAgentStatus: {} });
  useAgentStore.setState({ agents: [agent] });
  root = createRoot(document.createElement("div"));
});

afterEach(() => act(() => root.unmount()));

describe("spinner-frame title updates", () => {
  it("do not re-render an agents list row", () => {
    mount(() => useAgentDisplay(agent).title);
    setTitle("⠐ Fix the build");
    setTitle("⠠ Fix the build");
    expect(renders).toBe(1);
    expect(last).toBe("Fix the build");

    setTitle("⠂ Run the tests");
    expect(renders).toBe(2);
    expect(last).toBe("Run the tests");
  });

  it("do not re-render the pane header", () => {
    mount(() => usePaneHeaderTitle(PANE));
    setTitle("⠐ Fix the build");
    expect(renders).toBe(1);
    expect(last).toBe("Fix the build");

    setTitle("user@host:~/code");
    expect(last).toBe("~/code");
  });

  it("do not re-render the open palette's agent commands", () => {
    mount(() =>
      useAgentCommands({
        onResumeAgent: () => {},
        onViewAllAgents: () => {},
        onClose: () => {},
        onNewAgent: () => {},
        scopeProjectId: null,
        enabled: true,
      }).items.map((i) => i.label),
    );
    setTitle("⠐ Fix the build");
    expect(renders).toBe(1);
    expect(last).toContain("Fix the build");

    setTitle("⠐ Ship it");
    expect(renders).toBe(2);
    expect(last).toContain("Ship it");
  });
});

describe("closed command palette", () => {
  it("does no work when agent titles, statuses or agents change", () => {
    mount(() =>
      useAgentCommands({
        onResumeAgent: () => {},
        onViewAllAgents: () => {},
        onClose: () => {},
        onNewAgent: () => {},
        scopeProjectId: null,
        enabled: false,
      }),
    );
    setTitle("⠐ Something else entirely");
    act(() =>
      useAppStore.setState({
        paneAgentStatus: { [PANE]: { status: "working" } as never },
      }),
    );
    act(() => useAgentStore.setState({ agents: [{ ...agent, name: "Renamed" }] }));
    expect(renders).toBe(1);
  });
});
