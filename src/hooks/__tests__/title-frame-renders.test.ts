// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useAgentDisplay } from "../useAgentDisplay";
import { useAgentCommands } from "../../components/command-palette/useAgentCommands";
import { PaneHeaderTitle } from "../../components/workspace-panes/PaneHeaderTitle";
import { TabTitle } from "../../components/tabbar/TabButton";
import { makeAgent } from "../../test-utils/fixtures";
import {
  createTestRoot,
  setPaneTitle,
  type TestRoot,
} from "../../test-utils/react-root";

const PANE = "pane-1";
const agent = makeAgent({ paneId: PANE });
const setTitle = (title: string) => setPaneTitle(PANE, title);

const commandArgs = {
  onResumeAgent: () => {},
  onViewAllAgents: () => {},
  onClose: () => {},
  onNewAgent: () => {},
  scopeProjectId: null,
};

let root: TestRoot;
let renders = 0;
let last: unknown;

/** Renders a component that calls `useProbe`, counting its renders. */
function mount(useProbe: () => unknown) {
  function Probe() {
    renders++;
    last = useProbe();
    return null;
  }
  root.render(createElement(Probe));
}

/** Renders `child` under a parent that counts its own renders. */
function mountUnderParent(child: ReactNode) {
  function Parent() {
    renders++;
    return child;
  }
  root.render(createElement(Parent));
}

beforeEach(() => {
  renders = 0;
  last = undefined;
  useAppStore.setState({
    paneTitle: { [PANE]: "⠂ Fix the build" },
    paneCwd: {},
    paneAgentStatus: {},
  });
  useAgentStore.setState({ agents: [agent] });
  root = createTestRoot();
});

afterEach(() => root.unmount());

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

  it("re-render only the pane header's title text", () => {
    mountUnderParent(createElement(PaneHeaderTitle, { paneId: PANE }));
    expect(root.container.textContent).toBe("⠂ Fix the build");

    setTitle("⠐ Fix the build");
    expect(root.container.textContent).toBe("⠐ Fix the build");
    expect(renders).toBe(1);

    setTitle("user@host:~/code");
    expect(root.container.textContent).toBe("~/code");
  });

  it("re-render only a tab's title text", () => {
    mountUnderParent(
      createElement(TabTitle, { focusedPaneId: PANE, isPinned: false }),
    );
    expect(root.container.textContent).toBe("⠂ Fix the build");

    setTitle("⠐ Fix the build");
    expect(root.container.textContent).toBe("⠐ Fix the build");
    expect(renders).toBe(1);

    setTitle("user@host:/home/me/code");
    expect(root.container.textContent).toBe("code");
  });

  it("do not re-render the open palette's agent commands", () => {
    mount(() =>
      useAgentCommands({ ...commandArgs, enabled: true }).items.map((i) => i.label),
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
    mount(() => useAgentCommands({ ...commandArgs, enabled: false }));
    setTitle("⠐ Something else entirely");
    act(() =>
      useAppStore.setState({
        paneAgentStatus: {
          [PANE]: { status: "working", reason: "", kind: "claude" },
        },
      }),
    );
    act(() => useAgentStore.setState({ agents: [{ ...agent, name: "Renamed" }] }));
    expect(renders).toBe(1);
  });
});
