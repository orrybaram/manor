// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { useProjectStore } from "../../../store/project-store";
import type { NeedsYouCard } from "../../../lib/home-dashboard-studio";
import { makeAgent, makeProject } from "../../../test-utils/fixtures";
import {
  createTestRoot,
  setPaneTitle,
  type TestRoot,
} from "../../../test-utils/react-root";

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

const PANE = "pane-1";
const project = makeProject();
const agent = makeAgent({ paneId: PANE });
const setTitle = (title: string) => setPaneTitle(PANE, title);

describe("HomeDashboard", () => {
  let root: TestRoot;

  beforeEach(() => {
    renders = 0;
    useProjectStore.setState({ projects: [project] });
    useAgentStore.setState({ agents: [agent], unseenRespondedAgentIds: new Set() });
    useAppStore.setState({
      paneTitle: { [PANE]: "⠂ Fix the build" },
      paneAgentStatus: { [PANE]: { status: "error", reason: "", kind: "claude" } },
    });
    root = createTestRoot();
    root.render(createElement(HomeDashboard));
  });

  afterEach(() => root.unmount());

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
