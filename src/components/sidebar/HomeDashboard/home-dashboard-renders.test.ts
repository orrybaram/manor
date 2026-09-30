// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import type { NeedsYouCard } from "../../../lib/home-dashboard-studio";
import type { AgentInfo } from "../../../electron.d";

// Render the dashboard without its sections: the header counts the
// dashboard's renders, the cards mock records what it derived.
let renders = 0;
let lastCards: NeedsYouCard[] = [];
vi.mock("./DashboardHeader", () => ({
  DashboardHeader: () => {
    renders++;
    return null;
  },
}));
vi.mock("./NeedsYouCards", () => ({
  NeedsYouCards: (props: { cards: NeedsYouCard[] }) => {
    lastCards = props.cards;
    return null;
  },
}));
for (const [path, name] of [
  ["./ActivityTimeline", "ActivityTimeline"],
  ["./HostAlert", "HostAlert"],
  ["./PrPipeline", "PrPipeline"],
  ["./ProjectTiles", "ProjectTiles"],
  ["./StatTiles", "StatTiles"],
  ["./UpNextPanel", "UpNextPanel"],
]) {
  vi.doMock(path, () => ({ [name]: () => null }));
}
vi.mock("./useDashboardAnimate", () => ({ useDashboardAnimate: () => null }));

const { HomeDashboard } = await import("./HomeDashboard");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANE = "pane-1";

const project = {
  id: "p1",
  name: "Project One",
  path: "/repo/p1",
  workspaces: [],
  hostId: "local",
} as unknown as ProjectInfo;

const agent = {
  id: "agent-1",
  status: "active",
  updatedAt: "2026-09-30T00:00:00Z",
  projectId: "p1",
  projectName: "Project One",
  hostId: "local",
  workspacePath: "/repo/p1",
  paneId: PANE,
} as unknown as AgentInfo;

const setTitle = (title: string) =>
  act(() => useAppStore.getState().setPaneTitle(PANE, title));

describe("HomeDashboard", () => {
  let root: Root;

  beforeEach(() => {
    renders = 0;
    useProjectStore.setState({ projects: [project] });
    useAgentStore.setState({ agents: [agent], unseenRespondedAgentIds: new Set() });
    useAppStore.setState({
      paneTitle: { [PANE]: "⠂ Fix the build" },
      paneAgentStatus: { [PANE]: { status: "error", reason: "", kind: "claude" } },
    });
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(HomeDashboard)));
  });

  afterEach(() => act(() => root.unmount()));

  it("shows an errored agent's cleaned title", () => {
    expect(lastCards.map((c) => c.context)).toEqual([
      { kind: "error", paneTitle: "Fix the build" },
    ]);
  });

  it("does not re-render for a spinner frame of the same title", () => {
    setTitle("⠐ Fix the build");
    setTitle("⠠ Fix the build");
    expect(renders).toBe(1);

    setTitle("⠂ Run the tests");
    expect(renders).toBe(2);
    expect(lastCards[0].context).toEqual({ kind: "error", paneTitle: "Run the tests" });
  });
});
