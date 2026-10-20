// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { makeAgent, makeProject } from "../../../test-utils/fixtures";
import type { TaskRow } from "../../../lib/tasks";
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

// The palette's task search reads the tracker queries; serve fixed rows.
const taskRows: TaskRow[] = [];
vi.mock("../../tasks/useTasks", () => ({
  useTasks: () => ({ rows: taskRows, loading: false, failedCount: 0, failures: [] }),
  useTrackerStatus: () => ({ providers: ["github"], checking: false }),
}));

const { CommandPalette } = await import("../CommandPalette");
const { useAgentCommands } = await import("../useAgentCommands");

const PANE = "pane-1";
const agent = makeAgent({ paneId: PANE });
const noop = () => {};

/** The palette with a query client, as the app root provides one. */
function withQueryClient(element: ReactElement): ReactElement {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    element,
  );
}

const paletteProps = {
  onClose: noop,
  onResumeAgent: noop,
  onViewAllAgents: noop,
  onNewAgent: noop,
  onRunCommand: noop,
};

function AgentLabels() {
  const { items } = useAgentCommands({
    onResumeAgent: noop,
    onViewAllAgents: noop,
    onClose: noop,
    onNewAgent: noop,
    scopeProjectIds: null,
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
      withQueryClient(
        createElement(CommandPalette, { ...paletteProps, open: false }),
      ),
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

describe("command palette task search", () => {
  let root: TestRoot;

  beforeEach(() => {
    const project = makeProject();
    taskRows.splice(0, taskRows.length, {
      key: "github:1",
      provider: "github",
      displayId: "#42",
      title: "Fix the flaky login test",
      url: "https://github.com/acme/app/issues/42",
      labels: [{ name: "bug" }],
      assignees: [],
      status: { label: "Open", tone: "open" },
      trackerProjects: [],
      createdAt: "",
      updatedAt: "2026-01-01T00:00:00Z",
      projectEntryKey: project.id,
      project,
      projectName: project.name,
      color: null,
      raw: { provider: "github", issue: {} as never },
    });
    Object.assign(window, {
      electronAPI: {
        linear: { isConnected: () => Promise.resolve(false) },
        github: {
          checkStatus: () =>
            Promise.resolve({ installed: false, authenticated: false }),
        },
      },
    });
    root = createTestRoot();
  });

  afterEach(() => {
    root.unmount();
    taskRows.length = 0;
  });

  function type(text: string) {
    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    if (!input) throw new Error("no palette input");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("lists matching tasks only once something is typed", () => {
    root.render(
      withQueryClient(
        createElement(CommandPalette, { ...paletteProps, open: true }),
      ),
    );
    expect(document.body.textContent).not.toContain("Fix the flaky login test");

    type("flaky");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Tasks");
    expect(text).toContain("#42");
    expect(text).toContain("Fix the flaky login test");
    expect(text).toContain("See all 1 matching task in Tasks view");
  });
});
