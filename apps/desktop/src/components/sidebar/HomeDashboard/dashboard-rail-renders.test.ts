// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsSummary } from "../../../electron.d";
import { useAgentActivityStore } from "../../../store/agent-activity-store";
import { useAgentStore } from "../../../store/agent-store";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { useStatsStore } from "../../../store/stats-store";
import type { OpenPrStats } from "../../../lib/home-dashboard-studio";
import { makeAgent, makeProject } from "../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../test-utils/react-root";

// Up next reads the task trackers; it has nothing to show here.
vi.mock("./RailUpNext", () => ({ RailUpNext: () => null }));
vi.mock("./useDashboardAnimate", () => ({ useDashboardAnimate: () => null }));

const { DashboardRail } = await import("./DashboardRail");

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MIN = 60_000;
const NO_PRS: OpenPrStats = {
  total: 0,
  oldestAgeMs: null,
  byStage: { checks: 0, review: 0, blocked: 0, ready: 0 },
};

const summary = (overrides: Partial<StatsSummary>) =>
  ({
    dailyPrsMerged: [
      { day: "2026-11-19", count: 1 },
      { day: "2026-11-20", count: 0 },
      { day: "2026-11-21", count: 2 },
      { day: "2026-11-22", count: 0 },
      { day: "2026-11-23", count: 0 },
      { day: "2026-11-24", count: 3 },
      { day: "2026-11-25", count: 1 },
    ],
    enabled: true,
    ...overrides,
  }) as StatsSummary;

describe("DashboardRail", () => {
  let root: TestRoot;

  const render = (prStats: OpenPrStats = NO_PRS) =>
    root.render(createElement(DashboardRail, { now: NOW, prStats }));
  const section = (name: string) =>
    root.container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;

  beforeEach(() => {
    useProjectStore.setState({ projects: [makeProject()] });
    useAgentStore.setState({ agents: [] });
    useAppStore.setState({ paneTitle: {}, paneAgentStatus: {} });
    useAgentActivityStore.setState({ snapshot: null });
    useStatsStore.setState({ summary: null });
    root = createTestRoot();
  });

  afterEach(() => root.unmount());

  it("shows the four sections under one landmark", () => {
    render();
    const rail = root.container.querySelector('aside[aria-label="Activity and stats"]');
    expect(rail).not.toBeNull();
    expect(section("Agents working")).not.toBeNull();
    expect(section("Open PRs")).not.toBeNull();
    expect(section("Merged this week")).not.toBeNull();
  });

  it("claims nothing about merges until the stats summary arrives", () => {
    render();
    expect(section("Merged this week").textContent).toBe("Merged this week");
  });

  it("says usage stats are off when they are", () => {
    useStatsStore.setState({ summary: summary({ enabled: false }) });
    render();
    expect(section("Merged this week").textContent).toContain("Usage stats are off");
  });

  it("totals the week and draws a bar per day", () => {
    useStatsStore.setState({ summary: summary({}) });
    render();
    const merged = section("Merged this week");
    expect(merged.textContent).toContain("7");
    expect(merged.querySelectorAll('[role="img"] i')).toHaveLength(7);
    expect(merged.textContent).toContain("today");
  });

  it("shows the open PR count, oldest age and a legend per stage", () => {
    render({
      total: 4,
      oldestAgeMs: 3 * 24 * 60 * MIN,
      byStage: { checks: 1, review: 2, blocked: 1, ready: 0 },
    });
    const prs = section("Open PRs");
    expect(prs.textContent).toContain("4");
    expect(prs.textContent).toContain("oldest 3d");
    expect(prs.textContent).toContain("2 Review");
  });

  it("lists running agents with how long they've been at it, and their lanes", () => {
    const agent = makeAgent({ id: "a1", paneId: "pane-1", name: "Port the loader" });
    useAgentStore.setState({ agents: [agent] });
    useAppStore.setState({
      paneAgentStatus: { "pane-1": { status: "working", reason: "", kind: "claude" } },
    });
    useAgentActivityStore.setState({
      snapshot: {
        agents: {
          a1: {
            meta: { name: "Port the loader", projectId: null, workspacePath: null, hostId: "local" },
            transitions: [
              { status: "idle", at: NOW - 60 * MIN },
              { status: "thinking", at: NOW - 12 * MIN },
              { status: "working", at: NOW - 5 * MIN },
            ],
          },
        },
        sessions: [{ start: NOW - 4 * 60 * MIN, end: NOW }],
        now: NOW,
      },
    });
    render();
    const agents = section("Agents working");
    const row = agents.querySelector('button[aria-label="Open Port the loader"]');
    expect(row?.textContent).toContain("12m");
    expect(agents.querySelectorAll('[role="group"] [title^="Working"]')).toHaveLength(1);
  });

  it("says when no agent has been active", () => {
    render();
    expect(section("Agents working").textContent).toContain("No agent activity in the last 3 hours.");
  });
});
